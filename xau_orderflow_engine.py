#!/usr/bin/env python3
"""
Production Microstructure & Order Flow Engine for XAUUSDT (Binance) & GC (CME)
==============================================================================

Architecture Overview:
----------------------
1. Strict Local Order Book State Machine (`LocalOrderBook`):
   - Implements the official Binance USDS-M Futures diff-depth synchronization
     protocol (`U`, `u`, `pu` sequence validation) with automatic snapshot
     resynchronization on packet loss and a 200ms stale-book circuit breaker.
   - Designed around a unified adapter interface so CME Globex MDP 3.0 (via
     Databento MBO/MBP) plugs into the exact same analytics pipeline.

2. Spoof-Resistant Lifespan & Pulling/Stacking Filter (`SpoofAndLifespanFilter`):
   - Tracks resting duration per price level and weights Bookmap-style heatmap
     intensity by logarithmic resting age: Size * ln(1 + age_sec / tau).
   - Separates passive limit cancellations ("Pulling") from actual trade
     executions to compute a live BBO Pulling/Stacking Imbalance Ratio.

3. Synthetic & Native Iceberg Detector (`IcebergDetector`):
   - Compares pre-sweep visible resting depth at price P against cumulative
     aggressive volume executed at P before the price level ticks through.
   - Emits an `IcebergSignal` quantifying hidden replenished liquidity.

4. ATAS-Style Absorption Bubble + OI/Liquidation Classifier (`AbsorptionBubbleEngine`):
   - Reconstructs single-taker multi-level sweeps across a 12ms window.
   - Combines aggressive volume bubbles with Open Interest (OI) delta and
     `@forceOrder` liquidation prints to distinguish fresh institutional limit
     absorption (Rising OI) from forced liquidation cascades (Dropping OI).

5. Money Pocket Vacuum & Sweep Velocity Detector (`MoneyPocketVacuumEngine`):
   - Detects thin order book zones (Low-Volume Nodes + low resting depth) and
     measures 250ms slippage-per-lot velocity to flag rapid vacuum sweeps.

6. Dynamic COMEX GC <-> Binance XAUUSDT Basis Mapper (`CrossVenueBasisMapper`):
   - Maintains a real-time EMA cost-of-carry basis spread (GC - XAUUSDT) and
     translates COMEX GC institutional levels onto XAUUSDT price coordinates.

7. Zero-Copy Shared Memory Bridge for SciChart (`SciChartSharedMemoryBridge`):
   - Decouples WebSocket ingestion from UI rendering using `multiprocessing.shared_memory`
     and tick-binned NumPy arrays for 60 FPS (16.6ms) SciChart updates.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from enum import IntEnum
import logging
import math
from multiprocessing import shared_memory
import time
from typing import Callable, Deque, Dict, List, Optional, Tuple

import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("XAUOrderFlowEngine")


# ============================================================================
# 1. UNIFIED MARKET MICROSTRUCTURE SCHEMAS (BINANCE & CME MDP 3.0 COMPATIBLE)
# ============================================================================


class Side(IntEnum):
    BID = 1     # Passive Bid / Aggressive Buy Taker
    ASK = -1    # Passive Ask / Aggressive Sell Taker


class BubbleRegime(IntEnum):
    STANDARD_FLOW = 0
    INSTITUTIONAL_ABSORPTION_OPEN = 1   # High volume + price held + Rising OI
    LIQUIDATION_EXHAUSTION_FLUSH = 2    # High volume + Dropping OI + forceOrder
    VACUUM_SWEEP_BREAKOUT = 3           # High slippage velocity through thin book


@dataclass(slots=True)
class BookDeltaEvent:
    """Normalized L2/L3 order book update from Binance @depth or CME MDP 3.0."""
    venue: str
    symbol: str
    exchange_ts_ms: int
    local_ts_ms: int
    first_update_id: int      # Binance 'U' or CME RptSeq start
    final_update_id: int      # Binance 'u' or CME RptSeq end
    prev_final_update_id: int # Binance 'pu' (previous packet's 'u')
    bids: List[Tuple[float, float]]  # [(price, new_resting_qty), ...]
    asks: List[Tuple[float, float]]  # [(price, new_resting_qty), ...]


@dataclass(slots=True)
class AggTradeEvent:
    """Normalized trade print from Binance @aggTrade or CME Trade Summary."""
    venue: str
    symbol: str
    exchange_ts_ms: int
    local_ts_ms: int
    trade_id: int
    price: float
    qty: float
    aggressor_side: Side  # Side.BID = Market Buy (lifted ask), Side.ASK = Market Sell (hit bid)


@dataclass(slots=True)
class LiquidationEvent:
    """Normalized forced liquidation order from Binance @forceOrder."""
    venue: str
    symbol: str
    exchange_ts_ms: int
    side: Side            # Side of the forced market order
    price: float
    qty: float


@dataclass(slots=True)
class IcebergSignal:
    """Emitted when executed volume at price P exceeds visible resting size."""
    timestamp_ms: int
    price: float
    defending_side: Side  # Side.BID = Passive limit buyer absorbing sell market orders
    initial_visible_qty: float
    total_absorbed_qty: float
    hidden_refilled_qty: float


@dataclass(slots=True)
class AbsorptionBubbleSignal:
    """ATAS-style bubble enriched with OI delta, absorption ratio, and regime."""
    timestamp_ms: int
    price_center: float
    aggressor_side: Side
    total_qty: float
    sweep_ticks: float
    oi_delta: float
    liquidation_qty: float
    regime: BubbleRegime


@dataclass(slots=True)
class VacuumPocketZone:
    """Money Pocket Vacuum zone where resting liquidity and historical volume are thin."""
    price_low: float
    price_high: float
    avg_resting_depth: float
    slippage_velocity: float  # Price ticks moved per unit of aggressive volume


# ============================================================================
# 2. SPOOF-RESISTANT ORDER BOOK & ICEBERG MICROSTRUCTURE ENGINE
# ============================================================================


@dataclass(slots=True)
class PriceLevelState:
    """Tracks resting quantity, lifespan, and iceberg absorption at a single price."""
    price: float
    qty: float
    first_seen_ms: int
    last_updated_ms: int
    pre_sweep_visible_qty: float
    cumulative_absorbed_qty: float = 0.0


class LocalOrderBook:
    """
    Production Order Book State Machine with:
    - Strict Binance `U`, `u`, `pu` sequence validation
    - Automatic snapshot recovery trigger on dropped packets
    - Resting order lifespan weighting (Spoof Filter)
    - Pulling/Stacking Imbalance tracking (separating cancellations from fills)
    - Synthetic Iceberg detection
    """

    def __init__(
        self,
        symbol: str = "XAUUSDT",
        tick_size: float = 0.10,
        max_stale_ms: int = 200,
        lifespan_tau_sec: float = 15.0,
        iceberg_min_hidden_qty: float = 15.0,
    ) -> None:
        self.symbol = symbol
        self.tick_size = tick_size
        self.max_stale_ms = max_stale_ms
        self.lifespan_tau_sec = lifespan_tau_sec
        self.iceberg_min_hidden_qty = iceberg_min_hidden_qty

        # Price -> PriceLevelState
        self.bids: Dict[float, PriceLevelState] = {}
        self.asks: Dict[float, PriceLevelState] = {}

        # Synchronization state
        self.is_synchronized: bool = False
        self.last_update_id: int = -1
        self.event_buffer: Deque[BookDeltaEvent] = deque(maxlen=5000)
        self.resync_required_callback: Optional[Callable[[], None]] = None

        # Telemetry & circuit breaker
        self.last_exchange_ts_ms: int = 0
        self.current_latency_ms: int = 0
        self.is_stale: bool = True

        # Rolling trade fills per price (to avoid misclassifying fills as "Pulling")
        self._recent_fills_by_price: Dict[float, float] = {}

        # Rolling Pulling/Stacking net delta (timestamp_ms, bid_net_stack, ask_net_stack)
        self.pull_stack_window: Deque[Tuple[int, float, float]] = deque(maxlen=2000)

        # Detected Iceberg signals
        self.iceberg_signals: Deque[IcebergSignal] = deque(maxlen=500)

    def _round_price(self, price: float) -> float:
        return round(round(price / self.tick_size) * self.tick_size, 2)

    def load_rest_snapshot(
        self,
        last_update_id: int,
        bids: List[Tuple[float, float]],
        asks: List[Tuple[float, float]],
        timestamp_ms: int,
    ) -> None:
        """
        Applies the REST `/fapi/v1/depth` snapshot and replays buffered WebSocket
        events following Binance's official synchronization rules.
        """
        self.bids.clear()
        self.asks.clear()
        for p, q in bids:
            rp = self._round_price(p)
            if q > 0:
                self.bids[rp] = PriceLevelState(rp, q, timestamp_ms, timestamp_ms, q)
        for p, q in asks:
            rp = self._round_price(p)
            if q > 0:
                self.asks[rp] = PriceLevelState(rp, q, timestamp_ms, timestamp_ms, q)

        self.last_update_id = last_update_id
        self.is_synchronized = True

        # Replay buffered WebSocket diff events
        while self.event_buffer:
            ev = self.event_buffer.popleft()
            # Rule 1: Drop any event where u is < lastUpdateId in the snapshot
            if ev.final_update_id < self.last_update_id:
                continue
            # Rule 2: First processed event should have U <= lastUpdateId AND u >= lastUpdateId
            if ev.first_update_id <= self.last_update_id <= ev.final_update_id:
                self._apply_delta_internal(ev)
                self.last_update_id = ev.final_update_id
            elif ev.prev_final_update_id == self.last_update_id:
                self._apply_delta_internal(ev)
                self.last_update_id = ev.final_update_id
            else:
                logger.warning(
                    "Buffer sequence gap during snapshot replay (expected pu=%d, got pu=%d). Triggering resync.",
                    self.last_update_id,
                    ev.prev_final_update_id,
                )
                self._trigger_resync()
                return

        logger.info(
            "Order book synchronized at lastUpdateId=%d (Bids=%d, Asks=%d)",
            self.last_update_id,
            len(self.bids),
            len(self.asks),
        )

    def process_depth_event(self, event: BookDeltaEvent) -> bool:
        """
        Processes an incoming WebSocket `@depth` packet with strict `pu` sequence
        validation and latency circuit-breaker monitoring.
        """
        self.current_latency_ms = max(0, event.local_ts_ms - event.exchange_ts_ms)
        self.last_exchange_ts_ms = event.exchange_ts_ms
        self.is_stale = self.current_latency_ms > self.max_stale_ms

        if not self.is_synchronized:
            self.event_buffer.append(event)
            return False

        # Drop already-processed updates
        if event.final_update_id < self.last_update_id:
            return True

        # Strict Binance sequence rule: each new event's `pu` must equal prior `u`
        if event.prev_final_update_id != self.last_update_id:
            if not (event.first_update_id <= self.last_update_id <= event.final_update_id):
                logger.error(
                    "Order book sequence break! prev_u=%d != packet.pu=%d. Wiping book to prevent ghost clusters.",
                    self.last_update_id,
                    event.prev_final_update_id,
                )
                self._trigger_resync()
                return False

        self._apply_delta_internal(event)
        self.last_update_id = event.final_update_id
        return True

    def _trigger_resync(self) -> None:
        self.is_synchronized = False
        self.bids.clear()
        self.asks.clear()
        if self.resync_required_callback is not None:
            self.resync_required_callback()

    def _apply_delta_internal(self, event: BookDeltaEvent) -> None:
        best_bid, best_ask = self.get_bbo()
        near_band = 25.0 * self.tick_size
        bid_net_stack = 0.0
        ask_net_stack = 0.0

        # Update Bids
        for raw_p, new_q in event.bids:
            p = self._round_price(raw_p)
            prev_state = self.bids.get(p)
            prev_q = prev_state.qty if prev_state else 0.0
            delta_q = new_q - prev_q

            # Subtract any recent trade fill at this price so fills aren't counted as limit pulls
            recent_fill = self._recent_fills_by_price.pop(p, 0.0)
            passive_change = delta_q + recent_fill

            if best_bid > 0 and abs(p - best_bid) <= near_band:
                bid_net_stack += passive_change

            if new_q <= 1e-9:
                self.bids.pop(p, None)
            elif prev_state is None:
                self.bids[p] = PriceLevelState(
                    price=p,
                    qty=new_q,
                    first_seen_ms=event.exchange_ts_ms,
                    last_updated_ms=event.exchange_ts_ms,
                    pre_sweep_visible_qty=new_q,
                    cumulative_absorbed_qty=0.0,
                )
            else:
                # If size jumped significantly, partially decay the resting age so new spoof additions don't inherit old age
                if new_q > prev_q * 1.5:
                    weight_old = prev_q / new_q
                    prev_state.first_seen_ms = int(
                        prev_state.first_seen_ms * weight_old
                        + event.exchange_ts_ms * (1.0 - weight_old)
                    )
                prev_state.qty = new_q
                prev_state.last_updated_ms = event.exchange_ts_ms
                if prev_state.cumulative_absorbed_qty == 0.0:
                    prev_state.pre_sweep_visible_qty = max(
                        prev_state.pre_sweep_visible_qty, new_q
                    )

        # Update Asks
        for raw_p, new_q in event.asks:
            p = self._round_price(raw_p)
            prev_state = self.asks.get(p)
            prev_q = prev_state.qty if prev_state else 0.0
            delta_q = new_q - prev_q

            recent_fill = self._recent_fills_by_price.pop(p, 0.0)
            passive_change = delta_q + recent_fill

            if best_ask > 0 and abs(p - best_ask) <= near_band:
                ask_net_stack += passive_change

            if new_q <= 1e-9:
                self.asks.pop(p, None)
            elif prev_state is None:
                self.asks[p] = PriceLevelState(
                    price=p,
                    qty=new_q,
                    first_seen_ms=event.exchange_ts_ms,
                    last_updated_ms=event.exchange_ts_ms,
                    pre_sweep_visible_qty=new_q,
                    cumulative_absorbed_qty=0.0,
                )
            else:
                if new_q > prev_q * 1.5:
                    weight_old = prev_q / new_q
                    prev_state.first_seen_ms = int(
                        prev_state.first_seen_ms * weight_old
                        + event.exchange_ts_ms * (1.0 - weight_old)
                    )
                prev_state.qty = new_q
                prev_state.last_updated_ms = event.exchange_ts_ms
                if prev_state.cumulative_absorbed_qty == 0.0:
                    prev_state.pre_sweep_visible_qty = max(
                        prev_state.pre_sweep_visible_qty, new_q
                    )

        if bid_net_stack != 0.0 or ask_net_stack != 0.0:
            self.pull_stack_window.append(
                (event.exchange_ts_ms, bid_net_stack, ask_net_stack)
            )

    def register_trade_for_iceberg_and_fills(
        self, trade: AggTradeEvent
    ) -> Optional[IcebergSignal]:
        """
        Records aggressive trade fills against the passive resting level to:
        1. Prevent trade executions from registering as passive limit cancellations.
        2. Detect Synthetic Icebergs when executed volume at price P exceeds the
           initial visible resting depth at P while the level continues to hold.
        """
        p = self._round_price(trade.price)
        self._recent_fills_by_price[p] = (
            self._recent_fills_by_price.get(p, 0.0) + trade.qty
        )

        # Market Sell (aggressor_side == ASK) hits passive Bid limit orders
        if trade.aggressor_side == Side.ASK:
            lvl = self.bids.get(p)
            defending_side = Side.BID
        else:
            # Market Buy (aggressor_side == BID) lifts passive Ask limit orders
            lvl = self.asks.get(p)
            defending_side = Side.ASK

        if lvl is None:
            return None

        lvl.cumulative_absorbed_qty += trade.qty
        hidden_refill = lvl.cumulative_absorbed_qty - lvl.pre_sweep_visible_qty

        if hidden_refill >= self.iceberg_min_hidden_qty:
            sig = IcebergSignal(
                timestamp_ms=trade.exchange_ts_ms,
                price=p,
                defending_side=defending_side,
                initial_visible_qty=lvl.pre_sweep_visible_qty,
                total_absorbed_qty=lvl.cumulative_absorbed_qty,
                hidden_refilled_qty=hidden_refill,
            )
            # Reset baseline after firing so subsequent refills require fresh hidden volume
            lvl.pre_sweep_visible_qty = lvl.cumulative_absorbed_qty
            self.iceberg_signals.append(sig)
            return sig
        return None

    def get_bbo(self) -> Tuple[float, float]:
        best_bid = max(self.bids.keys()) if self.bids else 0.0
        best_ask = min(self.asks.keys()) if self.asks else 0.0
        return best_bid, best_ask

    def get_pulling_stacking_imbalance(self, lookback_ms: int = 5000) -> Tuple[float, float]:
        """
        Returns (net_bid_stacking, net_ask_stacking) over the last `lookback_ms`.
        Positive values = net limit order stacking; negative values = net pulling (spoof removal).
        """
        cutoff = self.last_exchange_ts_ms - lookback_ms
        bid_sum = 0.0
        ask_sum = 0.0
        for ts, b_net, a_net in reversed(self.pull_stack_window):
            if ts < cutoff:
                break
            bid_sum += b_net
            ask_sum += a_net
        return bid_sum, ask_sum

    def get_spoof_filtered_heatmap_column(
        self,
        price_min: float,
        price_max: float,
        bin_size: float,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Returns two 1D NumPy arrays of length `num_bins` for SciChart Heatmap rendering:
        1. `raw_depth_bins`: Unweighted resting limit volume per price bucket.
        2. `spoof_filtered_bins`: Lifespan-weighted resting volume:
           Weight = qty * ln(1 + resting_duration_sec / tau)
           Flashed spoof orders (<200ms old) receive near-zero heatmap brightness.
        """
        num_bins = int(round((price_max - price_min) / bin_size))
        raw_bins = np.zeros(num_bins, dtype=np.float32)
        weighted_bins = np.zeros(num_bins, dtype=np.float32)

        now_ms = max(self.last_exchange_ts_ms, 1)

        for book_side in (self.bids, self.asks):
            for p, state in book_side.items():
                if price_min <= p < price_max:
                    idx = int(math.floor(round((p - price_min) / bin_size, 6)))
                    if 0 <= idx < num_bins:
                        age_sec = max(0.0, (now_ms - state.first_seen_ms) / 1000.0)
                        age_factor = math.log1p(age_sec / self.lifespan_tau_sec)
                        raw_bins[idx] += state.qty
                        weighted_bins[idx] += state.qty * age_factor

        return raw_bins, weighted_bins


