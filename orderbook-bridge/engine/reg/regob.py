"""Regression Order Blocks — Python port of REG v7.4.

Ports the Pine sections: REGRESSION OB TYPES, REGRESSION OB INPUTS,
REGRESSION OB VARIABLES, REGRESSION HELPERS (calcSlope, calcRegStats, calcRegBounds),
REGRESSION LOGIC & OB DETECTION (zero-delay + legacy modes, dedupe, mitigation,
distance culling), and the plotBullOB/plotBearOB confirmed flags.

Called once per CONFIRMED chart bar via :meth:`RegObEngine.update`.

Regression channel (regLength=100): base line value at the current bar (``mid``) plus
upper/lower channel at ``regUpperMult``/``regLowerMult`` standard deviations.

Note on Pine defaults: the master ``optimizeForScalping`` input defaults to True, which
*disables* Reg OB detection entirely (the detection block is guarded by
``not optimizeForScalping``). That is why the parity fixture has zero Reg OB events.
To exercise the detection branches, construct the engine with
``RegObConfig(optimize_for_scalping=False)``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Optional

from engine.pine import ATR, SMA, Stdev


# ───────────────────────── configuration (Pine input defaults) ─────────────────────────


@dataclass
class RegObConfig:
    enable_reg_ob: bool = True
    optimize_for_scalping: bool = True     # Pine master default (disables detection!)
    global_atr_length: int = 14

    reg_length: int = 100                  # master regLength
    reg_ob_periods: int = 5                # "Relevant Periods to identify OB"
    reg_threshold: float = 0.0             # "Min. Percent move"
    reg_use_wicks: bool = False            # "Use whole range [High/Low]"
    reg_remove_mitigated: bool = True
    reg_show_all: bool = True

    reg_min_ob_size: float = 0.0           # %
    reg_max_ob_size: float = 100.0         # %
    reg_use_atr_filter: bool = False
    reg_atr_mult: float = 1.0

    reg_early_detect: bool = True          # zero-delay mode
    reg_min_confirm: int = 3

    reg_upper_mult: float = 2.0
    reg_lower_mult: float = 2.0
    reg_use_upper: bool = True
    reg_use_lower: bool = True

    # clutter control
    cull_far_zones: bool = True
    max_zone_dist_atr: float = 20.0
    reg_dedupe_atr: float = 0.25


# ───────────────────────── output dataclasses ─────────────────────────


@dataclass
class OBZone:
    top: float
    bottom: float
    side: str            # "bull" / "bear"
    created: int         # bar index of the OB source candle
    confirmed: bool


@dataclass
class RegObBar:
    t: int
    bull_ob: bool                         # plotBullOB (confirmed this bar)
    bear_ob: bool                         # plotBearOB (confirmed this bar)
    zones: List[OBZone] = field(default_factory=list)
    reg_mid: Optional[float] = None
    reg_upper: Optional[float] = None
    reg_lower: Optional[float] = None


# ───────────────────────── internal OB record ─────────────────────────


@dataclass
class _RegOB:
    top: float
    bottom: float
    is_bull: bool
    start_index: int
    active: bool = True
    confirm_count: int = 0
    is_confirmed: bool = False


# ───────────────────────── O(1) regression helpers ─────────────────────────


class _WMA:
    """ta.wma(src, n): weights n (newest) .. 1 (oldest)."""

    def __init__(self, n: int):
        self.n = n
        self.buf: List[float] = []
        self.denom = n * (n + 1) / 2.0

    def update(self, x: float) -> Optional[float]:
        self.buf.append(x)
        if len(self.buf) > self.n:
            self.buf.pop(0)
        if len(self.buf) < self.n:
            return None
        s = 0.0
        # buf[0] oldest -> weight 1 ; buf[-1] newest -> weight n
        for i, val in enumerate(self.buf):
            s += val * (i + 1)
        return s / self.denom


class RegObEngine:
    def __init__(self, cfg: Optional[RegObConfig] = None):
        self.cfg = cfg or RegObConfig()
        c = self.cfg
        self.bar_index = -1

        self.atr = ATR(c.global_atr_length)
        self.sma_c = SMA(c.reg_length)
        self.wma_c = _WMA(c.reg_length)
        self.sma_c2 = SMA(c.reg_length)       # sma(close^2)
        self.stdev_c = Stdev(c.reg_length)

        # OHLC history (index 0 == current)
        self._o: List[float] = []
        self._h: List[float] = []
        self._l: List[float] = []
        self._c: List[float] = []

        self.regOBs: List[_RegOB] = []
        self.pendingOBs: List[_RegOB] = []

        # dedupe state
        self.last_bull_top: Optional[float] = None
        self.last_bull_bot: Optional[float] = None
        self.last_bear_top: Optional[float] = None
        self.last_bear_bot: Optional[float] = None

        self.reg_trend_dir = 0.0

    def _px(self, s: List[float], k: int):
        return s[k] if k < len(s) else None

    def _calc_slope_intercept(self, sma_c, wma_c):
        n = float(self.cfg.reg_length)
        if n <= 1 or sma_c is None or wma_c is None:
            return None, None
        sx = n * (n + 1.0) * 0.5
        sy = sma_c * n
        sx2 = n * (n + 1.0) * (2.0 * n + 1.0) / 6.0
        sxy = wma_c * sx
        denom = n * sx2 - sx * sx
        slope = (n * sxy - sx * sy) / denom if denom != 0 else 0.0
        average = sy / n
        intercept = average - slope * sx / n + slope
        return slope, intercept

    def _calc_pearson(self, sma_c, wma_c, sma_c2):
        n = float(self.cfg.reg_length)
        if sma_c is None or wma_c is None or sma_c2 is None:
            return 0.0
        sumX = n * (n + 1.0) * 0.5
        sumY = sma_c * n
        sumXSqr = n * (n + 1.0) * (2.0 * n + 1.0) / 6.0
        sumXY = wma_c * sumX
        sumYSqr = sma_c2 * n
        numerator = n * sumXY - sumX * sumY
        denomX = n * sumXSqr - sumX * sumX
        denomY = n * sumYSqr - sumY * sumY
        if denomX > 0 and denomY > 0:
            return numerator / math.sqrt(denomX * denomY)
        return 0.0

    def _reg_ob_size_check(self, is_bull: bool, src_off: int):
        c = self.cfg
        if is_bull:
            hh = self._px(self._h, src_off) if c.reg_use_wicks else self._px(self._o, src_off)
            if c.reg_use_wicks:
                ll = self._px(self._l, src_off)
            else:
                oo = self._px(self._o, src_off)
                cc = self._px(self._c, src_off)
                ll = min(oo, cc) if (oo is not None and cc is not None) else None
        else:
            if c.reg_use_wicks:
                hh = self._px(self._h, src_off)
            else:
                oo = self._px(self._o, src_off)
                cc = self._px(self._c, src_off)
                hh = max(oo, cc) if (oo is not None and cc is not None) else None
            ll = self._px(self._l, src_off) if c.reg_use_wicks else self._px(self._o, src_off)
        if hh is None or ll is None or ll <= 0:
            return False, None
        ob_size = (hh - ll) / ll * 100
        size_ok = ob_size >= c.reg_min_ob_size and ob_size <= c.reg_max_ob_size
        return size_ok, ob_size

    def update(self, t: int, o: float, h: float, l: float, c: float, v: float = 0.0) -> RegObBar:
        cfg = self.cfg
        self.bar_index += 1
        bi = self.bar_index

        self._o.insert(0, o); self._h.insert(0, h); self._l.insert(0, l); self._c.insert(0, c)
        if len(self._o) > cfg.reg_length + 50:
            self._o.pop(); self._h.pop(); self._l.pop(); self._c.pop()

        atr = self.atr.update(h, l, c)
        sma_c = self.sma_c.update(c)
        wma_c = self.wma_c.update(c)
        sma_c2 = self.sma_c2.update(c * c)
        stdev_c = self.stdev_c.update(c)

        reg_mid = reg_upper = reg_lower = None
        plot_bull = False
        plot_bear = False

        want_reg = cfg.enable_reg_ob
        if want_reg:
            slope, intercept = self._calc_slope_intercept(sma_c, wma_c)
            if slope is not None:
                reg_start = intercept
                reg_end = intercept + slope * (cfg.reg_length - 1)
                pearson = self._calc_pearson(sma_c, wma_c, sma_c2)
                std_dev = (stdev_c or 0.0) * math.sqrt(max(0.0, 1 - pearson * pearson))
                reg_mid = reg_end
                if cfg.reg_use_upper:
                    reg_upper = reg_end + cfg.reg_upper_mult * std_dev
                if cfg.reg_use_lower:
                    reg_lower = reg_end - cfg.reg_lower_mult * std_dev
                self.reg_trend_dir = math.copysign(1.0, reg_end - reg_start) if reg_end != reg_start else 0.0

            # OB detection
            if cfg.enable_reg_ob and cfg.reg_early_detect and not cfg.optimize_for_scalping:
                plot_bull, plot_bear = self._detect_zero_delay(bi, o, h, l, c, atr)
            elif cfg.enable_reg_ob and not cfg.optimize_for_scalping:
                plot_bull, plot_bear = self._detect_legacy(bi, atr)

            # mitigation + distance cull
            self._cleanup(bi, c, atr)

        zones = [
            OBZone(top=ob.top, bottom=ob.bottom, side="bull" if ob.is_bull else "bear",
                   created=ob.start_index, confirmed=ob.is_confirmed)
            for ob in self.regOBs
        ]
        return RegObBar(t=t, bull_ob=plot_bull, bear_ob=plot_bear, zones=zones,
                        reg_mid=reg_mid, reg_upper=reg_upper, reg_lower=reg_lower)

    # ---- zero-delay detection ----

    def _detect_zero_delay(self, bi, o, h, l, c, atr):
        cfg = self.cfg
        reg_found_bull = False
        reg_found_bear = False
        dedupe_tol = (atr or 0.0) * cfg.reg_dedupe_atr

        c1 = self._px(self._c, 1)
        o1 = self._px(self._o, 1)
        src_bear_candle = c1 is not None and o1 is not None and c1 < o1
        src_bull_candle = c1 is not None and o1 is not None and c1 > o1
        bull_ok, _ = self._reg_ob_size_check(True, 1)
        bear_ok, _ = self._reg_ob_size_check(False, 1)

        # new OB source candles (bar[1] just closed)
        if src_bear_candle and bull_ok:
            ob_top = self._px(self._h, 1) if cfg.reg_use_wicks else self._px(self._o, 1)
            ob_bot = self._px(self._l, 1) if cfg.reg_use_wicks else min(self._px(self._o, 1), self._px(self._c, 1))
            dup = (self.last_bull_top is not None
                   and abs(ob_top - self.last_bull_top) <= dedupe_tol
                   and abs(ob_bot - self.last_bull_bot) <= dedupe_tol)
            if not dup:
                self.last_bull_top = ob_top
                self.last_bull_bot = ob_bot
                self.pendingOBs.append(_RegOB(ob_top, ob_bot, True, bi - 1, True, 0, False))

        if src_bull_candle and bear_ok:
            ob_top = self._px(self._h, 1) if cfg.reg_use_wicks else max(self._px(self._o, 1), self._px(self._c, 1))
            ob_bot = self._px(self._l, 1) if cfg.reg_use_wicks else self._px(self._o, 1)
            dup = (self.last_bear_top is not None
                   and abs(ob_top - self.last_bear_top) <= dedupe_tol
                   and abs(ob_bot - self.last_bear_bot) <= dedupe_tol)
            if not dup:
                self.last_bear_top = ob_top
                self.last_bear_bot = ob_bot
                self.pendingOBs.append(_RegOB(ob_top, ob_bot, False, bi - 1, True, 0, False))

        # progressive confirmation
        for i in range(len(self.pendingOBs) - 1, -1, -1):
            pob = self.pendingOBs[i]
            if not pob.active:
                self.pendingOBs.pop(i)
                continue
            bars_since = bi - pob.start_index
            if bars_since > cfg.reg_ob_periods + 2:
                self.pendingOBs.pop(i)
                continue
            is_confirming = (c > o) if pob.is_bull else (c < o)
            if is_confirming and bars_since <= cfg.reg_ob_periods:
                pob.confirm_count += 1
                if pob.confirm_count >= cfg.reg_ob_periods:
                    pob.is_confirmed = True
                    self.regOBs.append(pob)
                    self.pendingOBs.pop(i)
                    reg_found_bull = pob.is_bull
                    reg_found_bear = not pob.is_bull
            elif (not is_confirming) and bars_since <= cfg.reg_ob_periods:
                pob.active = False
                self.pendingOBs.pop(i)

        return reg_found_bull, reg_found_bear

    # ---- legacy detection ----

    def _detect_legacy(self, bi, atr):
        cfg = self.cfg
        lookback = cfg.reg_ob_periods + 1
        c_lb = self._px(self._c, lookback)
        c1 = self._px(self._c, 1)
        o_lb = self._px(self._o, lookback)
        h_lb = self._px(self._h, lookback)
        l_lb = self._px(self._l, lookback)
        if c_lb is None or c1 is None or o_lb is None or c_lb <= 0:
            return False, False

        abs_move = abs(c_lb - c1) / c_lb * 100
        rel_move = abs_move >= cfg.reg_threshold

        # Bullish
        is_bull_ob = c_lb < o_lb
        bull_counts = 0
        for k in range(1, cfg.reg_ob_periods + 1):
            ck = self._px(self._c, k)
            ok = self._px(self._o, k)
            if ck is not None and ok is not None and ck > ok:
                bull_counts += 1
        ob_bull_size = 0.0
        if is_bull_ob:
            hh = h_lb if cfg.reg_use_wicks else o_lb
            ll = l_lb
            if hh is not None and ll is not None and ll > 0:
                ob_bull_size = (hh - ll) / ll * 100
        size_f_bull = ob_bull_size >= cfg.reg_min_ob_size and ob_bull_size <= cfg.reg_max_ob_size
        atr_f_bull = (not cfg.reg_use_atr_filter) or (
            (h_lb - l_lb) <= (atr or 0.0) * cfg.reg_atr_mult)
        reg_found_bull = is_bull_ob and (bull_counts == cfg.reg_ob_periods) and rel_move and size_f_bull and atr_f_bull

        # Bearish
        is_bear_ob = c_lb > o_lb
        bear_counts = 0
        for m in range(1, cfg.reg_ob_periods + 1):
            cm = self._px(self._c, m)
            om = self._px(self._o, m)
            if cm is not None and om is not None and cm < om:
                bear_counts += 1
        ob_bear_size = 0.0
        if is_bear_ob:
            hh = h_lb
            ll = l_lb if cfg.reg_use_wicks else o_lb
            if hh is not None and ll is not None and ll > 0:
                ob_bear_size = (hh - ll) / ll * 100
        size_f_bear = ob_bear_size >= cfg.reg_min_ob_size and ob_bear_size <= cfg.reg_max_ob_size
        atr_f_bear = (not cfg.reg_use_atr_filter) or (
            (h_lb - l_lb) <= (atr or 0.0) * cfg.reg_atr_mult)
        reg_found_bear = is_bear_ob and (bear_counts == cfg.reg_ob_periods) and rel_move and size_f_bear and atr_f_bear

        dedupe_tol = (atr or 0.0) * cfg.reg_dedupe_atr
        if reg_found_bull:
            ob_top = h_lb if cfg.reg_use_wicks else o_lb
            ob_bot = l_lb
            dup = (self.last_bull_top is not None
                   and abs(ob_top - self.last_bull_top) <= dedupe_tol
                   and abs(ob_bot - self.last_bull_bot) <= dedupe_tol)
            if not dup:
                self.last_bull_top = ob_top
                self.last_bull_bot = ob_bot
                self.regOBs.append(_RegOB(ob_top, ob_bot, True, bi - lookback, True,
                                          cfg.reg_ob_periods, True))
            else:
                reg_found_bull = False

        if reg_found_bear:
            ob_top = h_lb
            ob_bot = l_lb if cfg.reg_use_wicks else o_lb
            dup = (self.last_bear_top is not None
                   and abs(ob_top - self.last_bear_top) <= dedupe_tol
                   and abs(ob_bot - self.last_bear_bot) <= dedupe_tol)
            if not dup:
                self.last_bear_top = ob_top
                self.last_bear_bot = ob_bot
                self.regOBs.append(_RegOB(ob_top, ob_bot, False, bi - lookback, True,
                                          cfg.reg_ob_periods, True))
            else:
                reg_found_bear = False

        return reg_found_bull, reg_found_bear

    # ---- mitigation + distance cull ----

    def _cleanup(self, bi, close, atr):
        cfg = self.cfg
        if not self.regOBs:
            return
        if cfg.reg_remove_mitigated or cfg.cull_far_zones:
            for i in range(len(self.regOBs) - 1, -1, -1):
                ob = self.regOBs[i]
                mitigated = False
                if cfg.reg_remove_mitigated:
                    if ob.is_bull:
                        if close < ob.bottom:
                            mitigated = True
                    else:
                        if close > ob.top:
                            mitigated = True
                if (not mitigated) and cfg.cull_far_zones:
                    ob_mid = (ob.top + ob.bottom) / 2.0
                    dist = abs(close - ob_mid)
                    vis_range = (atr or 0.0) * cfg.max_zone_dist_atr
                    if dist > vis_range:
                        mitigated = True
                if mitigated:
                    self.regOBs.pop(i)

        if not cfg.reg_show_all and len(self.regOBs) > 2:
            while len(self.regOBs) > 2:
                self.regOBs.pop(0)

        if len(self.regOBs) > 100:
            while len(self.regOBs) > 100:
                self.regOBs.pop(0)
