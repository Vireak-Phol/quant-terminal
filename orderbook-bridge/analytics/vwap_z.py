"""
VWAP Z-Score Engine — Python port of the OSC-VIP v7.4 Pine VWAP microstructure block.

Why this beats a plain VWAP ± fixed-sigma band
-----------------------------------------------
A naive VWAP band assumes the price-vs-VWAP residual is Gaussian. Gold's residual
is skewed and fat-tailed, so a flat ±2σ band is *mispriced* — too tight in the tails
exactly when it matters (news, the London fix). This engine:

    * measures the residual ``price − VWAP`` and z-scores it over a rolling window,
    * floors σ at ``0.20 × ATR`` so a compressed tape cannot produce a degenerate z,
    * applies a **Cornish-Fisher expansion** that corrects the z-score for the
      residual's own skewness and excess kurtosis (the fat-tail adjustment),
    * guards the expansion (monotonic derivative + magnitude cap) so it can never
      blow up, falling back to the raw z when the CF transform is invalid,
    * clamps the final z to ±5 (matches OSC ``f_clampZ``).

Parity note
-----------
Mirrors OSC-VIP v7.4 (section "VWAP Mode Dynamic Reset & Calculation" and the
"Cornish-Fisher Z-Score" block). Unlike the Pine source — which feeds the band off
``hlc3`` and raw chart ``volume`` — this engine is driven by the bridge's TRUE
transacted trade candles (``TradeCandle.volume`` is real executed oz, not a tick
proxy), so the VWAP is a genuine volume-weighted transacted price.

Deterministic, operates on CLOSED bars only → never repaints.

Reference: pine-strategy/7.4/OSC-vip-v7-4-lite.pine
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from typing import Any, Deque, Dict, Optional

from engine.pine import ATR, SMA, clamp


# Cornish-Fisher quantile anchor. OSC expands around z_p = 1.0 (the +1σ quantile),
# so the band widths scale with the tail shape at the 1σ mark.
_Z_P = 1.0
# Final z clamp, matching OSC f_clampZ = max(min(x, 5.0), -5.0)
# (OSC-vip-v7-4-lite.pine:256). Bar-for-bar parity requires ±5, not ±4.
_Z_CLAMP = 5.0


@dataclass
class VwapZState:
    """A single closed-bar snapshot of the VWAP-Z engine."""

    vwap: Optional[float]
    z: Optional[float]           # Cornish-Fisher adjusted (or raw fallback) z-score
    raw_z: Optional[float]       # pre-CF z (for diagnostics / gross-vs-adjusted review)
    sigma: Optional[float]       # the floored residual stdev used for z
    sigma_adj: Optional[float]   # CF-scaled sigma used to draw the bands
    cf_valid: bool               # True when the CF transform was applied
    upper1: Optional[float]      # VWAP + 1 * sigma_adj        (±1σ guides)
    lower1: Optional[float]      # VWAP - 1 * sigma_adj
    # REG VWAP fib zones: the SUPPLY zone fills between +1.618σ and +2.618σ, the
    # DEMAND zone between -1.618σ and -2.618σ. These four edges reproduce REG's
    # filled band exactly (fill(pFibp2,pFibp1) / fill(pFibm2,pFibm1)).
    fib_upper1: Optional[float]  # VWAP + 1.618 * sigma_adj    (inner supply edge)
    fib_upper2: Optional[float]  # VWAP + 2.618 * sigma_adj    (outer supply edge)
    fib_lower1: Optional[float]  # VWAP - 1.618 * sigma_adj    (inner demand edge)
    fib_lower2: Optional[float]  # VWAP - 2.618 * sigma_adj    (outer demand edge)

    def to_dict(self) -> Dict[str, Any]:
        def r(x: Optional[float], n: int = 2) -> Optional[float]:
            # None-guard AND non-finite guard: a stray inf/NaN must never reach the
            # WS frame (the client's JSON.parse would reject Infinity/NaN and drop
            # the whole frame). Belt-and-suspenders with bridge.safe_json_dumps.
            if x is None or not math.isfinite(x):
                return None
            return round(x, n)

        return {
            "vwap": r(self.vwap),
            "z": r(self.z, 3),
            "rawZ": r(self.raw_z, 3),
            "sigma": r(self.sigma, 3),
            "sigmaAdj": r(self.sigma_adj, 3),
            "cfValid": self.cf_valid,
            "upper1": r(self.upper1),
            "lower1": r(self.lower1),
            "fibUpper1": r(self.fib_upper1),
            "fibUpper2": r(self.fib_upper2),
            "fibLower1": r(self.fib_lower1),
            "fibLower2": r(self.fib_lower2),
        }


class VwapZEngine:
    """Session-anchored VWAP + Cornish-Fisher adjusted deviation z-score.

    Feed one CLOSED trade candle per bar via :meth:`update`. Query the latest
    snapshot via :meth:`state` / :meth:`to_dict`. The anchor resets at the UTC
    session boundary (matching ``TradeCandleAggregator``'s CVD anchor).
    """

    def __init__(
        self,
        z_window: int = 100,
        atr_len: int = 14,
        cf_window: int = 100,
        use_cf: bool = True,
        sigma_floor_atr: float = 0.20,
        sigma1: float = 1.0,
        fib_inner: float = 1.618,
        fib_outer: float = 2.618,
        session_ms: int = 86_400_000,
        min_samples: int = 20,
    ):
        self.z_window = z_window
        self.use_cf = use_cf
        self.sigma_floor_atr = sigma_floor_atr
        self.sigma1 = sigma1          # ±1σ guide multiple
        self.fib_inner = fib_inner    # REG inner zone edge (1.618σ)
        self.fib_outer = fib_outer    # REG outer zone edge (2.618σ)
        self.session_ms = session_ms
        # Bands become visible after this many closed bars rather than waiting for a
        # full z_window (which on a live 1m feed is ~100 minutes of blank chart). The
        # residual mean/stdev run over a rolling deque capped at z_window but usable
        # from min_samples, so the band appears early and sharpens as the window fills.
        # Clamp to z_window: the residual deque capacity is z_window, so a
        # min_samples larger than it would make `len(_resid) < min_samples`
        # permanently true and freeze z / bands into None forever (Audit #3).
        self.min_samples = max(2, min(min_samples, z_window))

        # Running VWAP accumulators (session-anchored).
        self._sum_pv = 0.0
        self._sum_v = 0.0
        self._session: Optional[int] = None

        # Rolling residual window (price − VWAP): mean/stdev usable from min_samples.
        self._resid: Deque[float] = deque(maxlen=z_window)
        self._atr = ATR(atr_len)

        # Central moments for the Cornish-Fisher expansion (O(1), like OSC f_skew_kurtosis).
        self._m1 = SMA(cf_window)
        self._m2 = SMA(cf_window)
        self._m3 = SMA(cf_window)
        self._m4 = SMA(cf_window)

        self._last = VwapZState(
            None, None, None, None, None, False,
            None, None, None, None, None, None,
        )

    def _session_of(self, ts_ms: int) -> int:
        return (ts_ms // self.session_ms) * self.session_ms

    def update(self, t_ms: int, high: float, low: float, close: float, volume: float) -> VwapZState:
        """Ingest one CLOSED bar. ``t_ms`` is the bar open time (epoch ms)."""
        session = self._session_of(t_ms)
        if self._session is None:
            self._session = session
        elif session != self._session:
            # New session → re-anchor VWAP (matches OSC daily/anchored reset).
            self._sum_pv = 0.0
            self._sum_v = 0.0
            self._session = session

        hlc3 = (high + low + close) / 3.0
        v = max(volume, 0.0)
        self._sum_pv += hlc3 * v
        self._sum_v += v
        vwap = (self._sum_pv / self._sum_v) if self._sum_v > 0 else hlc3

        atr = self._atr.update(high, low, close) or 0.0

        resid = hlc3 - vwap
        self._resid.append(resid)

        # Feed CF moment accumulators every bar (ready only after cf_window).
        self._m1.update(resid)
        self._m2.update(resid * resid)
        self._m3.update(resid * resid * resid)
        m4 = self._m4.update(resid * resid * resid * resid)

        if len(self._resid) < self.min_samples:
            # Not enough history yet. VWAP is valid; z / bands are not.
            self._last = VwapZState(
                vwap, None, None, None, None, False,
                None, None, None, None, None, None,
            )
            return self._last

        # Mean / population stdev over the rolling residual window (usable from
        # min_samples, sharpens toward the full z_window).
        n = len(self._resid)
        mu = math.fsum(self._resid) / n
        var = math.fsum((r - mu) ** 2 for r in self._resid) / n
        sd_raw = math.sqrt(max(var, 0.0))

        # Sigma floor: 0.20 * ATR prevents a degenerate z in a compressed tape.
        sigma = max(sd_raw, self.sigma_floor_atr * atr) if atr > 0 else sd_raw
        raw_z = (resid - mu) / sigma if sigma != 0 else 0.0

        skew, kurt = 0.0, 3.0
        cf_valid = False
        cf_z = raw_z
        if self.use_cf and m4 is not None:
            skew, kurt = self._skew_kurt()
            cf_z, cf_valid = self._cornish_fisher(raw_z, skew, kurt)

        z = clamp(cf_z if (self.use_cf and cf_valid) else raw_z, -_Z_CLAMP, _Z_CLAMP)

        # Band sigma uses the CF-scaled quantile so the drawn bands are fat-tail aware.
        cf_adj = self._cf_quantile_scale(skew, kurt) if (self.use_cf and cf_valid) else 1.0
        sigma_adj = sigma * cf_adj

        self._last = VwapZState(
            vwap=vwap,
            z=z,
            raw_z=raw_z,
            sigma=sigma,
            sigma_adj=sigma_adj,
            cf_valid=cf_valid,
            upper1=vwap + self.sigma1 * sigma_adj,
            lower1=vwap - self.sigma1 * sigma_adj,
            fib_upper1=vwap + self.fib_inner * sigma_adj,
            fib_upper2=vwap + self.fib_outer * sigma_adj,
            fib_lower1=vwap - self.fib_inner * sigma_adj,
            fib_lower2=vwap - self.fib_outer * sigma_adj,
        )
        return self._last

    def _skew_kurt(self) -> tuple:
        """Skewness and kurtosis of the residual (central-moment closed form).

        Read straight off the Rolling buffers of the four moment accumulators so
        this stays O(1) and side-effect free (SMA does not expose its current value
        without an update() call).
        """
        r1 = self._m1.r
        r2 = self._m2.r
        r3 = self._m3.r
        r4 = self._m4.r
        if not (r1.ready and r2.ready and r3.ready and r4.ready):
            return 0.0, 3.0
        n = r1.n
        a1 = r1.s1 / n
        a2 = r2.s1 / n
        a3 = r3.s1 / n
        a4 = r4.s1 / n
        var = max(a2 - a1 * a1, 0.0)
        s3 = a3 - 3.0 * a1 * a2 + 2.0 * a1 * a1 * a1
        s4 = a4 - 4.0 * a1 * a3 + 6.0 * a1 * a1 * a2 - 3.0 * a1 * a1 * a1 * a1
        skew = s3 / (var ** 1.5) if var > 0.0 else 0.0
        kurt = s4 / (var * var) if var > 0.0 else 3.0
        return skew, kurt

    @staticmethod
    def _cf_poly(z: float, skew: float, kurt: float) -> float:
        """The Cornish-Fisher quantile expansion evaluated at ``z``.

        Single source of truth for the CF series so the ``_cornish_fisher`` gate
        and the ``_cf_quantile_scale`` band multiplier cannot silently diverge.
        Mirrors OSC's ``cfRaw``.
        """
        return (
            z
            + (z * z - 1) * skew / 6.0
            + (z * z * z - 3 * z) * (kurt - 3) / 24.0
            - (2 * z * z * z - 5 * z) * skew * skew / 36.0
        )

    @staticmethod
    def _cornish_fisher(raw_z: float, skew: float, kurt: float) -> tuple:
        """Return (cf_z, valid). Mirrors OSC's cfRaw / cfDeriv validity gate."""
        z = raw_z
        cf = VwapZEngine._cf_poly(z, skew, kurt)
        cf_deriv = (
            1.0
            + (2 * z) * skew / 6.0
            + (3 * z * z - 3) * (kurt - 3) / 24.0
            - (6 * z * z - 5) * skew * skew / 36.0
        )
        valid = cf_deriv > 0 and abs(cf) < 8.0
        return (cf, valid)

    @staticmethod
    def _cf_quantile_scale(skew: float, kurt: float) -> float:
        """CF band-width multiplier = CF expansion at z_p = 1.0, normalized so the
        Gaussian case returns 1.0 (OSC cfAdj).

        A non-positive raw scale means the CF expansion is NON-MONOTONIC / invalid
        at the +1σ quantile (high-kurtosis flash regimes, kurt ≳ 13): the series
        would invert or collapse the supply/demand bands (Audit #4). In that
        regime the correct behaviour is to fall back to the RAW sigma band
        (multiplier 1.0) — NOT to crush the bands to a 0.1 floor, which would make
        them ~10× too tight exactly during fat-tail stress (adversarial HIGH).
        """
        scale = VwapZEngine._cf_poly(_Z_P, skew, kurt)
        # Invalid / inverted region → fall back to raw sigma (1.0), matching the
        # z-score's own raw-z fallback so bands and z never silently decouple.
        return scale if scale > 0.0 else 1.0

    def state(self) -> VwapZState:
        return self._last

    def to_dict(self) -> Dict[str, Any]:
        return {"vwap_z": self._last.to_dict()}
