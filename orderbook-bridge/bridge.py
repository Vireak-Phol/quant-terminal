#!/usr/bin/env python3
"""
Institutional Market Microstructure Terminal Bridge
----------------------------------------------------
Primary Instrument: Binance USDⓈ-M Futures XAUUSDT (TRADIFI_PERPETUAL)
Alternate venue:    OANDA v20 XAU_USD (quote-only; see market_data/oanda.py)
Select with MARKET_PROVIDER=binance|oanda, data/config.json "provider", or the UI
switcher (WS action "set_provider", which persists the choice and re-execs).
Capabilities:
1. Sequence-synchronized L2 Order Book with REST snapshot recovery & gap detection.
2. Resting Liquidity Zone overlay engine with multi-threshold clustering & lifecycle tracking.
3. Absorption bubble candidate engine with volatility-normalized volume vs. price response.
4. v7.4 engine (engine/): OSC-VIP + REG v7.4 port, empirical ledger calibration, risk plans.
5. Event recording & replay engine.
6. Broadcasts structured JSON frames on ws://127.0.0.1:8765 (BRIDGE_HOST / BRIDGE_PORT).
   Features whose source data a venue lacks (L2 depth, real tape, OI, liquidations)
   are disabled and advertised in frame["venue"]["capabilities"].
"""

import asyncio
import faulthandler
import signal
from collections import deque
from decimal import Decimal
import json
import logging
import math
import os
import re
import sys
import time
from typing import Set, Dict, List, Optional, Any
import websockets
from websockets.asyncio.server import serve

# Ensure bridge directory is in sys.path regardless of execution CWD
_BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
if _BRIDGE_DIR not in sys.path:
    sys.path.insert(0, _BRIDGE_DIR)

from market_data.base import ConnectionState, OrderBookSyncState, TradeEvent
from market_data.order_book import LocalOrderBook
from market_data.binance_futures import BinanceFuturesProvider
from market_data.oanda import OandaProvider
from analytics.liquidity_zones import LiquidityZoneDetector, LiquidityZone
from analytics.absorption_engine import AbsorptionEngine, AbsorptionCandidate
from analytics.vacuum_engine import VacuumEngine, Candle
from analytics.trade_candles import TradeCandleAggregator
from analytics.vwap_z import VwapZEngine
from analytics.pressure_index import PressureIndexEngine
from analytics.bubble_regime_engine import BubbleRegimeEngine, Liquidation
from engine.sessions import session_flags as _v74_session_flags
from replay.replay_engine import MarketRecorder, ReplayPlayer
from engine.live import LiveHub
from engine.ledger import Ledger
from engine.orderflow import OrderflowSnapshot
from engine.alerts import AlertDispatcher
from engine.data import fetch_chart_candles
from engine.venue import (
    VENUES,
    active_venue,
    oanda_config,
    providers_view,
    save_provider_name,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s"
)
logger = logging.getLogger("TerminalBridge")
# `kill -USR1 <pid>` dumps all thread stacks to stderr (diagnose stalls without stopping the bridge).
if hasattr(signal, "SIGUSR1"):
    faulthandler.register(signal.SIGUSR1, all_threads=True)


def safe_json_dumps(obj: Any, default=None) -> str:
    """Serialize to STRICTLY-VALID JSON for the WS feed.

    Python's ``json.dumps`` defaults to ``allow_nan=True``, which emits the bare
    tokens ``Infinity`` / ``-Infinity`` / ``NaN``. Those are valid JavaScript but
    NOT valid JSON, so the browser's ``JSON.parse`` throws
    ("Unexpected token 'I', ...\"_factor\": Infinity ... is not valid JSON") and
    the client drops the *entire* frame — freezing the terminal whenever any
    engine ratio divides by zero.

    The v7.4 engine frame is a deep ~70 KB structure where any ratio can go
    non-finite, so we sanitize at the serialization boundary rather than chasing
    every producer: non-finite floats become ``null`` (which the UI already
    treats as "no value"). ``allow_nan=False`` would instead raise and drop the
    frame, so we pre-clean with a default hook and keep the feed flowing.
    """
    def _clean(x: Any) -> Any:
        if isinstance(x, float):
            return x if math.isfinite(x) else None
        if isinstance(x, dict):
            return {k: _clean(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)):
            return [_clean(v) for v in x]
        return x

    return json.dumps(_clean(obj), default=default)

PORT = int(os.environ.get("BRIDGE_PORT", "8765"))
# Loopback by default: the socket accepts control commands (risk config, provider
# switch, recording) and has no authentication. Set BRIDGE_HOST=0.0.0.0 only on a
# trusted network. "localhost" binds both 127.0.0.1 and ::1.
HOST = os.environ.get("BRIDGE_HOST", "localhost")
# Browser Origin allowlist (defends against cross-site WebSocket hijacking: any web
# page can open ws://localhost). Non-browser clients send no Origin and are allowed.
ALLOWED_ORIGINS: List[Any] = [
    None,
    re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"),
    *[o.strip() for o in os.environ.get("BRIDGE_ALLOWED_ORIGINS", "").split(",") if o.strip()],
]

