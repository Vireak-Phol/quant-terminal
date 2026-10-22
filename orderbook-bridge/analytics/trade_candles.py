"""
Trade-price candle aggregator with volume, delta, and cumulative volume delta (CVD).

Institutional desks anchor order-flow analysis on *transacted* prices, not mid-price:
a candle built from trades carries true volume, and the signed aggressor imbalance
(buy volume − sell volume) is the single most predictive short-horizon feature.

This module turns the raw Binance aggTrade stream into fixed-interval OHLCV bars plus:

    delta        per-bucket signed volume  (buy − sell, in oz)
    cvd          running cumulative sum of delta, session-anchored at 00:00 UTC
    buy_volume   aggressor-buy volume in the bucket
    sell_volume  aggressor-sell volume in the bucket

CVD session anchoring matters: without a reset, CVD drifts arbitrarily over multi-day
runs and cross-session comparisons become meaningless. 00:00 UTC aligns with the
Binance trading day boundary and the v7.4 ledger day boundary.

Deterministic, side-effect-free, and unit-tested.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass
class TradeCandle:
    """One closed or forming trade-price bar."""

    t: int          # bucket open time, epoch ms
    o: float
    h: float
    l: float
    c: float
    volume: float   # total transacted oz in the bucket
    delta: float    # signed (buy − sell) oz
    buy_volume: float
    sell_volume: float
    closed: bool    # True only when the bucket has rolled

    def to_dict(self) -> Dict[str, Any]:
        return {
            "t": self.t,
            "o": round(self.o, 2),
            "h": round(self.h, 2),
            "l": round(self.l, 2),
            "c": round(self.c, 2),
            "v": round(self.volume, 3),
            "d": round(self.delta, 3),
            "bv": round(self.buy_volume, 3),
            "sv": round(self.sell_volume, 3),
            "closed": self.closed,
        }


class TradeCandleAggregator:
    """Aggregate an aggressor-side trade stream into OHLCV + delta bars.

    Feed each executed trade via :meth:`ingest`. Returns a *closed* :class:`TradeCandle`
    exactly once per bucket boundary (None on same-bucket updates). Query the still-
    forming bucket with :meth:`forming`, and the running CVD with :meth:`cvd`.

    Session anchor: CVD resets at 00:00 UTC (Binance trading day).
    """

    def __init__(self, interval_ms: int = 60_000, session_ms: int = 86_400_000):
        self.interval_ms = interval_ms
        self.session_ms = session_ms  # CVD reset window (1 day)
        self._bucket: Optional[int] = None
        self._o = self._h = self._l = self._c = 0.0
        self._vol = 0.0
        self._buy = 0.0
        self._sell = 0.0
        self._cvd = 0.0
        self._cvd_session: Optional[int] = None

    # ── CVD session anchoring ────────────────────────────────────────────────
    def _session_of(self, ts_ms: int) -> int:
        return (ts_ms // self.session_ms) * self.session_ms

    def ingest(self, price: float, qty: float, aggressor_side: str, ts_ms: int) -> Optional[TradeCandle]:
        """Ingest one trade. Returns the CLOSED candle when the bucket rolls, else None."""
        session = self._session_of(ts_ms)
        if self._cvd_session is None:
            self._cvd_session = session
        elif session != self._cvd_session:
            # New Binance day: reset CVD so today's delta is comparable to today's.
            self._cvd = 0.0
            self._cvd_session = session

        signed = qty if aggressor_side == "buy" else -qty
        self._cvd += signed

        bucket = (ts_ms // self.interval_ms) * self.interval_ms
        closed: Optional[TradeCandle] = None

        if self._bucket is None:
            self._bucket = bucket
            self._o = self._h = self._l = self._c = price
            self._vol = qty
            self._buy = qty if aggressor_side == "buy" else 0.0
            self._sell = qty if aggressor_side == "sell" else 0.0
            return None

        if bucket > self._bucket:
            closed = TradeCandle(
                t=self._bucket, o=self._o, h=self._h, l=self._l, c=self._c,
                volume=self._vol, delta=self._buy - self._sell,
                buy_volume=self._buy, sell_volume=self._sell, closed=True,
            )
            self._bucket = bucket
            self._o = self._h = self._l = self._c = price
            self._vol = qty
            self._buy = qty if aggressor_side == "buy" else 0.0
            self._sell = qty if aggressor_side == "sell" else 0.0
            return closed

        # Same bucket OR an out-of-order (late) trade whose bucket is < current.
        # Using `>` above (not `!=`) means a trade delayed by network jitter never
        # rewinds and prematurely re-closes the forming bar (which produced
        # duplicate, scrambled candles). We fold its volume/delta into the current
        # bucket; its OHLC still extends the running high/low. Close price is only
        # moved forward by in-order (same-bucket) trades to avoid a stale print
        # overwriting the latest close. (Audit #6)
        self._h = max(self._h, price)
        self._l = min(self._l, price)
        if bucket == self._bucket:
            self._c = price
        self._vol += qty
        if aggressor_side == "buy":
            self._buy += qty
        else:
            self._sell += qty
        return None

    # ── queries ──────────────────────────────────────────────────────────────
    def forming(self) -> Optional[TradeCandle]:
        """The still-forming (unclosed) bucket, or None before any trade."""
        if self._bucket is None:
            return None
        return TradeCandle(
            t=self._bucket, o=self._o, h=self._h, l=self._l, c=self._c,
            volume=self._vol, delta=self._buy - self._sell,
            buy_volume=self._buy, sell_volume=self._sell, closed=False,
        )

    def cvd(self) -> float:
        """Session-anchored cumulative volume delta (oz)."""
        return self._cvd

    def cvd_session_start(self) -> Optional[int]:
        return self._cvd_session
