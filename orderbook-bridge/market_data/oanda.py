"""
OANDA v20 market-data provider (XAU_USD spot CFD).

What OANDA does and does NOT give us — this drives the bridge capability gating:

* Streaming *quotes* (``/v3/accounts/{id}/pricing/stream``): bid/ask with a few
  liquidity tiers. These tiers are OANDA's own price ladder for its clients, NOT a
  market-wide limit order book, so they must never be painted as resting liquidity.
* Candles (``/v3/instruments/{inst}/candles``): OHLC + *tick volume* (number of quote
  changes), no traded volume and no aggressor split.
* No trade tape, no liquidations, no open interest, no funding.

The provider therefore emits:
* a quote-only ``LocalOrderBook`` (``replace_levels``) so mid / spread / DOM work;
* *synthetic* tick-rule trades (one per mid change, qty = 1 tick, side = sign of the
  mid change, zero-ticks inherit the previous side). They drive tick-volume candles,
  a tick-rule delta *estimate*, VWAP-Z and SMPI. The bridge does NOT feed them to the
  absorption / bubble-regime engines, which need real aggressor size.

Only stdlib networking is used (urllib + a reader thread for the chunked stream), so
no new dependency is introduced. The API token is never logged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from .base import (
    ConnectionState,
    InstrumentMetadata,
    KlineEvent,
    MarketDataProvider,
    MarketType,
    OrderBookSnapshot,
    TradeEvent,
)
from .order_book import LocalOrderBook

logger = logging.getLogger("OandaProvider")

REST_HOSTS = {
    "practice": "https://api-fxpractice.oanda.com",
    "live": "https://api-fxtrade.oanda.com",
}
STREAM_HOSTS = {
    "practice": "https://stream-fxpractice.oanda.com",
    "live": "https://stream-fxtrade.oanda.com",
}

# Engine timeframe -> OANDA granularity.
GRANULARITY = {
    "1m": "M1", "3m": None, "5m": "M5", "15m": "M15", "30m": "M30",
    "1h": "H1", "2h": "H2", "4h": "H4", "1d": "D",
}
MAX_CANDLES_PER_REQUEST = 5000  # OANDA hard limit
_TF_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400}


@dataclass(frozen=True)
class OandaConfig:
    token: str
    account_id: str
    env: str = "practice"  # practice | live

    @property
    def rest_base(self) -> str:
        return REST_HOSTS.get(self.env, REST_HOSTS["practice"])

    @property
    def stream_base(self) -> str:
        return STREAM_HOSTS.get(self.env, STREAM_HOSTS["practice"])

    def headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            # Epoch-seconds timestamps ("1700000000.123456789") — no RFC3339 parsing.
            "Accept-Datetime-Format": "UNIX",
            "User-Agent": "institution-terminal/1.0",
        }

    def __repr__(self) -> str:  # never leak the token into logs / tracebacks
        return f"OandaConfig(account_id={self.account_id!r}, env={self.env!r}, token=***)"


# ── parsing helpers (pure; unit-tested) ────────────────────────────────────────

def parse_time_ms(value: Any) -> int:
    """OANDA time -> epoch ms. Accepts UNIX ("1700000000.123456789") or RFC3339
    with nanoseconds ("2026-10-24T03:43:37.254123456Z")."""
    if value is None:
        return int(time.time() * 1000)
    s = str(value).strip()
    try:
        return int(Decimal(s) * 1000)
    except InvalidOperation:
        pass
    from datetime import datetime, timezone
    if s.endswith("Z"):
        s = s[:-1]
    frac = ""
    if "." in s:
        s, frac = s.split(".", 1)
    dt = datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    ms = int(dt.timestamp()) * 1000
    if frac:
        ms += int((frac + "000")[:3])
    return ms


def parse_candles(payload: Dict[str, Any], include_incomplete: bool = False) -> List[Dict[str, float]]:
    """``/candles`` JSON -> [{t (sec), o, h, l, c, v (tick volume), complete}]."""
    out: List[Dict[str, float]] = []
    for c in payload.get("candles", []) or []:
        complete = bool(c.get("complete", False))
        if not complete and not include_incomplete:
            continue
        px = c.get("mid") or c.get("bid") or c.get("ask")
        if not px:
            continue
        try:
            out.append({
                "t": parse_time_ms(c.get("time")) // 1000,
                "o": float(px["o"]),
                "h": float(px["h"]),
                "l": float(px["l"]),
                "c": float(px["c"]),
                "v": float(c.get("volume", 0) or 0),
                "complete": complete,
            })
        except (KeyError, TypeError, ValueError):
            continue
    out.sort(key=lambda r: r["t"])
    return out


def parse_price_message(
    msg: Dict[str, Any],
) -> Optional[Tuple[int, List[Tuple[Decimal, Decimal]], List[Tuple[Decimal, Decimal]], bool]]:
    """Pricing-stream line -> (ts_ms, bids[(px, liquidity)], asks, tradeable).

    Returns None for heartbeats / malformed lines.
    """
    if msg.get("type") != "PRICE":
        return None

    def _levels(raw) -> List[Tuple[Decimal, Decimal]]:
        lv: List[Tuple[Decimal, Decimal]] = []
        for x in raw or []:
            try:
                p = Decimal(str(x["price"]))
                q = Decimal(str(x.get("liquidity", 0)))
            except (KeyError, InvalidOperation, TypeError):
                continue
            if p > 0:
                lv.append((p, q))
        return lv

    bids = _levels(msg.get("bids"))
    asks = _levels(msg.get("asks"))
    if not bids or not asks:
        return None
    tradeable = bool(msg.get("tradeable", True))
    return parse_time_ms(msg.get("time")), bids, asks, tradeable


class TickRuleClassifier:
    """Lee-Ready style tick rule on the quote mid.

    up-tick -> "buy", down-tick -> "sell", zero-tick -> previous side (no emission).
    The *first* observation only seeds the reference and never emits.
    """

    def __init__(self) -> None:
        self.last_mid: Optional[Decimal] = None
        self.last_side: Optional[str] = None

    def classify(self, mid: Decimal) -> Optional[str]:
        prev = self.last_mid
        self.last_mid = mid
        if prev is None or mid == prev:
            return None
        self.last_side = "buy" if mid > prev else "sell"
        return self.last_side


# ── REST ───────────────────────────────────────────────────────────────────────

def _http_json(url: str, cfg: OandaConfig, timeout: float = 10.0) -> Dict[str, Any]:
    req = urllib.request.Request(url, headers=cfg.headers())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # Surface OANDA's errorMessage (never the request headers).
        try:
            detail = json.loads(e.read().decode("utf-8")).get("errorMessage", "")
        except Exception:
            detail = ""
        raise RuntimeError(f"OANDA HTTP {e.code}: {detail or e.reason}") from None


def fetch_candles(
    cfg: OandaConfig,
    instrument: str,
    interval: str,
    count: Optional[int] = None,
    from_sec: Optional[int] = None,
    include_incomplete: bool = False,
) -> List[Dict[str, float]]:
    """One candles request. Daily alignment is pinned to 00:00 UTC so H4 bars open
    at 00/04/08… UTC — the same grid as Binance and the v7.4 HTF filter."""
    gran = GRANULARITY.get(interval)
    if not gran:
        raise ValueError(f"OANDA has no granularity for {interval}")
    params: Dict[str, Any] = {
        "granularity": gran,
        "price": "M",
        "dailyAlignment": 0,
        "alignmentTimezone": "UTC",
    }
    if from_sec is not None:
        params["from"] = str(int(from_sec))
        params["count"] = min(count or MAX_CANDLES_PER_REQUEST, MAX_CANDLES_PER_REQUEST)
    else:
        params["count"] = min(count or 500, MAX_CANDLES_PER_REQUEST)
    url = f"{cfg.rest_base}/v3/instruments/{urllib.parse.quote(instrument)}/candles?{urllib.parse.urlencode(params)}"
    return parse_candles(_http_json(url, cfg), include_incomplete=include_incomplete)


def fetch_instrument(cfg: OandaConfig, instrument: str) -> Dict[str, Any]:
    url = f"{cfg.rest_base}/v3/accounts/{urllib.parse.quote(cfg.account_id)}/instruments?instruments={urllib.parse.quote(instrument)}"
    data = _http_json(url, cfg)
    for ins in data.get("instruments", []):
        if ins.get("name") == instrument:
            return ins
    raise ValueError(f"Instrument {instrument} not available on OANDA account")


# ── streaming provider ─────────────────────────────────────────────────────────

class OandaProvider(MarketDataProvider):
    """Drop-in for ``BinanceFuturesProvider`` as far as bridge.py is concerned."""

    STALE_AFTER_SEC = 20.0  # OANDA heartbeats every 5 s; 20 s of silence => reconnect

    def __init__(self, cfg: OandaConfig, symbol: str = "XAU_USD"):
        self.cfg = cfg
        self.symbol = symbol
        self.market_type = MarketType.SPOT
        self.metadata: Optional[InstrumentMetadata] = None
        self.order_book = LocalOrderBook(symbol=symbol)

        self._connection_state = ConnectionState.DISCONNECTED
        self._trade_callbacks: List[Callable[[TradeEvent], Awaitable[None]]] = []
        self._depth_callbacks: List[Callable[[LocalOrderBook], Awaitable[None]]] = []
        self._running = False
        self._reader: Optional[threading.Thread] = None
        self._consumer: Optional[asyncio.Task] = None
        self._queue: Optional[asyncio.Queue] = None
        self._resp = None
        self._tick_rule = TickRuleClassifier()
        self._synthetic_id = 0

        # Interface parity with the Binance provider (bridge reads these).
        self.reconnect_count = 0
        self.total_messages = 0
        self.last_exchange_time = 0
        self.last_receive_time = 0
        self.mark_price: float = 0.0
        self.funding_rate: float = 0.0
        self.open_interest: float = 0.0
        self.tradeable: bool = False

    # interface ---------------------------------------------------------------
    def get_connection_state(self) -> ConnectionState:
        return self._connection_state

    def register_trade_callback(self, callback):
        self._trade_callbacks.append(callback)

    def register_depth_callback(self, callback):
        self._depth_callbacks.append(callback)

    def register_liquidation_callback(self, callback):
        """OANDA publishes no liquidations; accepted for interface parity."""

    async def get_instrument_metadata(self, symbol: str) -> InstrumentMetadata:
        loop = asyncio.get_running_loop()
        ins = await loop.run_in_executor(None, fetch_instrument, self.cfg, symbol)
        prec = int(ins.get("displayPrecision", 3))
        tick = Decimal(1).scaleb(-prec)
        units_prec = int(ins.get("tradeUnitsPrecision", 0))
        step = Decimal(1).scaleb(-units_prec)
        base, _, quote = symbol.partition("_")
        meta = InstrumentMetadata(
            symbol=symbol, pair=symbol, market_type=self.market_type, contract_type=str(ins.get("type", "CFD")),
            status="TRADING", base_asset=base, quote_asset=quote, margin_asset=quote,
            price_precision=prec, quantity_precision=units_prec, tick_size=tick, step_size=step,
            min_qty=Decimal(str(ins.get("minimumTradeSize", step))), min_notional=Decimal("0"),
        )
        self.metadata = meta
        logger.info(f"Validated {symbol} on OANDA {self.cfg.env}: type={meta.contract_type}, tick={tick}")
        return meta

    async def fetch_snapshot(self, symbol: str, limit: int = 1000) -> OrderBookSnapshot:
        raise NotImplementedError("OANDA has no L2 depth snapshot; quotes arrive via the pricing stream")

    async def fetch_klines(self, symbol: str, interval: str, limit: int = 200) -> List[KlineEvent]:
        loop = asyncio.get_running_loop()
        rows = await loop.run_in_executor(None, lambda: fetch_candles(self.cfg, symbol, interval, count=limit))
        step = _TF_SECONDS.get(interval, 60)
        return [KlineEvent(symbol=symbol, interval=interval, start_time=int(r["t"]) * 1000,
                           close_time=int(r["t"]) * 1000 + step * 1000 - 1,
                           open_price=Decimal(str(r["o"])), high_price=Decimal(str(r["h"])),
                           low_price=Decimal(str(r["l"])), close_price=Decimal(str(r["c"])),
                           volume=Decimal(str(r["v"])), is_closed=bool(r["complete"])) for r in rows]

    # lifecycle ---------------------------------------------------------------
    async def start(self):
        if self._running:
            return
        self._running = True
        try:
            await self.get_instrument_metadata(self.symbol)
        except Exception as e:  # metadata is informational; keep streaming
            logger.warning(f"OANDA instrument metadata unavailable: {e}")
        loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=5000)
        self._reader = threading.Thread(target=self._reader_loop, args=(loop,), name="oanda-stream", daemon=True)
        self._reader.start()
        self._consumer = asyncio.create_task(self._consume())

    async def stop(self):
        self._running = False
        resp = self._resp
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
        if self._consumer:
            self._consumer.cancel()
            try:
                await self._consumer
            except asyncio.CancelledError:
                pass
        self._connection_state = ConnectionState.DISCONNECTED
        logger.info("OANDA provider stopped.")

    # stream ------------------------------------------------------------------
    def _reader_loop(self, loop: asyncio.AbstractEventLoop):
        """Blocking chunked-HTTP reader (own thread). Lines are handed to the loop."""
        params = urllib.parse.urlencode({"instruments": self.symbol, "snapshot": "true"})
        url = f"{self.cfg.stream_base}/v3/accounts/{urllib.parse.quote(self.cfg.account_id)}/pricing/stream?{params}"
        backoff = 1.0
        while self._running:
            self._connection_state = ConnectionState.CONNECTING
            try:
                req = urllib.request.Request(url, headers=self.cfg.headers())
                with urllib.request.urlopen(req, timeout=self.STALE_AFTER_SEC) as resp:
                    self._resp = resp
                    self.reconnect_count += 1
                    self._connection_state = ConnectionState.CONNECTED
                    logger.info(f"Connected to OANDA {self.cfg.env} pricing stream for {self.symbol}")
                    backoff = 1.0
                    for raw in resp:  # socket timeout => no heartbeat for STALE_AFTER_SEC
                        if not self._running:
                            break
                        line = raw.strip()
                        if line:
                            loop.call_soon_threadsafe(self._enqueue, line)
            except urllib.error.HTTPError as e:
                self._connection_state = ConnectionState.ERROR
                logger.error(f"OANDA stream HTTP {e.code} ({e.reason}); check OANDA_API_TOKEN / OANDA_ACCOUNT_ID / OANDA_ENV")
                if e.code in (401, 403):
                    backoff = 30.0  # bad credentials: do not hammer the API
            except Exception as e:
                if self._running:
                    self._connection_state = ConnectionState.RECONNECTING
                    logger.warning(f"OANDA stream error: {e}. Reconnecting in {backoff:.1f}s")
            finally:
                self._resp = None
            if self._running:
                time.sleep(backoff + random.uniform(0.1, 0.5))
                backoff = min(backoff * 2.0, 30.0)

    def _enqueue(self, line: bytes):
        q = self._queue
        if q is None:
            return
        if q.full():  # consumer stalled: drop the oldest quote, keep the newest
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(line)

    async def _consume(self):
        assert self._queue is not None
        while self._running:
            line = await self._queue.get()
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            await self.handle_message(msg)

    async def handle_message(self, msg: Dict[str, Any]) -> None:
        """Apply one pricing-stream message (public for tests / replay)."""
        now_ms = int(time.time() * 1000)
        self.total_messages += 1
        self.last_receive_time = now_ms
        parsed = parse_price_message(msg)
        if parsed is None:
            return
        ts_ms, bids, asks, tradeable = parsed
        self.tradeable = tradeable
        self.last_exchange_time = ts_ms
        self.order_book.replace_levels(bids, asks, exchange_timestamp=ts_ms)
        mid_dec, _ = self.order_book.get_mid_and_spread()
        if mid_dec is None:
            return
        self.mark_price = float(mid_dec)
        for cb in self._depth_callbacks:
            await cb(self.order_book)

        side = self._tick_rule.classify(mid_dec)
        if side is None or not self._trade_callbacks:
            return
        self._synthetic_id += 1
        trade = TradeEvent(
            symbol=self.symbol, market_type=self.market_type, trade_id=self._synthetic_id,
            price=mid_dec, quantity=Decimal("1"), aggressor_side=side,
            exchange_timestamp=ts_ms, received_timestamp=now_ms, is_buyer_maker=(side == "sell"),
        )
        for cb in self._trade_callbacks:
            await cb(trade)