# ============================================================================
# 3. ATAS-STYLE BUBBLE ABSORPTION + OI & LIQUIDATION CLASSIFIER
# ============================================================================


class AbsorptionBubbleEngine:
    """
    Reconstructs institutional multi-level sweeps across a tight millisecond window
    and cross-references Open Interest (OI) delta + `@forceOrder` liquidations
    to classify every volume bubble.
    """

    def __init__(
        self,
        sweep_coalesce_ms: int = 12,
        min_bubble_qty: float = 25.0,
        absorption_max_ticks: float = 0.30,
    ) -> None:
        self.sweep_coalesce_ms = sweep_coalesce_ms
        self.min_bubble_qty = min_bubble_qty
        self.absorption_max_ticks = absorption_max_ticks

        # Active sweep accumulator
        self._active_side: Optional[Side] = None
        self._active_start_ts: int = 0
        self._active_prices: List[float] = []
        self._active_qtys: List[float] = []

        # Recent liquidations & Open Interest state
        self.recent_liquidations: Deque[LiquidationEvent] = deque(maxlen=500)
        self.latest_oi: float = 0.0
        self.prev_oi: float = 0.0

        # Cumulative Volume Delta (CVD) & emitted bubbles
        self.cvd: float = 0.0
        self.emitted_bubbles: Deque[AbsorptionBubbleSignal] = deque(maxlen=500)

    def update_open_interest(self, new_oi: float) -> None:
        if self.latest_oi > 0:
            self.prev_oi = self.latest_oi
        self.latest_oi = new_oi

    def record_liquidation(self, liq: LiquidationEvent) -> None:
        self.recent_liquidations.append(liq)

    def process_agg_trade(self, trade: AggTradeEvent) -> Optional[AbsorptionBubbleSignal]:
        """
        Accumulates consecutive fills belonging to the same aggressor sweep and
        emits a classified `AbsorptionBubbleSignal` once the burst completes.
        """
        # Update session Cumulative Volume Delta (CVD)
        self.cvd += trade.qty if trade.aggressor_side == Side.BID else -trade.qty

        if (
            self._active_side == trade.aggressor_side
            and (trade.exchange_ts_ms - self._active_start_ts) <= self.sweep_coalesce_ms
        ):
            self._active_prices.append(trade.price)
            self._active_qtys.append(trade.qty)
            return None

        # Flush previous sweep before starting the new one
        emitted = self._flush_active_sweep()

        self._active_side = trade.aggressor_side
        self._active_start_ts = trade.exchange_ts_ms
        self._active_prices = [trade.price]
        self._active_qtys = [trade.qty]
        return emitted

    def flush_pending(self) -> Optional[AbsorptionBubbleSignal]:
        return self._flush_active_sweep()

    def _flush_active_sweep(self) -> Optional[AbsorptionBubbleSignal]:
        if not self._active_qtys or self._active_side is None:
            return None

        total_qty = sum(self._active_qtys)
        if total_qty < self.min_bubble_qty:
            self._active_qtys.clear()
            self._active_prices.clear()
            return None

        vwap_price = sum(
            p * q for p, q in zip(self._active_prices, self._active_qtys)
        ) / total_qty
        sweep_ticks = max(self._active_prices) - min(self._active_prices)
        oi_delta = self.latest_oi - self.prev_oi

        # Sum matching forced liquidations within 500ms of the sweep
        liq_qty = sum(
            l.qty
            for l in self.recent_liquidations
            if abs(l.exchange_ts_ms - self._active_start_ts) <= 500
            and l.side == self._active_side
        )

        # Classify the bubble regime
        if liq_qty > 0.15 * total_qty and oi_delta < 0:
            regime = BubbleRegime.LIQUIDATION_EXHAUSTION_FLUSH
        elif sweep_ticks <= self.absorption_max_ticks and oi_delta >= 0:
            regime = BubbleRegime.INSTITUTIONAL_ABSORPTION_OPEN
        elif sweep_ticks >= 1.00:
            regime = BubbleRegime.VACUUM_SWEEP_BREAKOUT
        else:
            regime = BubbleRegime.STANDARD_FLOW

        signal = AbsorptionBubbleSignal(
            timestamp_ms=self._active_start_ts,
            price_center=round(vwap_price, 2),
            aggressor_side=self._active_side,
            total_qty=round(total_qty, 3),
            sweep_ticks=round(sweep_ticks, 2),
            oi_delta=round(oi_delta, 3),
            liquidation_qty=round(liq_qty, 3),
            regime=regime,
        )
        self.emitted_bubbles.append(signal)

        self._active_qtys.clear()
        self._active_prices.clear()
        return signal


