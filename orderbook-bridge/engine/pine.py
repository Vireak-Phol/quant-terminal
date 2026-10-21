"""
Pine Script v6 runtime primitives, incremental (one call per confirmed bar).

Every class mirrors a Pine built-in closely enough for bar-for-bar parity with the
TradingView implementation of OSC-VIP / REG v7.4. ``None`` plays the role of Pine ``na``.

Conventions
-----------
* ``update(x)`` is called exactly once per bar, in bar order, and returns the value
  for *this* bar (so ``x[0]`` in Pine terms).
* Rolling windows return ``None`` until the window is full or while any element in
  the window is ``None`` (strict-na semantics).
"""

from __future__ import annotations

import math
from collections import deque
from typing import Deque, Iterable, List, Optional, Sequence

Num = Optional[float]


def nz(x: Num, default: float = 0.0) -> float:
    if x is None:
        return default
    if isinstance(x, float) and math.isnan(x):
        return default
    return x


def is_na(x: Num) -> bool:
    return x is None or (isinstance(x, float) and math.isnan(x))


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


class Hist:
    """Series history with Pine-style ``[k]`` lookback (``h[0]`` = current bar)."""

    __slots__ = ("_d",)

    def __init__(self, maxlen: int = 600):
        self._d: Deque[Num] = deque(maxlen=maxlen)

    def push(self, x: Num) -> Num:
        self._d.appendleft(x)
        return x

    def __getitem__(self, k: int) -> Num:
        if k < len(self._d):
            return self._d[k]
        return None

    def __len__(self) -> int:
        return len(self._d)

    def window(self, n: int) -> Optional[List[Num]]:
        if len(self._d) < n:
            return None
        return [self._d[i] for i in range(n)]


class Rolling:
    """Fixed-length window with O(1) sum and sum of squares (periodically re-summed)."""

    __slots__ = ("n", "buf", "na_count", "s1", "s2", "_since")

    def __init__(self, n: int):
        self.n = n
        self.buf: Deque[Num] = deque()
        self.na_count = 0
        self.s1 = 0.0
        self.s2 = 0.0
        self._since = 0

    def push(self, x: Num) -> None:
        self.buf.append(x)
        if is_na(x):
            self.na_count += 1
        else:
            self.s1 += x
            self.s2 += x * x
        if len(self.buf) > self.n:
            old = self.buf.popleft()
            if is_na(old):
                self.na_count -= 1
            else:
                self.s1 -= old
                self.s2 -= old * old
        self._since += 1
        if self._since >= 512:  # bound floating drift
            self._since = 0
            vals = [v for v in self.buf if not is_na(v)]
            self.s1 = math.fsum(vals)
            self.s2 = math.fsum(v * v for v in vals)

    @property
    def ready(self) -> bool:
        return len(self.buf) == self.n and self.na_count == 0


class SMA:
    def __init__(self, n: int):
        self.r = Rolling(n)

    def update(self, x: Num) -> Num:
        self.r.push(x)
        if not self.r.ready:
            return None
        return self.r.s1 / self.r.n


class Sum:
    """``math.sum(x, n)``."""

    def __init__(self, n: int):
        self.r = Rolling(n)

    def update(self, x: Num) -> Num:
        self.r.push(x)
        if not self.r.ready:
            return None
        return self.r.s1


class Stdev:
    """``ta.stdev(x, n)`` — population (biased) standard deviation, like Pine's default."""

    def __init__(self, n: int):
        self.r = Rolling(n)

    def update(self, x: Num) -> Num:
        self.r.push(x)
        if not self.r.ready:
            return None
        n = self.r.n
        mean = self.r.s1 / n
        var = self.r.s2 / n - mean * mean
        if var <= 1e-12 * max(1.0, abs(mean) ** 2):
            # Pine's stdev uses an "isZero" guard on each squared deviation; for
            # numerically flat windows return an exact recomputation.
            vals = list(self.r.buf)
            var = math.fsum((v - mean) ** 2 for v in vals) / n
        return math.sqrt(max(var, 0.0))


class RMA:
    """``ta.rma`` — Wilder smoothing seeded with the SMA of the first ``n`` values."""

    def __init__(self, n: int):
        self.n = n
        self.alpha = 1.0 / n
        self.seed: List[float] = []
        self.value: Num = None

    def update(self, x: Num) -> Num:
        if self.value is None:
            if is_na(x):
                return None
            self.seed.append(x)
            if len(self.seed) < self.n:
                return None
            self.value = sum(self.seed) / self.n
            return self.value
        if is_na(x):
            return self.value
        self.value = self.alpha * x + (1 - self.alpha) * self.value
        return self.value


class EMA:
    """``ta.ema`` — seeded with the SMA of the first ``n`` values (Pine v5/v6 behaviour)."""

    def __init__(self, n: int):
        self.n = n
        self.alpha = 2.0 / (n + 1)
        self.seed: List[float] = []
        self.value: Num = None

    def update(self, x: Num) -> Num:
        if self.value is None:
            if is_na(x):
                return None
            self.seed.append(x)
            if len(self.seed) < self.n:
                return None
            self.value = sum(self.seed) / self.n
            return self.value
        if is_na(x):
            return self.value
        self.value = self.alpha * x + (1 - self.alpha) * self.value
        return self.value


