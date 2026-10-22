"""
Bubble Regime Engine — Open-Interest + liquidation classifier for aggressive sweeps.

ATAS-style idea: reconstruct a single-taker multi-level sweep across a tight
millisecond window, then cross-reference Open Interest (OI) delta and
`@forceOrder` liquidation prints to classify *why* the volume happened:

    standard_flow                  default / unremarkable aggression
    institutional_absorption_open  price HELD inside a tight band while OI ROSE
                                   (fresh passive limit absorption opening risk)
    liquidation_exhaustion_flush   forced-liquidation volume + OI DROPPING
                                   (positions being closed, not opened)
    vacuum_sweep_breakout          price ripped >= 1.00 USD through thin book

This is the net-new capability versus the existing :class:`AbsorptionEngine`
(which is candle/window + Bayesian confidence based and carries no OI or
liquidation context). It deliberately follows the repo conventions:

    * aggressor sides are the strings "buy" / "sell" (never an IntEnum)
    * regimes are lowercase string constants (JSON-friendly, no IntEnum)
    * every emitted signal exposes :meth:`to_dict` for the bridge
    * pure-Python, deterministic, side-effect-free, unit-tested

It does NOT re-implement the local order book; feed it the already-normalised
trade / liquidation / OI stream the bridge produces.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Any, Deque, Dict, List, Optional

import logging

logger = logging.getLogger("BubbleRegimeEngine")


# Regime string constants (JSON-friendly; mirrors repo's string-side convention).
REGIME_STANDARD_FLOW = "standard_flow"
REGIME_INSTITUTIONAL_ABSORPTION_OPEN = "institutional_absorption_open"
REGIME_LIQUIDATION_EXHAUSTION_FLUSH = "liquidation_exhaustion_flush"
REGIME_VACUUM_SWEEP_BREAKOUT = "vacuum_sweep_breakout"


@dataclass
class Liquidation:
    """A normalised forced-liquidation print (Binance @forceOrder)."""

    timestamp_ms: int
    side: str        # "buy" | "sell" — aggressor side of the forced market order
    price: float
    qty: float


@dataclass
class BubbleSignal:
    """An aggressive sweep enriched with OI delta, liquidation qty, and regime."""

    timestamp_ms: int
    price_center: float      # volume-weighted average sweep price
    aggressor_side: str      # "buy" | "sell"
    total_qty: float
    sweep_ticks: float       # price span of the sweep (max - min), in USD
    oi_delta: float          # latest_oi - prev_oi at flush time
    liquidation_qty: float   # matching forced-liquidation volume near the sweep
    regime: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": "bubble_regime",
            "timestamp": self.timestamp_ms,
            "priceCenter": str(round(self.price_center, 2)),
            "aggressorSide": self.aggressor_side,
            "totalQuantity": str(round(self.total_qty, 3)),
            "sweepTicks": round(self.sweep_ticks, 2),
            "oiDelta": round(self.oi_delta, 3),
            "liquidationQuantity": str(round(self.liquidation_qty, 3)),
            "regime": self.regime,
        }


class BubbleRegimeEngine:
    """Coalesce consecutive same-side aggressive fills into a classified bubble.

    Feed the engine with:
        * :meth:`update_open_interest` whenever a fresh OI reading arrives,
        * :meth:`record_liquidation` for each @forceOrder print,
        * :meth:`process_trade` for each executed aggressor trade.

    A :class:`BubbleSignal` is emitted exactly once when a sweep completes (i.e.
    the aggressor side flips or the coalesce window lapses). Call
    :meth:`flush_pending` to force-emit a trailing sweep (e.g. on shutdown).
    """

    def __init__(
        self,
        sweep_coalesce_ms: int = 12,
        min_bubble_qty: float = 25.0,
        absorption_max_ticks: float = 0.30,
        breakout_min_ticks: float = 1.00,
        liquidation_match_ms: int = 500,
        liquidation_qty_frac: float = 0.15,
        retention: int = 500,
    ) -> None:
        self.sweep_coalesce_ms = sweep_coalesce_ms
        self.min_bubble_qty = min_bubble_qty
        self.absorption_max_ticks = absorption_max_ticks
        self.breakout_min_ticks = breakout_min_ticks
        self.liquidation_match_ms = liquidation_match_ms
        self.liquidation_qty_frac = liquidation_qty_frac

        # Active sweep accumulator.
        self._active_side: Optional[str] = None
        self._active_start_ts: int = 0
        self._active_prices: List[float] = []
        self._active_qtys: List[float] = []

        # OI + liquidation context.
        self.recent_liquidations: Deque[Liquidation] = deque(maxlen=retention)
        self.latest_oi: float = 0.0
        self.prev_oi: float = 0.0
        self._has_oi: bool = False

        # Session cumulative volume delta + emitted signal ring buffer.
        self.cvd: float = 0.0
        self.emitted: Deque[BubbleSignal] = deque(maxlen=retention)

    # ── context feeds ─────────────────────────────────────────────────────────
    def update_open_interest(self, new_oi: float) -> None:
        # Ignore uninitialised / non-advancing readings. REST OI polls arrive
        # every ~15s but `process_trade` fans the same value across thousands of
        # trades; advancing `prev_oi` on every identical reading would collapse
        # `oi_delta` to 0.0 within a millisecond (Audit #2) and a cold-boot 0.0
        # reading would anchor a phantom spike on the first real poll (Audit #7).
        if new_oi <= 0 or new_oi == self.latest_oi:
            return
        if self._has_oi:
            self.prev_oi = self.latest_oi
        else:
            # First real reading: anchor prev to itself so the first delta is 0.
            self.prev_oi = new_oi
            self._has_oi = True
        self.latest_oi = new_oi

    def record_liquidation(self, liq: Liquidation) -> None:
        self.recent_liquidations.append(liq)

    # ── trade ingestion ───────────────────────────────────────────────────────
    def process_trade(
        self, price: float, qty: float, aggressor_side: str, timestamp_ms: int
    ) -> Optional[BubbleSignal]:
        """Accumulate consecutive same-side fills; emit the prior sweep when it ends."""
        if aggressor_side not in ("buy", "sell"):
            raise ValueError(f"aggressor_side must be 'buy' or 'sell', got {aggressor_side!r}")

        # Session CVD: buy aggression is positive, sell aggression negative.
        self.cvd += qty if aggressor_side == "buy" else -qty

        if (
            self._active_side == aggressor_side
            and (timestamp_ms - self._active_start_ts) <= self.sweep_coalesce_ms
        ):
            self._active_prices.append(price)
            self._active_qtys.append(qty)
            return None

        # Side flipped or window lapsed → flush the previous sweep, start a new one.
        emitted = self._flush_active_sweep()
        self._active_side = aggressor_side
        self._active_start_ts = timestamp_ms
        self._active_prices = [price]
        self._active_qtys = [qty]
        return emitted

    def flush_pending(self) -> Optional[BubbleSignal]:
        """Force-emit any trailing sweep (e.g. at shutdown)."""
        return self._flush_active_sweep()

    # ── classification ─────────────────────────────────────────────────────────
    def _flush_active_sweep(self) -> Optional[BubbleSignal]:
        if not self._active_qtys or self._active_side is None:
            return None

        total_qty = sum(self._active_qtys)
        if total_qty < self.min_bubble_qty:
            self._active_qtys.clear()
            self._active_prices.clear()
            return None

        vwap = sum(p * q for p, q in zip(self._active_prices, self._active_qtys)) / total_qty
        sweep_ticks = max(self._active_prices) - min(self._active_prices)
        oi_delta = self.latest_oi - self.prev_oi

        # Sum forced liquidations on the same side within the match window.
        liq_qty = sum(
            l.qty
            for l in self.recent_liquidations
            if abs(l.timestamp_ms - self._active_start_ts) <= self.liquidation_match_ms
            and l.side == self._active_side
        )

        regime = self._classify(total_qty, sweep_ticks, oi_delta, liq_qty)

        signal = BubbleSignal(
            timestamp_ms=self._active_start_ts,
            price_center=round(vwap, 2),
            aggressor_side=self._active_side,
            total_qty=round(total_qty, 3),
            sweep_ticks=round(sweep_ticks, 2),
            oi_delta=round(oi_delta, 3),
            liquidation_qty=round(liq_qty, 3),
            regime=regime,
        )
        self.emitted.append(signal)

        self._active_qtys.clear()
        self._active_prices.clear()
        return signal

    def _classify(
        self, total_qty: float, sweep_ticks: float, oi_delta: float, liq_qty: float
    ) -> str:
        # Forced liquidations closing positions: heavy liq share + OI falling.
        if liq_qty > self.liquidation_qty_frac * total_qty and oi_delta < 0:
            return REGIME_LIQUIDATION_EXHAUSTION_FLUSH
        # Fresh limit absorption: price held in a tight band while OI rose/flat.
        if sweep_ticks <= self.absorption_max_ticks and oi_delta >= 0:
            return REGIME_INSTITUTIONAL_ABSORPTION_OPEN
        # Vacuum breakout: price ripped a long way through thin book.
        if sweep_ticks >= self.breakout_min_ticks:
            return REGIME_VACUUM_SWEEP_BREAKOUT
        return REGIME_STANDARD_FLOW

    # ── queries ─────────────────────────────────────────────────────────────────
    def recent_signals(self) -> List[BubbleSignal]:
        return list(self.emitted)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "cvd": round(self.cvd, 3),
            "open_interest": round(self.latest_oi, 3),
            "oi_delta": round(self.latest_oi - self.prev_oi, 3),
            "bubbles": [s.to_dict() for s in self.emitted],
        }