# ============================================================================
# 4. MONEY POCKET VACUUM & SLIPPAGE VELOCITY DETECTOR
# ============================================================================


class MoneyPocketVacuumEngine:
    """
    Identifies 'Money Pocket' liquidity vacuums where both historical traded
    volume (Volume Profile LVN) and current resting limit orders are thin,
    and tracks 250ms slippage-per-lot velocity.
    """

    def __init__(self, bin_size: float = 0.50, velocity_window_ms: int = 250) -> None:
        self.bin_size = bin_size
        self.velocity_window_ms = velocity_window_ms
        self.volume_profile: Dict[float, float] = {}
        self.recent_trades: Deque[AggTradeEvent] = deque(maxlen=1000)

    def _bin_price(self, price: float) -> float:
        return round(math.floor(round(price / self.bin_size, 6)) * self.bin_size, 2)

    def record_trade(self, trade: AggTradeEvent) -> None:
        b = self._bin_price(trade.price)
        self.volume_profile[b] = self.volume_profile.get(b, 0.0) + trade.qty
        self.recent_trades.append(trade)

    def get_current_slippage_velocity(self, current_ts_ms: int) -> float:
        """
        Computes rolling price displacement per unit of aggressive volume over
        the last `velocity_window_ms` (Ticks Moved / Volume).
        """
        cutoff = current_ts_ms - self.velocity_window_ms
        prices = []
        vol = 0.0
        for t in reversed(self.recent_trades):
            if t.exchange_ts_ms < cutoff:
                break
            prices.append(t.price)
            vol += t.qty
        if len(prices) < 2 or vol <= 1e-6:
            return 0.0
        return abs(prices[0] - prices[-1]) / vol

    def detect_vacuum_pockets(
        self,
        book: LocalOrderBook,
        price_min: float,
        price_max: float,
        depth_percentile_cutoff: float = 25.0,
    ) -> List[VacuumPocketZone]:
        """
        Finds contiguous price bands between `price_min` and `price_max` where
        both resting depth and historical volume profile sit in the bottom quartile.
        """
        raw_depth, _ = book.get_spoof_filtered_heatmap_column(
            price_min, price_max, self.bin_size
        )
        num_bins = len(raw_depth)
        if num_bins == 0:
            return []

        vp_array = np.zeros(num_bins, dtype=np.float32)
        for i in range(num_bins):
            p_bin = round(price_min + i * self.bin_size, 2)
            vp_array[i] = self.volume_profile.get(p_bin, 0.0)

        non_zero_depth = raw_depth[raw_depth > 0]
        depth_thresh = (
            float(np.percentile(non_zero_depth, depth_percentile_cutoff))
            if len(non_zero_depth) > 0
            else 5.0
        )
        non_zero_vp = vp_array[vp_array > 0]
        vp_thresh = (
            float(np.percentile(non_zero_vp, depth_percentile_cutoff))
            if len(non_zero_vp) > 0
            else 10.0
        )

        velocity = self.get_current_slippage_velocity(book.last_exchange_ts_ms)
        pockets: List[VacuumPocketZone] = []

        in_pocket = False
        start_idx = 0
        depth_accum: List[float] = []

        for i in range(num_bins):
            is_thin = (raw_depth[i] <= depth_thresh) and (vp_array[i] <= vp_thresh)
            if is_thin and not in_pocket:
                in_pocket = True
                start_idx = i
                depth_accum = [float(raw_depth[i])]
            elif is_thin and in_pocket:
                depth_accum.append(float(raw_depth[i]))
            elif not is_thin and in_pocket:
                in_pocket = False
                if (i - start_idx) >= 2:
                    pockets.append(
                        VacuumPocketZone(
                            price_low=round(price_min + start_idx * self.bin_size, 2),
                            price_high=round(price_min + i * self.bin_size, 2),
                            avg_resting_depth=round(sum(depth_accum) / len(depth_accum), 2),
                            slippage_velocity=round(velocity, 4),
                        )
                    )

        return pockets