class TrueRange:
    """``ta.tr(handle_na)``; with ``handle_na=True`` the first bar returns high-low."""

    def __init__(self, handle_na: bool = True):
        self.prev_close: Num = None
        self.handle_na = handle_na

    def update(self, h: float, l: float, c: float) -> Num:
        if self.prev_close is None:
            tr = (h - l) if self.handle_na else None
        else:
            tr = max(h - l, abs(h - self.prev_close), abs(l - self.prev_close))
        self.prev_close = c
        return tr


class ATR:
    """``ta.atr(n)`` = ``ta.rma(ta.tr(true), n)``."""

    def __init__(self, n: int):
        self.tr = TrueRange(True)
        self.rma = RMA(n)
        self.last_tr: Num = None

    def update(self, h: float, l: float, c: float) -> Num:
        self.last_tr = self.tr.update(h, l, c)
        return self.rma.update(self.last_tr)


class Highest:
    def __init__(self, n: int):
        self.n = n
        self.buf: Deque[float] = deque(maxlen=n)

    def update(self, x: float) -> Num:
        self.buf.append(x)
        if len(self.buf) < self.n:
            return None
        return max(self.buf)


class Lowest:
    def __init__(self, n: int):
        self.n = n
        self.buf: Deque[float] = deque(maxlen=n)

    def update(self, x: float) -> Num:
        self.buf.append(x)
        if len(self.buf) < self.n:
            return None
        return min(self.buf)


class Correlation:
    """``ta.correlation(a, b, n)`` — Pearson over the last ``n`` bars."""

    def __init__(self, n: int):
        self.n = n
        self.a: Deque[Num] = deque()
        self.b: Deque[Num] = deque()
        self.na = 0
        self.sa = self.sb = self.saa = self.sbb = self.sab = 0.0
        self._since = 0

    def _add(self, x: Num, y: Num, sign: float) -> None:
        if is_na(x) or is_na(y):
            self.na += 1 if sign > 0 else -1
            return
        self.sa += sign * x
        self.sb += sign * y
        self.saa += sign * x * x
        self.sbb += sign * y * y
        self.sab += sign * x * y

    def update(self, x: Num, y: Num) -> Num:
        self.a.append(x)
        self.b.append(y)
        self._add(x, y, 1.0)
        if len(self.a) > self.n:
            self._add(self.a.popleft(), self.b.popleft(), -1.0)
        self._since += 1
        if self._since >= 256:
            self._since = 0
            self.sa = self.sb = self.saa = self.sbb = self.sab = 0.0
            self.na = 0
            for p, q in zip(self.a, self.b):
                self._add(p, q, 1.0)
        if len(self.a) < self.n or self.na > 0:
            return None
        n = self.n
        cov = self.sab / n - (self.sa / n) * (self.sb / n)
        va = self.saa / n - (self.sa / n) ** 2
        vb = self.sbb / n - (self.sb / n) ** 2
        if va <= 1e-18 or vb <= 1e-18:
            return None
        return cov / math.sqrt(va * vb)


class Pivot:
    """``ta.pivothigh/pivotlow(src, left, right)``.

    Returns the pivot value on the bar ``right`` bars after it formed (no repaint).
    TradingView semantics (verified bar-for-bar against the parity fixture): the centre
    must be greater-or-equal (lower-or-equal) than every bar on the left and *strictly*
    greater (lower) than every bar on the right.
    """

    def __init__(self, left: int, right: int, high: bool):
        self.left = left
        self.right = right
        self.high = high
        self.buf: Deque[float] = deque(maxlen=left + right + 1)

    def update(self, x: float) -> Num:
        self.buf.append(x)
        if len(self.buf) < self.left + self.right + 1:
            return None
        vals = list(self.buf)
        c = vals[self.left]
        lefts = vals[: self.left]
        rights = vals[self.left + 1:]
        if self.high:
            ok = all(c >= v for v in lefts) and all(c > v for v in rights)
        else:
            ok = all(c <= v for v in lefts) and all(c < v for v in rights)
        return c if ok else None


def wilson_interval(wins: float, total: float, z: float = 1.96) -> tuple:
    """Wilson score interval in percent — identical to OSC ``f_lgWilson``."""
    if total <= 0:
        return (0.0, 0.0)
    phat = wins / total
    denom = 1.0 + z * z / total
    center = (phat + z * z / (2.0 * total)) / denom
    margin = z * math.sqrt(max(phat * (1.0 - phat) / total + z * z / (4.0 * total * total), 0.0)) / denom
    return (max((center - margin) * 100.0, 0.0), min((center + margin) * 100.0, 100.0))


def mean(xs: Iterable[float]) -> float:
    xs = list(xs)
    return sum(xs) / len(xs) if xs else 0.0
