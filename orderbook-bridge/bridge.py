#!/usr/bin/env python3
"""
Institutional Market Microstructure Terminal Bridge
----------------------------------------------------
Primary Instrument: Binance USDⓈ-M Futures XAUUSDT (TRADIFI_PERPETUAL)
Capabilities:
1. Sequence-synchronized L2 Order Book with REST snapshot recovery & gap detection.
2. Resting Liquidity Zone overlay engine with multi-threshold clustering & lifecycle tracking.
3. Absorption bubble candidate engine with volatility-normalized volume vs. price response.
4. v7.4 engine (engine/): OSC-VIP + REG v7.4 port, empirical ledger calibration, risk plans.
5. Event recording & replay engine.
6. Broadcasts structured JSON frames to trading-terminal on ws://0.0.0.0:8765.
"""

import asyncio
import faulthandler
import signal
from collections import deque
from decimal import Decimal
import json
import logging
import os
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
from analytics.liquidity_zones import LiquidityZoneDetector, LiquidityZone
from analytics.absorption_engine import AbsorptionEngine, AbsorptionCandidate
from analytics.vacuum_engine import VacuumEngine, Candle
from analytics.trade_candles import TradeCandleAggregator
from engine.sessions import session_flags as _v74_session_flags
from replay.replay_engine import MarketRecorder, ReplayPlayer
from engine.live import LiveHub
from engine.orderflow import OrderflowSnapshot
from engine.alerts import AlertDispatcher

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s"
)
logger = logging.getLogger("TerminalBridge")
# `kill -USR1 <pid>` dumps all thread stacks to stderr (diagnose stalls without stopping the bridge).
if hasattr(signal, "SIGUSR1"):
    faulthandler.register(signal.SIGUSR1, all_threads=True)

PORT = int(os.environ.get("BRIDGE_PORT", "8765"))
SYMBOL = "XAUUSDT"

# Connected frontend clients
CLIENTS: Set = set()

# Core engines
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


hub = LiveHub(symbol=SYMBOL, snapshot_fn=_orderflow_snapshot, on_signal=alerts.on_signal)
_v74_cache: Dict[str, Any] = {"version": -1, "at": 0.0, "frame": None}


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
    "market_type": "usd_m_futures",
    "provider": "Binance USDⓈ-M Futures",
    "contract_type": "TRADIFI_PERPETUAL",
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

    # 3. Detect resting liquidity zones
    CURRENT_ZONES = zone_detector.update(book.bids, book.asks, now_ms=now_ms)

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

    # Extract key levels and recent sweep events from the v74 frame (if available)
    v74_frame = _v74_cache.get("frame")
    if v74_frame:
        # Key levels come from the first ready timeframe in frames
        for tf_name, tf_frame in (v74_frame.get("frames") or {}).items():
            struct = tf_frame.get("structure") if tf_frame else None
            if struct:
                kl = struct.get("key_levels") or {}
                terminal_state["key_levels"] = {
                    "pdh": kl.get("pdh"),
                    "pdl": kl.get("pdl"),
                    "pwh": kl.get("pwh"),
                    "pwl": kl.get("pwl"),
                }
                # Sweep events: keep the last 20 for the chart overlay
                events = struct.get("events") or []
                sweeps = [e for e in events if e.get("kind") == "liq_sweep"]
                terminal_state["sweep_events"] = sweeps[-20:]
                break  # use the first ready timeframe

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

    # Ingest into quantitative absorption engine
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
    terminal_state["recent_trades"] = list(RECENT_TRADES)
    terminal_state["absorption_candidates"] = [c.to_dict() for c in recent_candidates]

    if recorder.is_recording:
        recorder.record_event("trade", trade.to_dict())


async def broadcast():
    """Broadcasts current snapshot to connected UI terminals."""
    if not CLIENTS or terminal_state["mid_price"] == 0.0:
        return
    if refresh_v74_frame():
        msg = json.dumps(terminal_state)
    else:
        msg = json.dumps({k: v for k, v in terminal_state.items() if k != "v74"})
    dead = set()
    for ws in CLIENTS:
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


async def ws_server_handler(ws):
    CLIENTS.add(ws)
    logger.info(f"Terminal connected. Active clients: {len(CLIENTS)}")
    try:
        if terminal_state["mid_price"] > 0:
            # broadcast() skips work while no client is connected, so refresh the
            # engine frame here or a new client would receive a stale one.
            refresh_v74_frame()
            await ws.send(json.dumps(terminal_state))

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
                    await ws.send(json.dumps(hub.ledger_view(tf, limit), default=str))
                elif action == "set_risk_config":
                    try:
                        cfg = hub.set_risk(dict(cmd.get("config", {})))
                        await ws.send(json.dumps({"type": "risk_config", "ok": True, "config": cfg.__dict__}))
                    except (ValueError, TypeError) as e:
                        await ws.send(json.dumps({"type": "risk_config", "ok": False, "error": str(e)}))
            except Exception as e:
                logger.error(f"Error handling client command: {e}")
    finally:
        CLIENTS.discard(ws)
        logger.info(f"Terminal disconnected. Active clients: {len(CLIENTS)}")


async def main():
    logger.info(f"Starting Institutional Market Microstructure Bridge on ws://0.0.0.0:{PORT}...")
    server = await serve(ws_server_handler, "0.0.0.0", PORT)

    # Register callbacks with provider
    provider.register_depth_callback(on_depth_update)
    provider.register_trade_callback(on_trade_received)

    # Start provider & broadcast loop
    await provider.start()
    broadcaster = asyncio.create_task(broadcast_loop())
    engine_task = asyncio.create_task(hub.run())

    try:
        await asyncio.gather(server.serve_forever(), broadcaster, engine_task)
    finally:
        await provider.stop()
        broadcaster.cancel()
        engine_task.cancel()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Terminal Bridge shutdown cleanly.")