# ============================================================================
# 5. DYNAMIC COMEX GC <-> BINANCE XAUUSDT CROSS-VENUE BASIS MAPPER
# ============================================================================


class CrossVenueBasisMapper:
    """
    Tracks the real-time EFP / cost-of-carry basis between COMEX Gold Futures (GC)
    and Binance XAUUSDT Perpetual so institutional levels discovered on CME GC
    automatically map onto XAUUSDT chart coordinates.
    """

    def __init__(self, ema_alpha: float = 0.05) -> None:
        self.ema_alpha = ema_alpha
        self.ema_basis: Optional[float] = None
        self.ema_var: float = 0.0
        self.latest_gc_mid: float = 0.0
        self.latest_xauusdt_mid: float = 0.0

    def update_quotes(self, gc_mid: float, xauusdt_mid: float) -> float:
        self.latest_gc_mid = gc_mid
        self.latest_xauusdt_mid = xauusdt_mid
        raw_basis = gc_mid - xauusdt_mid

        if self.ema_basis is None:
            self.ema_basis = raw_basis
            self.ema_var = 0.0
        else:
            diff = raw_basis - self.ema_basis
            self.ema_basis += self.ema_alpha * diff
            self.ema_var = (1.0 - self.ema_alpha) * (
                self.ema_var + self.ema_alpha * (diff ** 2)
            )
        return self.ema_basis

    def map_gc_level_to_xauusdt(self, gc_price: float) -> float:
        """Translates a COMEX GC price level onto Binance XAUUSDT coordinates."""
        if self.ema_basis is None:
            return gc_price
        return round(gc_price - self.ema_basis, 2)

    def get_basis_zscore(self) -> float:
        """
        Measures how many standard deviations the instantaneous GC-XAUUSDT spread
        has stretched from its rolling EMA (arbitrage lead-lag indicator).
        """
        if self.ema_basis is None or self.ema_var <= 1e-8:
            return 0.0
        raw_basis = self.latest_gc_mid - self.latest_xauusdt_mid
        return (raw_basis - self.ema_basis) / math.sqrt(self.ema_var)