# ── Venue / provider selection ───────────────────────────────────────────────
# MARKET_PROVIDER env > data/config.json "provider" > binance. OANDA without
# credentials falls back to Binance so a stale config can never brick the bridge.
VENUE = active_venue()
_OANDA_CFG = oanda_config() if VENUE.name == "oanda" else None
if VENUE.name == "oanda" and _OANDA_CFG is None:
    logger.error("MARKET_PROVIDER=oanda but OANDA_API_TOKEN / OANDA_ACCOUNT_ID are not set; falling back to Binance")
    VENUE = VENUES["binance"]
SYMBOL = VENUE.symbol
CAPS: Dict[str, Any] = dict(VENUE.capabilities)

# Dense heatmap depth-column geometry. Must stay in lockstep with the frontend
# TerminalChart grid (PRICE_ROWS rows at tickSize each) so each emitted bin maps
# directly onto one heatmap row without client-side resampling.
HEATMAP_PRICE_ROWS = 240       # == PRICE_ROWS in TerminalChart.ts
HEATMAP_BIN_SIZE = 0.5         # == ChartConfig.tickSize in App.tsx

# Connected frontend clients
CLIENTS: Set = set()

# Core engines
if VENUE.name == "oanda":
    provider = OandaProvider(_OANDA_CFG, symbol=SYMBOL)
else:
    provider = BinanceFuturesProvider(symbol=SYMBOL)
zone_detector = LiquidityZoneDetector(
    symbol=SYMBOL,
    min_absolute_qty=15.0,
    min_notional_usd=50_000.0,
    min_relative_multiple=2.0,
    tick_tolerance=0.05,
)
absorption_engine = AbsorptionEngine(
    symbol=SYMBOL,
    window_duration_ms=4000,
    min_confidence=0.50,
)
# Liquidity Vacuum engine (Pine v7.4 port). Candle-based: fed CLOSED bars built
# from the live mid-price stream. Default bar size = 60s to match a 1m chart.
VACUUM_BAR_MS = int(os.environ.get("VACUUM_BAR_MS", "60000"))
vacuum_engine = VacuumEngine()


