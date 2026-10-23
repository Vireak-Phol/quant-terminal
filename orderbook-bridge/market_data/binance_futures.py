"""
Binance USDⓈ-M Futures Market Data Provider implementation.
Handles:
- Official REST queries (exchangeInfo, depth snapshot, klines, premiumIndex).
- Multi-stream WebSocket (depth@100ms, aggTrade, kline_1m, markPrice@1s).
- Full OrderBook synchronization lifecycle with automatic gap recovery.
- Resilient reconnection with exponential backoff and jitter.
"""

import asyncio
from decimal import Decimal
import json
import logging
import os
import random
import time
from typing import Callable, Dict, List, Optional, Awaitable, Any
import urllib.request
import urllib.parse
import websockets

from .base import (
    MarketDataProvider,
    MarketType,
    ConnectionState,
    OrderBookSyncState,
    InstrumentMetadata,
    TradeEvent,
    DepthLevel,
    DepthUpdateEvent,
    OrderBookSnapshot,
    KlineEvent,
)
from .order_book import LocalOrderBook, SequenceGapError

logger = logging.getLogger("BinanceFuturesProvider")


class BinanceFuturesProvider(MarketDataProvider):
    REST_BASE_URL = "https://fapi.binance.com"
    # Routed entry points (Binance WebSocket base-URL split). The legacy un-routed
    # "/stream" only serves /public data (depth); trades/kline/mark/liquidations are /market.
    WS_PUBLIC_URL = "wss://fstream.binance.com/public/stream"
    WS_MARKET_URL = "wss://fstream.binance.com/market/stream"

    def __init__(self, symbol: str = "XAUUSDT"):
        self.symbol = symbol.upper()
        self.market_type = MarketType.USD_M_FUTURES
        self.metadata: Optional[InstrumentMetadata] = None
        self.order_book = LocalOrderBook(symbol=self.symbol)

        self._connection_state = ConnectionState.DISCONNECTED
        self._trade_callbacks: List[Callable[[TradeEvent], Awaitable[None]]] = []
        self._depth_callbacks: List[Callable[[LocalOrderBook], Awaitable[None]]] = []

        self._running = False
        self._ws_task: Optional[asyncio.Task] = None
        self._oi_task: Optional[asyncio.Task] = None
        self._resync_lock = asyncio.Lock()

        # Liquidation (@forceOrder) callbacks — forced-order prints for the
        # BubbleRegimeEngine. Payload: dict(side, price, qty, timestamp_ms).
        self._liquidation_callbacks: List[Callable[[Dict[str, Any]], Awaitable[None]]] = []

        # Telemetry
        self.reconnect_count = 0
        self.total_messages = 0
        self.last_exchange_time = 0
        self.last_receive_time = 0
        self.mark_price: float = 0.0
        self.funding_rate: float = 0.0
        # Open Interest (contracts) polled from REST /fapi/v1/openInterest.
        self.open_interest: float = 0.0
        self._oi_poll_sec: float = float(os.environ.get("OI_POLL_SEC", "15"))

    def get_connection_state(self) -> ConnectionState:
        return self._connection_state

    def register_trade_callback(self, callback: Callable[[TradeEvent], Awaitable[None]]):
        self._trade_callbacks.append(callback)

    def register_depth_callback(self, callback: Callable[[LocalOrderBook], Awaitable[None]]):
        self._depth_callbacks.append(callback)

    def register_liquidation_callback(self, callback: Callable[[Dict[str, Any]], Awaitable[None]]):
        """Register a callback invoked for every @forceOrder (liquidation) print."""
        self._liquidation_callbacks.append(callback)

    async def get_instrument_metadata(self, symbol: str) -> InstrumentMetadata:
        """Fetch and validate instrument metadata from fapi exchangeInfo."""
        loop = asyncio.get_running_loop()
        url = f"{self.REST_BASE_URL}/fapi/v1/exchangeInfo"

        def _fetch():
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (MarketMicrostructure/1.0)"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode("utf-8"))

        data = await loop.run_in_executor(None, _fetch)
        matches = [s for s in data.get("symbols", []) if s.get("symbol") == symbol]
        if not matches:
            raise ValueError(f"Instrument '{symbol}' not found on Binance USDⓈ-M Futures!")

        s = matches[0]
        if s.get("status") != "TRADING":
            raise RuntimeError(f"Instrument '{symbol}' is not currently active! Status: {s.get('status')}")

        tick_size = Decimal("0.01")
        step_size = Decimal("0.001")
        min_qty = Decimal("0.001")
        min_notional = Decimal("5.0")

        for f in s.get("filters", []):
            ft = f.get("filterType")
            if ft == "PRICE_FILTER":
                tick_size = Decimal(f.get("tickSize", "0.01"))
            elif ft == "LOT_SIZE":
                step_size = Decimal(f.get("stepSize", "0.001"))
                min_qty = Decimal(f.get("minQty", "0.001"))
            elif ft == "MIN_NOTIONAL":
                min_notional = Decimal(f.get("notional", "5.0"))

        meta = InstrumentMetadata(
            symbol=s["symbol"],
            pair=s["pair"],
            market_type=self.market_type,
            contract_type=s.get("contractType", "TRADIFI_PERPETUAL"),
            status=s["status"],
            base_asset=s["baseAsset"],
            quote_asset=s["quoteAsset"],
            margin_asset=s["marginAsset"],
            price_precision=int(s["pricePrecision"]),
            quantity_precision=int(s["quantityPrecision"]),
            tick_size=tick_size,
            step_size=step_size,
            min_qty=min_qty,
            min_notional=min_notional,
        )
        self.metadata = meta
        logger.info(
            f"Validated {meta.symbol} on {meta.market_type.value}: "
            f"Contract={meta.contract_type}, TickSize={meta.tick_size}, StepSize={meta.step_size}"
        )
        return meta

    async def fetch_snapshot(self, symbol: str, limit: int = 1000) -> OrderBookSnapshot:
        """Fetch REST depth snapshot."""
        loop = asyncio.get_running_loop()
        url = f"{self.REST_BASE_URL}/fapi/v1/depth?symbol={symbol}&limit={limit}"

        def _fetch():
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (MarketMicrostructure/1.0)"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                return json.loads(resp.read().decode("utf-8"))

        data = await loop.run_in_executor(None, _fetch)
        bids = [DepthLevel(price=Decimal(p), quantity=Decimal(q)) for p, q in data.get("bids", [])]
        asks = [DepthLevel(price=Decimal(p), quantity=Decimal(q)) for p, q in data.get("asks", [])]

        return OrderBookSnapshot(
            symbol=symbol,
            last_update_id=int(data["lastUpdateId"]),
            exchange_timestamp=int(data.get("E", int(time.time() * 1000))),
            bids=bids,
            asks=asks,
        )

    async def fetch_klines(self, symbol: str, interval: str, limit: int = 200) -> List[KlineEvent]:
        """Fetch historical klines via REST."""
        loop = asyncio.get_running_loop()
        url = f"{self.REST_BASE_URL}/fapi/v1/klines?symbol={symbol}&interval={interval}&limit={limit}"

        def _fetch():
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (MarketMicrostructure/1.0)"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                return json.loads(resp.read().decode("utf-8"))

        data = await loop.run_in_executor(None, _fetch)
        events = []
        for item in data:
            events.append(
                KlineEvent(
                    symbol=symbol,
                    interval=interval,
                    start_time=int(item[0]),
                    close_time=int(item[6]),
                    open_price=Decimal(item[1]),
                    high_price=Decimal(item[2]),
                    low_price=Decimal(item[3]),
                    close_price=Decimal(item[4]),
                    volume=Decimal(item[5]),
                    is_closed=True,
                )
            )
        return events

    async def _resynchronize_order_book(self):
        """Asynchronously fetches snapshot and reconciles buffered updates."""
        async with self._resync_lock:
            self._connection_state = ConnectionState.SYNCHRONIZING
            self.order_book.reset()
            # Allow buffer to collect depth events while snapshot travels over wire
            await asyncio.sleep(0.15)
            try:
                snapshot = await self.fetch_snapshot(self.symbol, limit=1000)
                self.order_book.reconcile_snapshot(snapshot)
                self._connection_state = ConnectionState.CONNECTED
            except Exception as e:
                logger.error(f"[{self.symbol}] OrderBook resync failed: {e}")
                self._connection_state = ConnectionState.ERROR

    def _parse_depth_event(self, data: Dict[str, Any]) -> DepthUpdateEvent:
        now_ms = int(time.time() * 1000)
        bids = [DepthLevel(price=Decimal(p), quantity=Decimal(q)) for p, q in data.get("b", [])]
        asks = [DepthLevel(price=Decimal(p), quantity=Decimal(q)) for p, q in data.get("a", [])]

        return DepthUpdateEvent(
            symbol=data.get("s", self.symbol),
            market_type=self.market_type,
            first_update_id=int(data.get("U", 0)),
            final_update_id=int(data.get("u", 0)),
            prev_final_update_id=int(data["pu"]) if "pu" in data and data["pu"] is not None else None,
            exchange_timestamp=int(data.get("E", now_ms)),
            received_timestamp=now_ms,
            bids=bids,
            asks=asks,
        )

    def _parse_trade_event(self, data: Dict[str, Any]) -> TradeEvent:
        now_ms = int(time.time() * 1000)
        is_buyer_maker = bool(data.get("m", False))
        # If buyer is maker, aggressive taker was a seller -> "sell"
        aggressor = "sell" if is_buyer_maker else "buy"

        return TradeEvent(
            symbol=data.get("s", self.symbol),
            market_type=self.market_type,
            trade_id=int(data.get("a", data.get("t", 0))),
            price=Decimal(str(data.get("p", "0"))),
            quantity=Decimal(str(data.get("q", "0"))),
            aggressor_side=aggressor,
            exchange_timestamp=int(data.get("T", now_ms)),
            received_timestamp=now_ms,
            is_buyer_maker=is_buyer_maker,
        )

    def _parse_liquidation_event(self, data: Dict[str, Any], now_ms: int) -> Optional[Dict[str, Any]]:
        """Parse a Binance @forceOrder (liquidation) print into a normalised dict.

        The ``o`` object carries the forced order. ``S`` is the order side of the
        forced order ("BUY"/"SELL"); the aggressor side of a forced liquidation
        equals that side (a forced BUY lifts asks, a forced SELL hits bids).
        """
        o = data.get("o") or {}
        side_raw = str(o.get("S", "")).upper()
        if side_raw not in ("BUY", "SELL"):
            return None
        try:
            price = float(o.get("ap") or o.get("p") or 0.0)  # avg fill price preferred
            qty = float(o.get("q") or 0.0)
        except (TypeError, ValueError):
            return None
        if qty <= 0:
            return None
        return {
            "side": "buy" if side_raw == "BUY" else "sell",
            "price": price,
            "qty": qty,
            "timestamp_ms": int(o.get("T") or data.get("E") or now_ms),
        }

    async def _poll_open_interest_loop(self):
        """Periodically poll REST open interest so the BubbleRegimeEngine can
        classify OI-rising (absorption opening) vs OI-falling (liquidation flush)."""
        loop = asyncio.get_running_loop()
        url = f"{self.REST_BASE_URL}/fapi/v1/openInterest?symbol={self.symbol}"

        def _fetch():
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (MarketMicrostructure/1.0)"})
            with urllib.request.urlopen(req, timeout=4) as resp:
                return json.loads(resp.read().decode("utf-8"))

        while self._running:
            try:
                data = await loop.run_in_executor(None, _fetch)
                if not self._running:
                    break
                oi = data.get("openInterest")
                if oi is not None:
                    self.open_interest = float(oi)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug(f"[{self.symbol}] open interest poll failed: {e}")
            try:
                await asyncio.sleep(self._oi_poll_sec)
            except asyncio.CancelledError:
                break

    async def _stream_loop(self):
        """Run the two routed Binance connections concurrently.

        Binance split the USDⓈ-M stream host into routed entry points: depth lives on
        ``/public`` while aggTrade / kline / markPrice / forceOrder live on ``/market``.
        The legacy un-routed ``/stream`` URL now only delivers ``/public`` data, which
        silently starved every trade-driven feature (trade candles, delta, CVD, bubbles,
        absorption, liquidations). Each route gets its own resilient loop.
        """
        s = self.symbol.lower()
        await asyncio.gather(
            self._route_loop(self.WS_PUBLIC_URL, [f"{s}@depth@100ms"], is_book=True),
            self._route_loop(
                self.WS_MARKET_URL,
                [f"{s}@aggTrade", f"{s}@kline_1m", f"{s}@markPrice@1s", f"{s}@forceOrder"],
                is_book=False,
            ),
        )

    async def _route_loop(self, base_url: str, streams: List[str], is_book: bool):
        """Resilient WebSocket loop for one route with exponential backoff & jitter."""
        ws_url = f"{base_url}?streams={'/'.join(streams)}"
        backoff_sec = 1.0

        while self._running:
            try:
                if is_book:
                    self._connection_state = ConnectionState.CONNECTING
                logger.info(f"Connecting to Binance USDⓈ-M Futures stream: {ws_url}")

                async with websockets.connect(
                    ws_url,
                    ping_interval=20,
                    ping_timeout=15,
                    max_size=10 * 1024 * 1024,
                ) as ws:
                    backoff_sec = 1.0
                    if is_book:
                        logger.info("Connected to Binance Futures depth! Initiating order book synchronization...")
                        self.reconnect_count += 1
                        # Trigger snapshot resync task concurrently
                        asyncio.create_task(self._resynchronize_order_book())
                    else:
                        logger.info("Connected to Binance Futures market streams (aggTrade/kline/markPrice/forceOrder).")

                    while self._running:
                        msg = await ws.recv()
                        now_ms = int(time.time() * 1000)
                        self.total_messages += 1
                        self.last_receive_time = now_ms

                        payload = json.loads(msg)
                        stream_name = payload.get("stream", "")
                        data = payload.get("data", {})

                        if "depth" in stream_name:
                            event = self._parse_depth_event(data)
                            self.last_exchange_time = event.exchange_timestamp
                            try:
                                self.order_book.apply_update(event)
                                for cb in self._depth_callbacks:
                                    await cb(self.order_book)
                            except SequenceGapError:
                                logger.warning("Sequence gap detected during live stream! Triggering resync...")
                                asyncio.create_task(self._resynchronize_order_book())

                        elif "aggTrade" in stream_name:
                            trade = self._parse_trade_event(data)
                            self.last_exchange_time = trade.exchange_timestamp
                            for cb in self._trade_callbacks:
                                await cb(trade)

                        elif "markPrice" in stream_name:
                            self.mark_price = float(data.get("p", 0.0))
                            self.funding_rate = float(data.get("r", 0.0))

                        elif "forceOrder" in stream_name:
                            liq = self._parse_liquidation_event(data, now_ms)
                            if liq is not None:
                                for cb in self._liquidation_callbacks:
                                    await cb(liq)

            except asyncio.CancelledError:
                break
            except Exception as e:
                if is_book:
                    self._connection_state = ConnectionState.RECONNECTING
                logger.warning(f"WebSocket error ({base_url}): {e}. Backing off {backoff_sec:.1f}s...")
                await asyncio.sleep(backoff_sec + random.uniform(0.1, 0.5))
                backoff_sec = min(backoff_sec * 2.0, 30.0)

    async def start(self):
        if self._running:
            return
        self._running = True
        await self.get_instrument_metadata(self.symbol)
        self._ws_task = asyncio.create_task(self._stream_loop())
        self._oi_task = asyncio.create_task(self._poll_open_interest_loop())

    async def stop(self):
        self._running = False
        if self._ws_task:
            self._ws_task.cancel()
            try:
                await self._ws_task
            except asyncio.CancelledError:
                pass
        if self._oi_task:
            self._oi_task.cancel()
            try:
                await self._oi_task
            except asyncio.CancelledError:
                pass
        self._connection_state = ConnectionState.DISCONNECTED
        logger.info("Binance Futures Provider stopped.")