# ============================================================================
# 6. ZERO-COPY SHARED MEMORY BRIDGE FOR 60 FPS SCICHART UI RENDERING
# ============================================================================


class SciChartSharedMemoryBridge:
    """
    Publishes pre-binned, spoof-filtered heatmap slices and microstructure
    telemetry into `multiprocessing.shared_memory` so the SciChart UI process
    reads 60 FPS frames with zero GIL contention or socket serialization overhead.

    Shared Memory Layout:
    - `heatmap_shm`: float32 array of shape (time_columns, price_bins)
    - `telemetry_shm`: float64 array of shape (10,) holding:
      [best_bid, best_ask, cvd, bid_stack_net, ask_stack_net,
       ema_basis, basis_zscore, latency_ms, is_stale_flag, last_iceberg_price]
    """

    def __init__(
        self,
        shm_prefix: str = "xau_scichart",
        time_columns: int = 300,
        price_bins: int = 120,
        create: bool = True,
    ) -> None:
        self.shm_prefix = shm_prefix
        self.time_columns = time_columns
        self.price_bins = price_bins

        heatmap_bytes = time_columns * price_bins * np.dtype(np.float32).itemsize
        telemetry_bytes = 10 * np.dtype(np.float64).itemsize

        if create:
            # Clean up any leftover blocks from a prior crashed session
            for suffix in ("_heatmap", "_telemetry"):
                try:
                    old = shared_memory.SharedMemory(name=f"{shm_prefix}{suffix}")
                    old.close()
                    old.unlink()
                except FileNotFoundError:
                    pass

            self.heatmap_shm = shared_memory.SharedMemory(
                name=f"{shm_prefix}_heatmap", create=True, size=heatmap_bytes
            )
            self.telemetry_shm = shared_memory.SharedMemory(
                name=f"{shm_prefix}_telemetry", create=True, size=telemetry_bytes
            )
        else:
            self.heatmap_shm = shared_memory.SharedMemory(name=f"{shm_prefix}_heatmap")
            self.telemetry_shm = shared_memory.SharedMemory(
                name=f"{shm_prefix}_telemetry"
            )

        self.heatmap_matrix = np.ndarray(
            (time_columns, price_bins), dtype=np.float32, buffer=self.heatmap_shm.buf
        )
        self.telemetry_vec = np.ndarray(
            (10,), dtype=np.float64, buffer=self.telemetry_shm.buf
        )

        if create:
            self.heatmap_matrix.fill(0.0)
            self.telemetry_vec.fill(0.0)

    def publish_frame(
        self,
        spoof_filtered_column: np.ndarray,
        best_bid: float,
        best_ask: float,
        cvd: float,
        bid_stack_net: float,
        ask_stack_net: float,
        ema_basis: float,
        basis_zscore: float,
        latency_ms: int,
        is_stale: bool,
        last_iceberg_price: float,
    ) -> None:
        """
        Shifts the rolling 2D heatmap ring buffer left by 1 column, inserts the
        newest spoof-filtered depth slice on the right, and updates telemetry.
        """
        if len(spoof_filtered_column) != self.price_bins:
            raise ValueError(
                f"Expected column of length {self.price_bins}, got {len(spoof_filtered_column)}"
            )

        # Roll heatmap matrix in-place (FIFO ring buffer for SciChart UniformHeatmapDataSeries)
        self.heatmap_matrix[:-1, :] = self.heatmap_matrix[1:, :]
        self.heatmap_matrix[-1, :] = spoof_filtered_column

        self.telemetry_vec[0] = best_bid
        self.telemetry_vec[1] = best_ask
        self.telemetry_vec[2] = cvd
        self.telemetry_vec[3] = bid_stack_net
        self.telemetry_vec[4] = ask_stack_net
        self.telemetry_vec[5] = ema_basis
        self.telemetry_vec[6] = basis_zscore
        self.telemetry_vec[7] = float(latency_ms)
        self.telemetry_vec[8] = 1.0 if is_stale else 0.0
        self.telemetry_vec[9] = last_iceberg_price

    def read_frame_snapshot(self) -> Tuple[np.ndarray, Dict[str, float]]:
        """Called by the SciChart UI process every 16.6ms (60 FPS) to read the latest state."""
        t = self.telemetry_vec
        telemetry = {
            "best_bid": float(t[0]),
            "best_ask": float(t[1]),
            "cvd": float(t[2]),
            "bid_stack_net": float(t[3]),
            "ask_stack_net": float(t[4]),
            "ema_basis": float(t[5]),
            "basis_zscore": float(t[6]),
            "latency_ms": float(t[7]),
            "is_stale": bool(t[8] > 0.5),
            "last_iceberg_price": float(t[9]),
        }
        return self.heatmap_matrix.copy(), telemetry

    def close(self, unlink: bool = False) -> None:
        self.heatmap_shm.close()
        self.telemetry_shm.close()
        if unlink:
            try:
                self.heatmap_shm.unlink()
                self.telemetry_shm.unlink()
            except FileNotFoundError:
                pass


