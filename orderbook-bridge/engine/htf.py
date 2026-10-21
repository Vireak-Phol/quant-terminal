"""Higher-timeframe and cross-symbol alignment, matching Pine ``request.security`` semantics."""

from __future__ import annotations

import bisect
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from .osc_engine import HtfValues
from .pine import ATR, EMA, Highest, Lowest


class HtfTracker:
    """4H context for OSC §3: ``request.security(tf="240", [ema(close,200)[1], highest(high,50)[1],
    lowest(low,50)[1], atr(14)[1]], lookahead_on)``.

    For a chart bar inside 4H bar *k* this returns the values computed on 4H bar *k-1*
    (already closed) — no lookahead, identical live and in backtest.

    ``add_bar`` must be called with *closed* HTF bars in time order. ``bucket_seconds``
    gives a default fixed alignment (Binance 4H opens at 00/04/08/... UTC); when HTF bars
    are supplied explicitly their open times define the buckets (TradingView sessions).
    """

    def __init__(self, bucket_seconds: int = 14400):
        self.bucket_seconds = bucket_seconds
        self.ema = EMA(200)
        self.hi = Highest(50)
        self.lo = Lowest(50)
        self.atr = ATR(14)
        self.opens: List[int] = []
        self.values: List[HtfValues] = []

    def add_bar(self, t: int, o: float, h: float, l: float, c: float) -> None:
        if self.opens and t <= self.opens[-1]:
            return  # duplicate / out of order
        self.opens.append(t)
        self.values.append(HtfValues(self.ema.update(c), self.hi.update(h), self.lo.update(l), self.atr.update(h, l, c)))

    def bucket_of(self, t: int) -> int:
        """Open time of the HTF bucket containing chart time ``t``."""
        if self.opens:
            i = bisect.bisect_right(self.opens, t) - 1
            if i >= 0:
                last = self.opens[-1]
                # past the last known HTF open (bar not closed yet): step forward from the
                # last known open, preserving the feed's own bucket phase
                if i == len(self.opens) - 1 and t >= last + self.bucket_seconds:
                    return last + ((t - last) // self.bucket_seconds) * self.bucket_seconds
                return self.opens[i]
        return t - (t % self.bucket_seconds)

    def values_for(self, t: int) -> HtfValues:
        """Values of the last *closed* HTF bar strictly before the bucket containing ``t``."""
        b = self.bucket_of(t)
        i = bisect.bisect_left(self.opens, b) - 1
        if i < 0:
            return HtfValues(None, None, None, None)
        return self.values[i]


class AlignedSeries:
    """Cross-symbol close aligned to chart bars (``request.security`` with ``gaps_off``,
    ``lookahead_off``, same timeframe): the latest close whose bar open is <= chart open."""

    def __init__(self, bars: Sequence[Tuple[int, float]] = ()):
        self.t: List[int] = []
        self.v: List[float] = []
        for t, v in bars:
            self.add(t, v)

    def add(self, t: int, v: float) -> None:
        if self.t and t <= self.t[-1]:
            if t == self.t[-1]:
                self.v[-1] = v
            return
        self.t.append(t)
        self.v.append(v)

    def at(self, t: int) -> Optional[float]:
        i = bisect.bisect_right(self.t, t) - 1
        return self.v[i] if i >= 0 else None


def group_intrabars(chart_times: Sequence[int], tf_seconds: int, intrabars: Sequence[Sequence[float]]) -> Dict[int, List[Sequence[float]]]:
    """Map chart bar open -> list of intrabars (each starting with open time) inside it."""
    out: Dict[int, List[Sequence[float]]] = {}
    starts = list(chart_times)
    for ib in intrabars:
        t = int(ib[0])
        i = bisect.bisect_right(starts, t) - 1
        if i < 0:
            continue
        s = starts[i]
        if t < s + tf_seconds:
            out.setdefault(s, []).append(ib)
    return out