class _CandleAggregator:
    """Builds fixed-interval OHLC candles from a mid-price stream and emits a
    callback with each CLOSED bar (so the vacuum engine only sees confirmed data)."""

    def __init__(self, interval_ms: int):
        self.interval_ms = interval_ms
        self._bucket: Optional[int] = None
        self._o = self._h = self._l = self._c = 0.0

    def ingest(self, price: float, ts_ms: int):
        bucket = (ts_ms // self.interval_ms) * self.interval_ms
        if self._bucket is None:
            self._bucket = bucket
            self._o = self._h = self._l = self._c = price
            return None
        if bucket != self._bucket:
            closed = Candle(t=self._bucket, o=self._o, h=self._h, l=self._l, c=self._c)
            self._bucket = bucket
            self._o = self._h = self._l = self._c = price
            return closed
        # same bucket -> update current forming bar
        self._h = max(self._h, price)
        self._l = min(self._l, price)
        self._c = price
        return None


candle_agg = _CandleAggregator(VACUUM_BAR_MS)
# Trade-price candle aggregator for OHLCV + delta + CVD (audit R1)
trade_candle_agg = TradeCandleAggregator(interval_ms=60_000)
# OSC v7.4 microstructure overlays, now driven by REAL transacted trade candles
# (true volume + aggressor-tagged CVD) rather than the Pine lower-TF range proxy.
# Both advance ONCE per CLOSED 1m trade candle, so they never repaint.
vwap_z_engine = VwapZEngine()          # session-anchored VWAP + Cornish-Fisher dev-Z + bands
pressure_engine = PressureIndexEngine()  # SMPI: signed pressure from CVD slope Z + absorption
# Bubble Regime engine: OI + liquidation classifier for aggressive sweeps.
# Fed by the live aggTrade stream, @forceOrder liquidations, and REST open interest.
bubble_engine = BubbleRegimeEngine()
recorder = MarketRecorder(output_dir="data/recordings")
replay_player = ReplayPlayer()
alerts = AlertDispatcher.from_env()


def _orderflow_snapshot() -> Optional[OrderflowSnapshot]:
    """Live L2 evidence captured at bar close for the v7.4 engine."""
    if terminal_state["mid_price"] <= 0:
        return None
    return OrderflowSnapshot(
        mid=terminal_state["mid_price"],
        imbalance=terminal_state["imbalance"],
        walls=list(terminal_state["resting_walls"]),
        absorptions=list(terminal_state["absorption_candidates"]),
        spread=terminal_state["spread"],
        timestamp_ms=int(time.time() * 1000),
    )


hub = LiveHub(
    symbol=SYMBOL,
    ledger=Ledger(VENUE.ledger_path),
    snapshot_fn=_orderflow_snapshot,
    on_signal=alerts.on_signal,
    risk_section=VENUE.risk_section,
    risk_defaults=VENUE.risk_defaults,
)
_v74_cache: Dict[str, Any] = {"version": -1, "at": 0.0, "frame": None}
_gex_cache: Dict[str, Any] = {"at": 0.0, "levels": None}


def get_live_gex(mid_price: float) -> Dict:
    now = time.time()
    if _gex_cache["levels"] is None or (now - _gex_cache["at"]) > 180.0:
        try:
            from engine.gamma import get_gamma_engine
            g_eng = get_gamma_engine()
            _gex_cache["levels"] = g_eng.compute_gamma_levels(mid_price or 4000.0)
            _gex_cache["at"] = now
        except Exception as e:
            logger.warning(f"GEX computation error: {e}")
            if not _gex_cache["levels"]:
                _gex_cache["levels"] = {
                    "call_wall": None,
                    "put_wall": None,
                    "gamma_flip": None,
                    "net_gex_label": None,
                    "regime": "NEUTRAL",
                }
    return _gex_cache["levels"]


def refresh_v74_frame() -> bool:
    """Rebuild the v7.4 frame when the engine changed (bar close) or every 5 s (guardrails).

    Returns True when the frame changed. The frame (~70 KB) is only broadcast on change;
    other depth frames omit the key and the UI keeps its last copy.
    """
    now = time.time()
    changed = False
    if hub.version != _v74_cache["version"] or now - _v74_cache["at"] > 5.0:
        try:
            frame = hub.frame(terminal_state["mid_price"] or None)
            if frame is not None:  # None = engine busy; keep the previous frame
                _v74_cache["frame"] = frame
                _v74_cache["version"] = hub.version
                _v74_cache["at"] = now
                changed = True
        except Exception as e:  # never let the UI frame break the depth feed
            logger.error(f"v74 frame error: {e}")
            _v74_cache["at"] = now
    terminal_state["v74"] = _v74_cache["frame"]
    return changed

# Rolling display buffers
PRICE_HISTORY = deque(maxlen=250)  # (time_ms, mid_price, best_bid, best_ask)
RECENT_TRADES = deque(maxlen=80)   # (time_ms, price, size, side)
RECENT_ABSORPTIONS: List[AbsorptionCandidate] = []
CURRENT_ZONES: List[LiquidityZone] = []

# Unified Terminal State Frame
terminal_state: Dict[str, Any] = {
    "type": "bookmap_update",
    "symbol": SYMBOL,
    "market_type": "usd_m_futures" if VENUE.name == "binance" else "spot_cfd",
    "provider": VENUE.label,
    "contract_type": "TRADIFI_PERPETUAL" if VENUE.name == "binance" else "CFD",
    # Active venue + data capabilities; the UI gates layers on these flags.
    "venue": VENUE.to_dict(),
    "timestamp": int(time.time() * 1000),
    "mid_price": 0.0,
    "spread": 0.0,
    "best_bid": 0.0,
    "best_ask": 0.0,
    "bids": [],
    "asks": [],
    "imbalance": 0.0,
    "imbalance_score": 50,
    "top5_bid_vol": 0.0,
    "top5_ask_vol": 0.0,
    "bid_total_vol": 0.0,
    "ask_total_vol": 0.0,
    "resting_walls": [],
    "liquidity_zones": [],
    # Dense per-bin resting depth for the live heatmap column (Bookmap gradient).
    # priceMin/binSize let the client map bins[i] -> price priceMin + i*binSize.
    "heatmap_column": None,  # {"priceMin": float, "binSize": float, "bins": [float,...]}
    "absorption_candidates": [],
    "recent_trades": [],
    "price_history": [],
    "mark_price": 0.0,
    "funding_rate": 0.0,
    "v6_flow_signal": "BALANCED",
    "vacuum_zones": [],
    "vacuum_magnet": {},
    "v74": None,
    # --- Audit R1: trade-price candles + CVD ---
    "trade_candle": None,  # current forming TradeCandle (closed=False)
    "cvd": 0.0,            # session-anchored cumulative volume delta (oz)
    # --- OSC v7.4 microstructure overlays (real-data port; update on closed 1m bar) ---
    "vwap_z": {},          # VWAP + Cornish-Fisher deviation Z-score + fat-tail bands
    "pressure_index": {},  # SMPI signed pressure from true CVD slope Z + absorption
    # --- Bubble Regime engine: OI + liquidation classified sweeps ---
    "open_interest": 0.0,  # latest REST open interest (contracts)
    "oi_delta": 0.0,       # open_interest change between last two readings
    "bubbles": [],         # recent classified BubbleSignal dicts (ring buffer)
    "bubblesRev": 0,       # monotonic emit counter (UI sweep-feed change-detect)
    # --- Audit R3: session/killzone + key levels + sweep events ---
    "session": {
        "london": False,
        "ny_am": False,
        "asia": False,
        "london_fix": False,
        "name": "OFF",
    },
    "key_levels": {
        "pdh": None,
        "pdl": None,
        "pwh": None,
        "pwl": None,
        "globex_open": None,
        "call_wall": None,
        "put_wall": None,
        "gamma_flip": None,
        "net_gex": None,
        "gex_regime": None,
    },
    "sweep_events": [],  # recent liq_sweep StructureEvent from v74
    "telemetry": {
        "connection_state": "connecting",
        "order_book_sync_state": "uninitialized",
        "last_exchange_time": 0,
        "last_receive_time": 0,
        "latency_ms": 0,
        "reconnect_count": 0,
        "sequence_gaps_count": 0,
        "total_updates_processed": 0,
        "active_clients": 0,
        "is_replaying": False,
        "is_recording": False,
    },
    "status": "CONNECTING",
}


async def on_depth_update(book: LocalOrderBook):
    """Callback when LocalOrderBook receives and reconciles depth."""
    global CURRENT_ZONES
    now_ms = int(time.time() * 1000)

    best_bid, best_ask = book.get_best_bid_ask()
    if best_bid is None or best_ask is None:
        return

    mid_price_dec, spread_dec = book.get_mid_and_spread()
    mid_price = float(mid_price_dec)
    spread = float(spread_dec)
    best_bid_f = float(best_bid)
    best_ask_f = float(best_ask)

    # 1. Update rolling price trajectory
    PRICE_HISTORY.append({
        "t": now_ms,
        "p": mid_price,
        "bid": best_bid_f,
        "ask": best_ask_f,
    })

    # 1b. Build candles from the mid-price stream; feed CLOSED bars to the vacuum engine.
    closed_bar = candle_agg.ingest(mid_price, now_ms)
    if closed_bar is not None:
        vacuum_engine.update(closed_bar)
        vac = vacuum_engine.to_dict()
        terminal_state["vacuum_zones"] = vac["vacuum_zones"]
        terminal_state["vacuum_magnet"] = vac["vacuum_magnet"]

    # 2. Extract top sorted levels & Order Flow Imbalance
    top_bids, top_asks = book.get_top_levels(limit=25)
    imbalance, imbalance_score = book.get_imbalance(depth=5)

    # 3. Detect resting liquidity zones. Quote-only venues (OANDA) have no market
    #    depth — their bid/ask tiers are the dealer's own ladder — so painting them as
    #    resting liquidity would be fabricated evidence. Zones stay empty there.
    if CAPS.get("l2_depth"):
        CURRENT_ZONES = zone_detector.update(book.bids, book.asks, now_ms=now_ms)
    else:
        CURRENT_ZONES = []

    # 4. Extract resting walls (for backward-compatible DOM & lines)
    resting_walls = []
    for z in CURRENT_ZONES:
        if z.status in ("active", "replenished") and z.multiple_of_mean >= 2.0:
            resting_walls.append({
                "side": z.side,
                "price": round(z.center_price, 2),
                "size": round(z.displayed_quantity, 3),
                "multiple": round(z.multiple_of_mean, 1),
            })
    resting_walls.sort(key=lambda x: x["size"], reverse=True)

    # Flow signal classification
    if imbalance >= 0.20:
        flow_signal = "BULLISH_PRESSURE"
    elif imbalance <= -0.20:
        flow_signal = "BEARISH_PRESSURE"
    else:
        flow_signal = "BALANCED"

    top5_bid_vol = sum(b["size"] for b in top_bids[:5])
    top5_ask_vol = sum(a["size"] for a in top_asks[:5])
    bid_total_vol = sum(b["size"] for b in top_bids)
    ask_total_vol = sum(a["size"] for a in top_asks)

    # Update state frame
    terminal_state["timestamp"] = now_ms
    terminal_state["mid_price"] = mid_price
    terminal_state["spread"] = spread
    terminal_state["best_bid"] = best_bid_f
    terminal_state["best_ask"] = best_ask_f
    terminal_state["bids"] = top_bids
    terminal_state["asks"] = top_asks
    terminal_state["top5_bid_vol"] = round(top5_bid_vol, 3)
    terminal_state["top5_ask_vol"] = round(top5_ask_vol, 3)
    terminal_state["bid_total_vol"] = round(bid_total_vol, 3)
    terminal_state["ask_total_vol"] = round(ask_total_vol, 3)
    terminal_state["imbalance"] = imbalance
    terminal_state["imbalance_score"] = imbalance_score
    terminal_state["resting_walls"] = resting_walls
    terminal_state["liquidity_zones"] = [z.to_dict() for z in CURRENT_ZONES]
    # Dense depth column centred on mid, aligned to the frontend heatmap grid.
    price_min = (
        round((mid_price - (HEATMAP_PRICE_ROWS / 2.0) * HEATMAP_BIN_SIZE) / HEATMAP_BIN_SIZE)
        * HEATMAP_BIN_SIZE
    )
    price_max = price_min + HEATMAP_PRICE_ROWS * HEATMAP_BIN_SIZE
    depth_bins = (
        book.get_binned_depth_column(price_min, price_max, HEATMAP_BIN_SIZE)
        if CAPS.get("l2_depth")
        else []
    )
    if depth_bins:
        terminal_state["heatmap_column"] = {
            "priceMin": round(price_min, 2),
            "binSize": HEATMAP_BIN_SIZE,
            "bins": [round(v, 3) for v in depth_bins],
        }
    else:
        terminal_state["heatmap_column"] = None
    terminal_state["price_history"] = list(PRICE_HISTORY)
    terminal_state["v6_flow_signal"] = flow_signal
    terminal_state["mark_price"] = provider.mark_price
    terminal_state["funding_rate"] = provider.funding_rate
    terminal_state["status"] = "LIVE_FEED"

    # --- Audit R3: session/killzone + key levels + sweep events ---
    now_sec = int(now_ms / 1000)
    sess = _v74_session_flags(now_sec)
    terminal_state["session"] = {
        "london": sess.london,
        "ny_am": sess.ny_am,
        "asia": sess.asia,
        "london_fix": sess.london_fix,
        "name": sess.name,
    }

    # Extract key levels, Globex open, GEX, and recent sweep events from the v74 frame
    mid = terminal_state["mid_price"] or 4000.0
    gex_data = get_live_gex(mid)
    v74_frame = _v74_cache.get("frame")
    kl: Dict[str, Any] = {}
    if v74_frame:
        # Key levels come from the first ready timeframe in frames
        for tf_name, tf_frame in (v74_frame.get("frames") or {}).items():
            struct = tf_frame.get("structure") if tf_frame else None
            if struct:
                kl = struct.get("key_levels") or {}
                # Sweep events: keep the last 20 for the chart overlay
                events = struct.get("events") or []
                sweeps = [e for e in events if e.get("kind") == "liq_sweep"]
                terminal_state["sweep_events"] = sweeps[-20:]
                break  # use the first ready timeframe

    terminal_state["key_levels"] = {
        "pdh": kl.get("pdh"),
        "pdl": kl.get("pdl"),
        "pwh": kl.get("pwh"),
        "pwl": kl.get("pwl"),
        "globex_open": kl.get("globex_open"),
        "call_wall": gex_data.get("call_wall"),
        "put_wall": gex_data.get("put_wall"),
        "gamma_flip": gex_data.get("gamma_flip"),
        "net_gex": gex_data.get("net_gex_label"),
        "gex_regime": gex_data.get("regime"),
    }

    # Telemetry
    last_ex = book.last_exchange_time or now_ms
    terminal_state["telemetry"] = {
        "connection_state": provider.get_connection_state().value,
        "order_book_sync_state": book.state.value,
        "last_exchange_time": last_ex,
        "last_receive_time": now_ms,
        "latency_ms": max(0, now_ms - last_ex),
        "reconnect_count": provider.reconnect_count,
        "sequence_gaps_count": book.sequence_gaps_count,
        "total_updates_processed": book.total_updates_processed,
        "active_clients": len(CLIENTS),
        "is_replaying": replay_player.is_playing,
        "is_recording": recorder.is_recording,
    }

    if recorder.is_recording:
        recorder.record_event("depth_snapshot", {
            "t": now_ms,
            "mid": mid_price,
            "zones_count": len(CURRENT_ZONES),
        })


async def on_trade_received(trade: TradeEvent):
    """Callback when a real-time executed trade arrives."""
    global RECENT_ABSORPTIONS
    trade_dict = {
        "t": trade.exchange_timestamp,
        "p": float(trade.price),
        "q": float(trade.quantity),
        "side": trade.aggressor_side,
        "id": trade.trade_id,
    }
    if not CAPS.get("trades"):
        trade_dict["synthetic"] = True  # tick-rule estimate from quote changes
    RECENT_TRADES.append(trade_dict)

    # --- Audit R1: aggregate into trade-price candles + CVD ---
    closed_tc = trade_candle_agg.ingest(
        price=float(trade.price),
        qty=float(trade.quantity),
        aggressor_side=trade.aggressor_side,
        ts_ms=trade.exchange_timestamp,
    )
    # Update the forming candle in the frame on every trade (low latency)
    forming = trade_candle_agg.forming()
    terminal_state["trade_candle"] = forming.to_dict() if forming else None
    terminal_state["cvd"] = trade_candle_agg.cvd()

    # Real tape only. On quote-only venues the "trades" are tick-rule synthetic
    # (qty = 1 tick) — fine for tick-volume candles / VWAP / SMPI, meaningless for
    # size-based absorption and OI/liquidation sweep classification.
    real_tape = bool(CAPS.get("trades"))

    # --- Bubble Regime engine: classify aggressive sweeps with OI + liquidation ---
    # Refresh the latest OI reading (polled by the provider) before processing the
    # trade so sweep classification sees the freshest OI delta.
    if real_tape:
        bubble_engine.update_open_interest(provider.open_interest)
        bubble_signal = bubble_engine.process_trade(
            price=float(trade.price),
            qty=float(trade.quantity),
            aggressor_side=trade.aggressor_side,
            timestamp_ms=trade.exchange_timestamp,
        )
        if bubble_signal is not None:
            logger.info(
                f"🫧 Bubble[{bubble_signal.regime}] {bubble_signal.aggressor_side} "
                f"{bubble_signal.total_qty:.1f} @ {bubble_signal.price_center:.2f} "
                f"(oiΔ={bubble_signal.oi_delta:+.1f}, liq={bubble_signal.liquidation_qty:.1f})"
            )
        bubble_state = bubble_engine.to_dict()
        terminal_state["open_interest"] = bubble_state["open_interest"]
        terminal_state["oi_delta"] = bubble_state["oi_delta"]
        # Only ship the most recent sweeps so the frame stays light (engine retains 500).
        terminal_state["bubbles"] = bubble_state["bubbles"][-40:]
        # Monotonic revision drives the UI's sweep-feed change detection (Audit #1).
        terminal_state["bubblesRev"] = bubble_state["bubblesRev"]

    # --- Audit #5: feed the session regime baseline at each 1-minute bar close ---
    # The closed trade candle's transacted volume is a clean per-minute sample of
    # how thick/thin the tape currently is. Pushing it to update_session_baseline
    # scales the absorption volume gates with the regime (thin Asia vs. hot NY),
    # instead of leaving _vol_scale pinned at 1.0. Only runs once per closed bar.
    if real_tape and closed_tc is not None and closed_tc.volume > 0:
        absorption_engine.update_session_baseline(closed_tc.volume)

    # --- OSC v7.4 overlays: advance once per CLOSED 1m trade candle (no repaint) ---
    # VWAP-Z reads true OHLC + transacted volume; SMPI reads the session CVD slope and
    # the live absorption state for the just-closed bar. The forming bar never feeds
    # these, so live == backtest.
    if closed_tc is not None:
        absorbed = real_tape and len(absorption_engine.get_recent_candidates(trade.exchange_timestamp)) > 0
        vwap_z_engine.update(
            t_ms=closed_tc.t,
            high=closed_tc.h,
            low=closed_tc.l,
            close=closed_tc.c,
            volume=closed_tc.volume,
        )
        pressure_engine.update(
            cvd=trade_candle_agg.cvd(),
            open_=closed_tc.o,
            close=closed_tc.c,
            absorption=absorbed,
        )
        terminal_state["vwap_z"] = vwap_z_engine.to_dict()["vwap_z"]
        terminal_state["pressure_index"] = pressure_engine.to_dict()["pressure_index"]

    # Ingest into quantitative absorption engine (real tape only, see above)
    if real_tape:
        candidate = absorption_engine.ingest_trade(
            price=float(trade.price),
            qty=float(trade.quantity),
            aggressor_side=trade.aggressor_side,
            timestamp_ms=trade.exchange_timestamp,
            resting_zones=CURRENT_ZONES,
        )
        if candidate:
            logger.info(f"⚡ Candidate Absorption: {candidate.reason} (Confidence: {candidate.confidence * 100:.0f}%)")
        recent_candidates = absorption_engine.get_recent_candidates(trade.exchange_timestamp)
    else:
        recent_candidates = []
    terminal_state["recent_trades"] = list(RECENT_TRADES)
    terminal_state["absorption_candidates"] = [c.to_dict() for c in recent_candidates]

    if recorder.is_recording:
        recorder.record_event("trade", trade.to_dict())


async def on_liquidation_received(liq: Dict[str, Any]):
    """Callback for @forceOrder liquidation prints — feeds the Bubble Regime engine."""
    try:
        bubble_engine.record_liquidation(Liquidation(
            timestamp_ms=int(liq["timestamp_ms"]),
            side=str(liq["side"]),
            price=float(liq["price"]),
            qty=float(liq["qty"]),
        ))
    except (KeyError, TypeError, ValueError) as e:
        logger.debug(f"bad liquidation payload {liq!r}: {e}")
        return
    logger.info(f"💥 Liquidation {liq['side']} {liq['qty']:.1f} @ {liq['price']:.2f}")
    if recorder.is_recording:
        recorder.record_event("liquidation", liq)


async def broadcast():
    """Broadcasts current snapshot to connected UI terminals."""
    if not CLIENTS or terminal_state["mid_price"] == 0.0:
        return
    # Audit #4: a coalescing sweep only emits on the *next* trade. If the tape
    # pauses right after an institutional absorption completes, the sweep is
    # trapped in the engine and the bubble never reaches the UI until more flow
    # arrives — so absorption bubbles appear to need a reload. Flush any sweep
    # that has gone quiet past the coalesce window so it ships in real time.
    if bubble_engine.flush_if_stale(int(time.time() * 1000)) is not None:
        bubble_state = bubble_engine.to_dict()
        terminal_state["open_interest"] = bubble_state["open_interest"]
        terminal_state["oi_delta"] = bubble_state["oi_delta"]
        terminal_state["bubbles"] = bubble_state["bubbles"][-40:]
        terminal_state["bubblesRev"] = bubble_state["bubblesRev"]
    if refresh_v74_frame():
        msg = safe_json_dumps(terminal_state)
    else:
        msg = safe_json_dumps({k: v for k, v in terminal_state.items() if k != "v74"})
    dead = set()
    # Snapshot: clients may (dis)connect while we await a send.
    for ws in list(CLIENTS):
        try:
            await ws.send(msg)
        except Exception:
            dead.add(ws)
    for ws in dead:
        CLIENTS.discard(ws)


async def broadcast_loop():
    """Throttled broadcast loop capped at ~12-15 fps (65-80ms)."""
    while True:
        try:
            await broadcast()
            await asyncio.sleep(0.07)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Broadcast error: {e}")
            await asyncio.sleep(0.1)


KLINE_TFS = ("1m", "5m", "15m", "30m", "1h", "4h")

# Provider switch: the whole process (engines, ledger, caches, provider stream) is
# venue-bound, so a switch persists the choice and re-execs the bridge. Clients just
# see a reconnect and receive the new venue in the first frame.
_restart_to: Optional[str] = None
_restart_event: Optional[asyncio.Event] = None


async def _klines_reply(cmd: Dict[str, Any]) -> Dict[str, Any]:
    """Chart seed candles from the ACTIVE venue (keeps OANDA credentials server-side)."""
    req_id = cmd.get("req_id")
    tf = cmd.get("tf")
    if tf not in KLINE_TFS:
        return {"type": "klines", "req_id": req_id, "ok": False, "error": f"unsupported tf {tf!r}"}
    try:
        limit = max(1, min(int(cmd.get("limit", 1000)), 1500))
    except (TypeError, ValueError):
        limit = 1000
    loop = asyncio.get_running_loop()
    try:
        candles = await asyncio.wait_for(
            loop.run_in_executor(None, fetch_chart_candles, SYMBOL, tf, limit), timeout=15
        )
    except Exception as e:
        logger.warning(f"get_klines {tf} failed: {e}")
        return {"type": "klines", "req_id": req_id, "ok": False, "tf": tf, "error": str(e)}
    return {
        "type": "klines", "req_id": req_id, "ok": True, "tf": tf,
        "symbol": SYMBOL, "provider": VENUE.name, "candles": candles,
    }


async def _handle_set_provider(ws, cmd: Dict[str, Any]) -> None:
    global _restart_to
    req_id = cmd.get("req_id")
    name = str(cmd.get("provider", "")).strip().lower()

    async def reply(ok: bool, **extra):
        await ws.send(json.dumps({"type": "provider_switch", "req_id": req_id, "ok": ok, "provider": name, **extra}))

    if name not in VENUES:
        await reply(False, error=f"unknown provider {name!r}")
        return
    if name == "oanda" and oanda_config() is None:
        await reply(False, error="OANDA credentials missing: set OANDA_API_TOKEN and OANDA_ACCOUNT_ID in .env")
        return
    if name == VENUE.name:
        await reply(True, restarting=False)
        return
    try:
        save_provider_name(name)
    except OSError as e:
        await reply(False, error=f"could not persist provider: {e}")
        return
    logger.info(f"Provider switch requested: {VENUE.name} -> {name}; restarting bridge")
    await reply(True, restarting=True)
    _restart_to = name
    if _restart_event is not None:
        _restart_event.set()


async def ws_server_handler(ws):
    CLIENTS.add(ws)
    logger.info(f"Terminal connected. Active clients: {len(CLIENTS)}")
    try:
        if terminal_state["mid_price"] > 0:
            # broadcast() skips work while no client is connected, so refresh the
            # engine frame here or a new client would receive a stale one.
            refresh_v74_frame()
            await ws.send(safe_json_dumps(terminal_state))

        async for raw_msg in ws:
            try:
                cmd = json.loads(raw_msg)
                action = cmd.get("action")
                if action == "start_recording":
                    name = cmd.get("name")
                    path = recorder.start_recording(name)
                    terminal_state["telemetry"]["is_recording"] = True
                    await ws.send(json.dumps({"type": "recorder_status", "status": "recording", "path": path}))
                elif action == "stop_recording":
                    recorder.stop_recording()
                    terminal_state["telemetry"]["is_recording"] = False
                    await ws.send(json.dumps({"type": "recorder_status", "status": "stopped"}))
                elif action == "start_replay":
                    path = cmd.get("path")
                    speed = float(cmd.get("speed", 1.0))
                    if path:
                        replay_player.load_recording(path)
                        replay_player.set_speed(speed)
                        await replay_player.start()
                elif action == "stop_replay":
                    await replay_player.stop()
                elif action == "set_replay_speed":
                    replay_player.set_speed(float(cmd.get("speed", 1.0)))
                elif action == "get_ledger":
                    tf = cmd.get("tf")
                    tf = tf if tf in hub.tfs else None
                    limit = max(1, min(int(cmd.get("limit", 100)), 500))
                    await ws.send(safe_json_dumps(hub.ledger_view(tf, limit), default=str))
                elif action == "set_risk_config":
                    try:
                        cfg = hub.set_risk(dict(cmd.get("config", {})))
                        await ws.send(json.dumps({"type": "risk_config", "ok": True, "config": cfg.__dict__}))
                    except (ValueError, TypeError) as e:
                        await ws.send(json.dumps({"type": "risk_config", "ok": False, "error": str(e)}))
                elif action == "get_klines":
                    await ws.send(safe_json_dumps(await _klines_reply(cmd)))
                elif action == "get_providers":
                    await ws.send(safe_json_dumps({
                        "type": "providers", "req_id": cmd.get("req_id"),
                        "active": VENUE.name, "providers": providers_view(),
                    }))
                elif action == "set_provider":
                    await _handle_set_provider(ws, cmd)
            except Exception as e:
                logger.error(f"Error handling client command: {e}")
    except websockets.exceptions.ConnectionClosed:
        pass  # client vanished without a close frame (tab killed, bridge restart) — normal
    finally:
        CLIENTS.discard(ws)
        logger.info(f"Terminal disconnected. Active clients: {len(CLIENTS)}")


async def main():
    global _restart_event
    _restart_event = asyncio.Event()
    logger.info(f"Starting Market Microstructure Bridge [{VENUE.label} · {SYMBOL}] on ws://{HOST}:{PORT}...")
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        logger.warning(f"Bridge bound to {HOST}: control commands are unauthenticated — trusted networks only")
    server = await serve(ws_server_handler, HOST, PORT, origins=ALLOWED_ORIGINS)

    # Register callbacks with provider
    provider.register_depth_callback(on_depth_update)
    provider.register_trade_callback(on_trade_received)
    provider.register_liquidation_callback(on_liquidation_received)

    # Start provider & broadcast loop
    await provider.start()
    broadcaster = asyncio.create_task(broadcast_loop())
    engine_task = asyncio.create_task(hub.run())
    serve_task = asyncio.create_task(server.serve_forever())
    restart_wait = asyncio.create_task(_restart_event.wait())

    try:
        # hub.run() may legitimately return (warm-up failure is reported in the v74
        # frame), so only the server and a restart request end the bridge.
        await asyncio.wait({serve_task, restart_wait}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        # Stop accepting / drop clients first so nobody reconnects to a dying process,
        # then stop the venue stream with a bound (websocket close handshakes can stall).
        server.close()
        for t in (broadcaster, engine_task, serve_task, restart_wait):
            t.cancel()
        try:
            await asyncio.wait_for(provider.stop(), timeout=5)
        except (asyncio.TimeoutError, Exception) as e:
            logger.warning(f"provider stop did not finish cleanly: {e!r}")

    if _restart_to:
        # Don't exec in the middle of a ledger write from the engine thread.
        hub.lock.acquire(timeout=10)
        env = dict(os.environ, MARKET_PROVIDER=_restart_to)
        logger.info(f"Re-executing bridge with MARKET_PROVIDER={_restart_to}")
        logging.shutdown()
        os.execve(sys.executable, [sys.executable, *sys.orig_argv[1:]], env)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Terminal Bridge shutdown cleanly.")