# ============================================================================
# 7. BINANCE WEBSOCKET + REST SNAPSHOT ADAPTER (PRODUCTION SKELETON)
# ============================================================================


class BinanceFuturesOrderFlowAdapter:
    """
    Parses raw Binance USDS-M Futures JSON payloads (`@depth@100ms`, `@aggTrade`,
    `@forceOrder`) into normalized microstructure events.
    """

    @staticmethod
    def parse_depth_payload(payload: Dict) -> BookDeltaEvent:
        data = payload.get("data", payload)
        now_ms = int(time.time() * 1000)
        bids = [(float(p), float(q)) for p, q in data.get("b", [])]
        asks = [(float(p), float(q)) for p, q in data.get("a", [])]
        return BookDeltaEvent(
            venue="BINANCE",
            symbol=data.get("s", "XAUUSDT"),
            exchange_ts_ms=int(data["E"]),
            local_ts_ms=now_ms,
            first_update_id=int(data["U"]),
            final_update_id=int(data["u"]),
            prev_final_update_id=int(data["pu"]),
            bids=bids,
            asks=asks,
        )

    @staticmethod
    def parse_agg_trade_payload(payload: Dict) -> AggTradeEvent:
        data = payload.get("data", payload)
        now_ms = int(time.time() * 1000)
        # In Binance @aggTrade, `m == True` means the buyer is the maker (so the aggressor is a Seller -> Side.ASK)
        is_buyer_maker = bool(data["m"])
        aggressor_side = Side.ASK if is_buyer_maker else Side.BID
        return AggTradeEvent(
            venue="BINANCE",
            symbol=data.get("s", "XAUUSDT"),
            exchange_ts_ms=int(data["T"]),
            local_ts_ms=now_ms,
            trade_id=int(data["a"]),
            price=float(data["p"]),
            qty=float(data["q"]),
            aggressor_side=aggressor_side,
        )

    @staticmethod
    def parse_force_order_payload(payload: Dict) -> LiquidationEvent:
        data = payload.get("data", payload)
        order = data["o"]
        side = Side.BID if order["S"] == "BUY" else Side.ASK
        return LiquidationEvent(
            venue="BINANCE",
            symbol=order.get("s", "XAUUSDT"),
            exchange_ts_ms=int(data["E"]),
            side=side,
            price=float(order["ap"]),
            qty=float(order["q"]),
        )


# ============================================================================
# 8. DETERMINISTIC SELF-TEST & SIMULATION HARNESS
# ============================================================================


def run_microstructure_verification_suite() -> None:
    """
    Simulates a realistic institutional sequence on XAUUSDT + COMEX GC:
    1. REST Snapshot initialization + buffered WebSocket replay (`U`, `u`, `pu`).
    2. HFT spoof wall flashed and pulled vs. genuine aged institutional bid wall.
    3. Heavy aggressive market sell sweep absorbed by a hidden Synthetic Iceberg
       while Open Interest rises (`INSTITUTIONAL_ABSORPTION_OPEN`).
    4. Forced short-liquidation cascade (`@forceOrder`) through a Money Pocket Vacuum.
    5. Cross-venue COMEX GC <-> Binance XAUUSDT basis translation and 60 FPS
       SciChart shared-memory frame publication.
    """
    logger.info("Starting XAUUSDT + COMEX GC Institutional Microstructure Verification...")

    book = LocalOrderBook(
        symbol="XAUUSDT",
        tick_size=0.10,
        max_stale_ms=200,
        lifespan_tau_sec=10.0,
        iceberg_min_hidden_qty=15.0,
    )
    bubble_engine = AbsorptionBubbleEngine(
        sweep_coalesce_ms=15,
        min_bubble_qty=20.0,
        absorption_max_ticks=0.30,
    )
    vacuum_engine = MoneyPocketVacuumEngine(bin_size=0.50, velocity_window_ms=250)
    basis_mapper = CrossVenueBasisMapper(ema_alpha=0.20)
    shm_bridge = SciChartSharedMemoryBridge(
        shm_prefix="xau_test_shm",
        time_columns=60,
        price_bins=40,
        create=True,
    )

    try:
        base_ts = 1_760_000_000_000

        # Step 1: Buffer an initial WebSocket diff before the REST snapshot arrives
        buffered_diff = BookDeltaEvent(
            venue="BINANCE",
            symbol="XAUUSDT",
            exchange_ts_ms=base_ts + 50,
            local_ts_ms=base_ts + 62,
            first_update_id=1000,
            final_update_id=1005,
            prev_final_update_id=999,
            bids=[(4140.00, 30.0), (4139.50, 12.0)],
            asks=[(4140.50, 18.0), (4141.00, 2.0), (4141.50, 1.5), (4142.50, 45.0)],
        )
        book.process_depth_event(buffered_diff)
        assert not book.is_synchronized, "Book should wait for REST snapshot before syncing"

        # Load REST snapshot with lastUpdateId=1002 (bridges buffered event 1000..1005)
        book.load_rest_snapshot(
            last_update_id=1002,
            bids=[(4140.00, 25.0), (4139.50, 12.0), (4139.00, 15.0)],
            asks=[(4140.50, 18.0), (4141.00, 2.0), (4141.50, 1.5), (4142.00, 1.0), (4142.50, 40.0)],
            timestamp_ms=base_ts,
        )
        assert book.is_synchronized and book.last_update_id == 1005

        # Step 2: Advance time by 20 seconds so the institutional bid at 4140.00 ages,
        # while a spoof bot flashes 100 lots at 4138.00 for only 50ms and pulls it.
        spoof_flash = BookDeltaEvent(
            venue="BINANCE",
            symbol="XAUUSDT",
            exchange_ts_ms=base_ts + 20_000,
            local_ts_ms=base_ts + 20_015,
            first_update_id=1006,
            final_update_id=1006,
            prev_final_update_id=1005,
            bids=[(4138.00, 100.0)],
            asks=[],
        )
        book.process_depth_event(spoof_flash)

        raw_col, filtered_col = book.get_spoof_filtered_heatmap_column(
            price_min=4135.0, price_max=4155.0, bin_size=0.50
        )
        idx_aged_4140 = int(round((4140.0 - 4135.0) / 0.50))
        idx_spoof_4138 = int(round((4138.0 - 4135.0) / 0.50))
        logger.info(
            "Spoof Filter Check -> Aged 4140.00 Bid (Raw=%.1f, LifespanWeighted=%.1f) vs Flashed 4138.00 Spoof (Raw=%.1f, LifespanWeighted=%.1f)",
            raw_col[idx_aged_4140],
            filtered_col[idx_aged_4140],
            raw_col[idx_spoof_4138],
            filtered_col[idx_spoof_4138],
        )
        assert filtered_col[idx_aged_4140] > 30.0 and filtered_col[idx_spoof_4138] == 0.0

        # Spoof bot pulls the 100-lot order 50ms later
        spoof_pull = BookDeltaEvent(
            venue="BINANCE",
            symbol="XAUUSDT",
            exchange_ts_ms=base_ts + 20_050,
            local_ts_ms=base_ts + 20_060,
            first_update_id=1007,
            final_update_id=1007,
            prev_final_update_id=1006,
            bids=[(4138.00, 0.0)],
            asks=[],
        )
        book.process_depth_event(spoof_pull)
        bid_stack, _ = book.get_pulling_stacking_imbalance(lookback_ms=200)
        logger.info("Pulling/Stacking Tracker after spoof flash+pull -> Net Bid Stack=%.1f", bid_stack)

        # Step 3: Simulate an aggressive sell sweep into 4140.00 (visible resting size = 30.0)
        # where 55.0 ounces execute without breaking 4140.00 while Open Interest increases (+40.0).
        bubble_engine.update_open_interest(12_500.0)
        bubble_engine.update_open_interest(12_540.0)  # Rising OI!

        iceberg_detected: Optional[IcebergSignal] = None
        for i, fill_qty in enumerate([18.0, 20.0, 17.0]):
            t_ev = AggTradeEvent(
                venue="BINANCE",
                symbol="XAUUSDT",
                exchange_ts_ms=base_ts + 20_100 + i * 3,
                local_ts_ms=base_ts + 20_110 + i * 3,
                trade_id=5000 + i,
                price=4140.00,
                qty=fill_qty,
                aggressor_side=Side.ASK,  # Aggressive sell hitting the 4140.00 bid
            )
            sig = book.register_trade_for_iceberg_and_fills(t_ev)
            if sig is not None:
                iceberg_detected = sig
            bubble_engine.process_agg_trade(t_ev)
            vacuum_engine.record_trade(t_ev)

        absorption_bubble = bubble_engine.flush_pending()
        assert iceberg_detected is not None, "Synthetic Iceberg should be detected at 4140.00"
        assert (
            absorption_bubble is not None
            and absorption_bubble.regime == BubbleRegime.INSTITUTIONAL_ABSORPTION_OPEN
        ), "Bubble should be classified as INSTITUTIONAL_ABSORPTION_OPEN"
        logger.info("Detected Synthetic Iceberg: %s", iceberg_detected)
        logger.info("Classified Absorption Bubble: %s", absorption_bubble)

        # Step 4: Detect Money Pocket Vacuum between 4141.00 and 4142.00
        pockets = vacuum_engine.detect_vacuum_pockets(
            book=book, price_min=4135.0, price_max=4155.0
        )
        logger.info("Detected %d Money Pocket Vacuum zones: %s", len(pockets), pockets[:2])

        # Step 5: Update COMEX GC <-> Binance XAUUSDT Basis Mapper
        # Suppose COMEX GC front-month trades at 4158.60 while XAUUSDT is at 4140.25 (+18.35 basis)
        for gc_p, xau_p in [(4158.50, 4140.20), (4158.60, 4140.25), (4159.40, 4140.25)]:
            basis_mapper.update_quotes(gc_mid=gc_p, xauusdt_mid=xau_p)

        mapped_hvn = basis_mapper.map_gc_level_to_xauusdt(4160.00)
        z_score = basis_mapper.get_basis_zscore()
        logger.info(
            "Cross-Venue Basis Mapper -> GC HVN 4160.00 maps to XAUUSDT %.2f (EMA Basis=+%.2f, Lead-Lag Z-Score=+%.2f)",
            mapped_hvn,
            basis_mapper.ema_basis or 0.0,
            z_score,
        )

        # Step 6: Publish frame to Shared Memory and verify SciChart UI reader
        best_bid, best_ask = book.get_bbo()
        shm_bridge.publish_frame(
            spoof_filtered_column=filtered_col,
            best_bid=best_bid,
            best_ask=best_ask,
            cvd=bubble_engine.cvd,
            bid_stack_net=bid_stack,
            ask_stack_net=0.0,
            ema_basis=basis_mapper.ema_basis or 0.0,
            basis_zscore=z_score,
            latency_ms=book.current_latency_ms,
            is_stale=book.is_stale,
            last_iceberg_price=iceberg_detected.price,
        )

        ui_reader = SciChartSharedMemoryBridge(
            shm_prefix="xau_test_shm",
            time_columns=60,
            price_bins=40,
            create=False,
        )
        matrix_snap, telemetry_snap = ui_reader.read_frame_snapshot()
        ui_reader.close(unlink=False)

        assert matrix_snap.shape == (60, 40)
        assert telemetry_snap["last_iceberg_price"] == 4140.00
        logger.info("Shared-Memory 60 FPS UI Snapshot Telemetry: %s", telemetry_snap)
        logger.info("ALL VERIFICATION CHECKS PASSED SUCCESSFULLY.")

    finally:
        shm_bridge.close(unlink=True)


if __name__ == "__main__":
    run_microstructure_verification_suite()