"""RPD — Reversal Pattern Detection (calibrated), Python port of REG v7.4.

Bar-for-bar port of the Pine sections:
  * RPD INPUTS            (~line 304)
  * RPD HELPER FUNCTIONS  (~line 819 — getSupertrend / rTrend)
  * RPD CORE SIGNAL ENGINE(~line 1111-1496)
  * the shared Phase-2 signal ledger it depends on (f_ledgerRecord / f_ledgerUpdate /
    f_calStats / f_displayProb) for the *displayed* calibrated probability.

Called once per CONFIRMED chart bar (Pine confirmedOnly=true → barstate.isconfirmed is
always true, barstate.isrealtime is always false). Consequences used throughout:
  * liveSignalMode path is dead (needs barstate.isrealtime)      → not ported (no effect).
  * predictiveMode defaults false → isPotentialPeak/Valley always false.
  * barConfirmed is always true.

Outputs: valid_peak, valid_valley, peak_prob, valley_prob (heuristic score shown when
calibration is cold), the calibrated/displayed probability, and r_trend.

Deviations from Pine, documented:
  * request.security(mtfTF, [high,low,close], gaps_on, lookahead_off) is rebuilt from the
    chart bars. mtfMultiplier=4 on a 5m chart → a 20m HTF. gaps_on means the merged series
    carries the *completed* HTF bar's value only on the chart bar that closes the HTF
    period and is na on every other chart bar. We detect the closing bar from the regular
    chart grid (bucket(t+chartTf) != bucket(t)); this is grid arithmetic, not lookahead,
    and reproduces TradingView lookahead_off exactly for a gapless regular series.
  * Everything that only drives drawings (labels, boxes, fib lines, waves, particles,
    dashboard) is omitted; it has no effect on the signal booleans or probabilities.

Parity (tv_xauusd_5m.csv, 6,250 confirmed bars, 500-bar warm-up):
  * RPD_Peak   : TP=68 FP=3  FN=3   (precision 95.8%, recall 95.8%)
  * RPD_Valley : TP=77 FP=5  FN=14  (precision 93.9%, recall 84.6%)
  The residual (8 FP / 17 FN of 162 events) is concentrated on reversal bars that coincide
  with an rTrend flip. On those bars TradingView fires the event through the MTF confluence
  term (mtfIsPeak/mtfIsValley feeding isPeakEvent/isValleyEvent). Reproducing that term
  exactly requires TradingView's *internal* 20m request.security series, which is built
  from its own intrabar history and cannot be reconstructed bar-for-bar from the 5m chart
  OHLCV in the fixture (aggregating the chart bars into 20m candles under every
  gaps/lookahead/phase combination was verified not to reproduce it — see the parity test).
  The base pivot/fractal + state/entropy/RSI/volume/ledger pipeline is an exact port.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from typing import Deque, List, Optional

from engine.pine import ATR, SMA, RMA, is_na, nz

Num = Optional[float]


# ----------------------------------------------------------------------------- helpers

def pine_round(x: float) -> int:
    """Pine ``math.round`` with no digits — rounds half away from zero."""
    return int(math.floor(x + 0.5)) if x >= 0 else int(math.ceil(x - 0.5))


def pine_round_to(x: float, digits: int) -> float:
    """Pine ``math.round(x, digits)`` — half away from zero at the given precision."""
    f = 10.0 ** digits
    y = x * f
    r = math.floor(y + 0.5) if y >= 0 else math.ceil(y - 0.5)
    return r / f


class WMA:
    """``ta.wma(src, n)`` — linear weights n, n-1, ..., 1 (most recent weighted n)."""

    def __init__(self, n: int):
        self.n = n
        self.buf: Deque[Num] = deque(maxlen=n)
        self.denom = n * (n + 1) / 2.0

    def update(self, x: Num) -> Num:
        self.buf.append(x)
        if len(self.buf) < self.n:
            return None
        if any(is_na(v) for v in self.buf):
            return None
        # buf[-1] is most recent → weight n; buf[0] oldest → weight 1.
        s = 0.0
        for i, v in enumerate(self.buf):
            w = i + 1  # oldest=1 ... newest=n
            s += v * w
        return s / self.denom


class RSI:
    """``ta.rsi(src, n)`` — RMA of gains / RMA of losses, RMA seeded with SMA."""

    def __init__(self, n: int):
        self.prev: Num = None
        self.g = RMA(n)
        self.l = RMA(n)

    def update(self, x: Num) -> Num:
        if is_na(x):
            return None
        if self.prev is None:
            self.prev = x
            # Pine: ta.change(src) is na on bar 0, rma not seeded yet → rsi na.
            self.g.update(None)
            self.l.update(None)
            return None
        ch = x - self.prev
        self.prev = x
        up = ch if ch > 0 else 0.0
        dn = -ch if ch < 0 else 0.0
        ag = self.g.update(up)
        al = self.l.update(dn)
        if ag is None or al is None:
            return None
        if al == 0:
            return 100.0
        rs = ag / al
        return 100.0 - 100.0 / (1.0 + rs)


class Series:
    """Minimal Pine-style series with [k] lookback (s[0] = value pushed this bar)."""

    __slots__ = ("_d",)

    def __init__(self, maxlen: int = 64):
        self._d: Deque[Num] = deque(maxlen=maxlen)

    def push(self, x: Num) -> Num:
        self._d.appendleft(x)
        return x

    def __getitem__(self, k: int) -> Num:
        return self._d[k] if 0 <= k < len(self._d) else None

    def __len__(self) -> int:
        return len(self._d)


# ----------------------------------------------------------------------------- config

@dataclass
class RpdConfig:
    # Master
    confirmed_only: bool = True
    enable_rpd: bool = True
    global_atr_length: int = 14
    # RPD core
    adaptive_period: int = 25
    fractal_strength: int = 2
    mtf_multiplier: int = 4
    # RPD signal
    min_prob_threshold: int = 65
    min_signal_distance: int = 10
    entropy_threshold: float = 0.85
    # RPD state
    analysis_levels: int = 6
    edge_sensitivity: int = 3
    predictive_mode: bool = False
    live_signal_mode: bool = False
    adaptive_entropy: bool = True
    aggressive_mode: bool = False
    # RPD filters
    enable_rsi: bool = True
    rsi_len: int = 17
    rsi_top: int = 65
    rsi_bot: int = 40
    vol_lookback: int = 17
    vol_multiplier: float = 1.2
    # Ledger / calibration (Phase 2 — display probability)
    eval_horizon: int = 20
    rolling_window: int = 50
    synthetic_r_atr: float = 1.0
    min_risk_atr: float = 0.25
    risk_buffer_ticks: int = 0
    spread_cost_ticks: int = 25
    account_equity: float = 100.0
    risk_pct: float = 1.0
    commission_per_trade: float = 0.0
    min_cal_samples: int = 15
    use_calibrated_prob: bool = True
    mintick: float = 0.001  # OANDA:XAUUSD 5m exported with 3dp (syminfo.mintick)
    # chart timeframe in seconds (inferred from bar times if left None at runtime)
    chart_tf_seconds: Optional[int] = None


# ----------------------------------------------------------------------------- output

@dataclass
class RpdBar:
    t: int
    valid_peak: bool = False
    valid_valley: bool = False
    peak_prob: Num = None          # heuristic score (raw calculateProbability)
    valley_prob: Num = None
    peak_display: Num = None       # calibrated/displayed probability (f_displayProb)
    valley_display: Num = None
    r_trend: int = 1
    # diagnostics
    state: Optional[int] = None
    entropy: Num = None
    psr_velocity: Num = None
    psr_acceleration: Num = None
    rsi: Num = None
    is_peak_event: bool = False
    is_valley_event: bool = False


# ----------------------------------------------------------------------------- ledger

@dataclass
class _Rec:
    sig_type: str
    entry_bar: int
    entry_price: float
    direction: int
    stop: float
    stop_trigger: float
    risk: float
    horizon: int
    bars_elapsed: int = 0
    mfe: float = 0.0
    mae: float = 0.0
    r_mult: float = 0.0
    r_mult_gross: float = 0.0
    stopped: bool = False
    win: bool = False
    closed: bool = False


# ----------------------------------------------------------------------------- MTF

class _MtfBuilder:
    """Rebuild request.security(mtfTF, [high,low,close], gaps_on, lookahead_off).

    gaps_on + lookahead_off: the merged series carries the *completed* HTF bar's value only
    on the chart bar that closes the HTF period, and na on every other chart bar. We detect
    the closing bar from the regular chart grid (bucket(t+chartTf) != bucket(t)); this is
    grid arithmetic, not lookahead. Downstream [1]/[2] are chart-bar offsets on this gappy
    series, exactly as Pine reads them.
    """

    def __init__(self, htf_seconds: int, chart_tf_seconds: int):
        self.htf = htf_seconds
        self.chart = chart_tf_seconds
        self.cur_bucket: Optional[int] = None
        self.ch = self.cl = self.cc = None  # accumulating current HTF bar

    def update(self, t: int, h: float, l: float, c: float):
        b = t - (t % self.htf)
        if self.cur_bucket is None or b != self.cur_bucket:
            self.cur_bucket = b
            self.ch, self.cl, self.cc = h, l, c
        else:
            self.ch = max(self.ch, h)
            self.cl = min(self.cl, l)
            self.cc = c
        next_bucket = (t + self.chart) - ((t + self.chart) % self.htf)
        if next_bucket != b:
            return (self.ch, self.cl, self.cc)  # HTF bar closes here
        return (None, None, None)



# ----------------------------------------------------------------------------- engine

class RpdEngine:
    def __init__(self, cfg: Optional[RpdConfig] = None):
        self.cfg = cfg or RpdConfig()
        c = self.cfg

        self.bar_index = -1
        self._prev_t: Optional[int] = None

        # --- rTrend supertrend state: getSupertrend(hlcc4, 1.1, 16) ---
        self._st_atr = ATR(16)
        self._st_upper_prev: Num = None
        self._st_lower_prev: Num = None
        self._st_trend = 1
        self._prev_close: Num = None
        self.r_trend = 1
        self._r_trend_series = Series(8)

        # --- core primitives ---
        self._wma3 = WMA(3)                        # hlc3_smooth
        self._hlc3s = Series(64)
        self._qsa_buf: Deque[Num] = deque(maxlen=c.adaptive_period)  # quantumStateAnalysis window
        self._state_series = Series(8)
        self._entropy_isup = SMA(c.adaptive_period)
        self._entropy_series = Series(8)
        self._rsi = RSI(c.rsi_len)
        self._atr = ATR(c.global_atr_length)

        # psr velocity needs hlc3_smooth[round(period/2)]; keep buffer
        self._psr_lag = pine_round(c.adaptive_period / 2.0)
        self._psr_vel_series = Series(8)
        self._psr_accel_series = Series(8)

        # trendStrength = abs(ema(psr_velocity,10))
        self._ts_ema = _PineEMA(10)

        # volume avg
        self._vol_sma = SMA(c.vol_lookback)

        # highs/lows raw for pivots and MTF
        self._high = Series(8)
        self._low = Series(8)
        self._close = Series(8)

        # fractal buffers (need center +/- strength)
        fw = c.fractal_strength * 2 + 1
        self._fh: Deque[Num] = deque(maxlen=fw)
        self._fl: Deque[Num] = deque(maxlen=fw)
        self._fractal_high_series = Series(8)
        self._fractal_low_series = Series(8)

        # last-valid pivot memory (var floats = na)
        self.last_valid_peak_price: Num = None
        self.last_valid_peak_velocity: Num = None
        self.last_valid_valley_price: Num = None
        self.last_valid_valley_velocity: Num = None

        self.last_signal_bar: Optional[int] = None

        # MTF
        self._mtf: Optional[_MtfBuilder] = None
        self._mtf_high = Series(8)
        self._mtf_low = Series(8)
        self._mtf_close = Series(8)

        # ledger
        self.ledger: List[_Rec] = []
        self.open_ledger: List[_Rec] = []

    # -------------------------------------------------- ledger ops
    def _ledger_record(self, sig_type: str, entry: float, direction: int, stop_price: float):
        c = self.cfg
        atr = self._atr_val
        r_floor = (atr if atr is not None else 0.0) * c.min_risk_atr
        stop = stop_price
        wrong_side = (not is_na(stop)) and (stop >= entry if direction == 1 else stop <= entry)
        r = None if (wrong_side or is_na(stop)) else abs(entry - stop)
        if wrong_side:
            return
        if r is None or r <= 0:
            r = max((atr if atr is not None else 0.0) * c.synthetic_r_atr, r_floor)
            stop = entry - r if direction == 1 else entry + r
        if r < r_floor:
            r = r_floor
            stop = entry - r if direction == 1 else entry + r
        trig = (stop - c.mintick * c.risk_buffer_ticks) if direction == 1 else (stop + c.mintick * c.risk_buffer_ticks)
        rec = _Rec(sig_type, self.bar_index, entry, direction, stop, trig, r, c.eval_horizon)
        self.ledger.append(rec)
        self.open_ledger.append(rec)

    def _ledger_update(self, h: float, l: float, close: float):
        c = self.cfg
        for i in range(len(self.open_ledger) - 1, -1, -1):
            rec = self.open_ledger[i]
            rec.bars_elapsed += 1
            fav = (h - rec.entry_price) if rec.direction == 1 else (rec.entry_price - l)
            adv = (rec.entry_price - l) if rec.direction == 1 else (h - rec.entry_price)
            if fav > rec.mfe:
                rec.mfe = fav
            if adv > rec.mae:
                rec.mae = adv
            fr_r = c.spread_cost_ticks * c.mintick / max(rec.risk, c.mintick)
            if c.account_equity * c.risk_pct > 0:
                fr_r += c.commission_per_trade / (c.account_equity * c.risk_pct / 100.0)
            stop_touched = (l <= rec.stop_trigger) if rec.direction == 1 else (h >= rec.stop_trigger)
            if stop_touched:
                rec.stopped = True
                rec.closed = True
                rec.r_mult = -1.0 - fr_r
                rec.r_mult_gross = -1.0
                rec.win = False
                del self.open_ledger[i]
            elif rec.bars_elapsed >= rec.horizon:
                pnl = (close - rec.entry_price) if rec.direction == 1 else (rec.entry_price - close)
                rec.r_mult_gross = pnl / rec.risk
                rec.r_mult = rec.r_mult_gross - fr_r
                rec.win = rec.r_mult > 0
                rec.closed = True
                del self.open_ledger[i]

    def _ledger_prune(self):
        c = self.cfg
        cap = c.rolling_window * 18  # ledgerTypeCount default 18
        while len(self.ledger) > cap:
            oldest = self.ledger[0]
            if oldest.closed or (self.bar_index - oldest.entry_bar) > oldest.horizon * 2:
                self.ledger.pop(0)
            else:
                break

    def _cal_stats(self, sig_type: str):
        """f_calStats → (beta-smoothed win%, closed sample count n)."""
        c = self.cfg
        wins = 0
        total = 0
        for rec in reversed(self.ledger):
            if total >= c.rolling_window:
                break
            if rec.sig_type == sig_type and rec.closed:
                total += 1
                if rec.win:
                    wins += 1
        return ((wins + 2.0) / (total + 4.0) * 100.0, total)

    def _display_prob(self, sig_type: str, heuristic: Num) -> Num:
        c = self.cfg
        rolling_hit, rolling_n = self._cal_stats(sig_type)
        if is_na(heuristic):
            return None
        if c.use_calibrated_prob:
            return rolling_hit if rolling_n >= c.min_cal_samples else None
        return heuristic

    # -------------------------------------------------- main
    def update(self, t: int, o: float, h: float, l: float, c_: float, v: float) -> RpdBar:
        cfg = self.cfg
        self.bar_index += 1
        bi = self.bar_index

        # infer chart tf once
        if self._prev_t is not None and cfg.chart_tf_seconds is None:
            dt = t - self._prev_t
            if dt > 0:
                cfg.chart_tf_seconds = dt
        self._prev_t = t

        # push raw series
        self._high.push(h)
        self._low.push(l)
        self._close.push(c_)

        # --- rTrend: getSupertrend(hlcc4, 1.1, 16) ---
        hlcc4 = (h + l + c_ + c_) / 4.0
        atr_rpd = self._st_atr.update(h, l, c_)
        r_trend = self._supertrend(hlcc4, 1.1, atr_rpd, c_)
        self.r_trend = r_trend
        self._r_trend_series.push(r_trend)

        # --- hlc3_smooth = wma((h+l+c)/3, 3) ---
        hlc3 = (h + l + c_) / 3.0
        hlc3_smooth = self._wma3.update(hlc3)
        self._hlc3s.push(hlc3_smooth)

        # --- atr (global) ---
        self._atr_val = self._atr.update(h, l, c_)
        atr = self._atr_val

        # --- quantumStateAnalysis(hlc3_smooth, analysisLevels, adaptivePeriod) ---
        state = self._quantum_state(hlc3_smooth)
        self._state_series.push(state)

        # --- psr(hlc3_smooth, adaptivePeriod) ---
        psr_velocity, psr_acceleration = self._psr(hlc3_smooth)
        self._psr_vel_series.push(psr_velocity)
        self._psr_accel_series.push(psr_acceleration)

        # --- entropy ---
        entropy = self._entropy(hlc3_smooth)
        self._entropy_series.push(entropy)

        # --- rsi ---
        rsi = self._rsi.update(c_)
        rsi_top_cond = (rsi is not None and rsi > cfg.rsi_top) if cfg.enable_rsi else False
        rsi_bot_cond = (rsi is not None and rsi < cfg.rsi_bot) if cfg.enable_rsi else False

        # --- pivots (use raw high/low) ---
        # isPivotHigh = high[1] > high[2] and high[1] > high
        h0, h1, h2 = self._high[0], self._high[1], self._high[2]
        l0, l1, l2 = self._low[0], self._low[1], self._low[2]
        is_pivot_high = (not is_na(h1) and not is_na(h2) and not is_na(h0)
                         and h1 > h2 and h1 > h0)
        is_pivot_low = (not is_na(l1) and not is_na(l2) and not is_na(l0)
                        and l1 < l2 and l1 < l0)

        # --- fractals ---
        is_fractal_high, is_fractal_low = self._fractals(h, l)
        self._fractal_high_series.push(is_fractal_high)
        self._fractal_low_series.push(is_fractal_low)
        # Source: (isPivotHigh or isFractalHigh[1]) / (isPivotLow or isFractalLow[1]).
        is_fractal_high_1 = bool(self._fractal_high_series[1])
        is_fractal_low_1 = bool(self._fractal_low_series[1])

        # base events
        is_peak_event_base = (is_pivot_high or is_fractal_high_1) and (not is_na(l1) and c_ < l1)
        is_valley_event_base = (is_pivot_low or is_fractal_low_1) and (not is_na(h1) and c_ > h1)
        peak_price_at_pivot = h1
        valley_price_at_pivot = l1

        # --- MTF confluence ---
        if self._mtf is None and cfg.chart_tf_seconds:
            self._mtf = _MtfBuilder(cfg.chart_tf_seconds * cfg.mtf_multiplier, cfg.chart_tf_seconds)
        if self._mtf is not None:
            mh, ml, mc = self._mtf.update(t, h, l, c_)
        else:
            mh = ml = mc = None
        self._mtf_high.push(mh)
        self._mtf_low.push(ml)
        self._mtf_close.push(mc)
        mh1, mh2, mh0 = self._mtf_high[1], self._mtf_high[2], self._mtf_high[0]
        ml1, ml2, ml0 = self._mtf_low[1], self._mtf_low[2], self._mtf_low[0]
        mtf_is_peak = (not is_na(mh1)
                       and mh1 > nz(mh2, mh1)
                       and mh1 > nz(mh0, mh1))
        mtf_is_valley = (not is_na(ml1)
                         and ml1 < nz(ml2, ml1)
                         and ml1 < nz(ml0, ml1))

        is_peak_event = is_peak_event_base or (mtf_is_peak and c_ < nz(ml1, l1 if not is_na(l1) else c_))
        is_valley_event = is_valley_event_base or (mtf_is_valley and c_ > nz(mh1, h1 if not is_na(h1) else c_))

        # --- divergences (use previous last-valid memory, then possibly update later) ---
        psr_vel_1 = self._psr_vel_series[1]
        is_bearish_div = (is_peak_event and not is_na(self.last_valid_peak_price)
                          and not is_na(peak_price_at_pivot)
                          and peak_price_at_pivot > self.last_valid_peak_price
                          and not is_na(psr_vel_1)
                          and psr_vel_1 < self.last_valid_peak_velocity)
        is_bullish_div = (is_valley_event and not is_na(self.last_valid_valley_price)
                          and not is_na(valley_price_at_pivot)
                          and valley_price_at_pivot < self.last_valid_valley_price
                          and not is_na(psr_vel_1)
                          and psr_vel_1 > self.last_valid_valley_velocity)

        # --- rTrendChange = ta.change(rTrend) ---
        rt1 = self._r_trend_series[1]
        r_trend_change = None if is_na(rt1) else (r_trend - rt1)

        eff_min_distance = 1 if cfg.aggressive_mode else cfg.min_signal_distance
        eff_edge_sens = 4 if cfg.aggressive_mode else cfg.edge_sensitivity
        eff_entropy_thresh = 0.95 if cfg.aggressive_mode else cfg.entropy_threshold

        state_1 = self._state_series[1]
        # isPeakStateReqMet / isValleyStateReqMet
        # (rTrendChange < 0 is false when na)
        rtc_lt0 = (r_trend_change is not None and r_trend_change < 0)
        rtc_gt0 = (r_trend_change is not None and r_trend_change > 0)
        is_peak_state_req = (is_peak_event and not is_na(state_1)
                             and state_1 >= cfg.analysis_levels - 1 - eff_edge_sens
                             and (r_trend == -1 or rtc_lt0))
        is_valley_state_req = (is_valley_event and not is_na(state_1)
                               and state_1 <= eff_edge_sens
                               and (r_trend == 1 or rtc_gt0))

        # predictiveMode default false → potentials always false
        is_potential_peak = False
        is_potential_valley = False
        if cfg.predictive_mode:
            is_potential_peak = (not is_na(state) and state >= cfg.analysis_levels - 1 - eff_edge_sens
                                 and not is_na(psr_acceleration) and psr_acceleration < 0
                                 and not is_na(entropy) and entropy < eff_entropy_thresh
                                 and r_trend == -1)
            is_potential_valley = (not is_na(state) and state <= eff_edge_sens
                                   and not is_na(psr_acceleration) and psr_acceleration > 0
                                   and not is_na(entropy) and entropy < eff_entropy_thresh
                                   and r_trend == 1)

        # --- trendStrength, volume ---
        trend_strength = self._ts_ema.update(psr_velocity)
        trend_strength = abs(trend_strength) if trend_strength is not None else None
        vol_avg = self._vol_sma.update(v)
        vol_spike = (vol_avg is not None and vol_avg != 0 and (v / vol_avg) > cfg.vol_multiplier)

        # --- probability ---
        entropy_1 = self._entropy_series[1]
        ctx = _ProbCtx(
            trend_strength=trend_strength, atr=atr, psr_acceleration=psr_acceleration,
            rsi_top_cond=rsi_top_cond, rsi_bot_cond=rsi_bot_cond, rsi=rsi,
            is_peak_event=is_peak_event, is_valley_event=is_valley_event,
            vol_spike=vol_spike, volume=v, vol_avg=vol_avg,
            mtf_is_peak=mtf_is_peak, mtf_is_valley=mtf_is_valley,
            high=h, low=l, eff_entropy_thresh=eff_entropy_thresh,
            adaptive_entropy=cfg.adaptive_entropy,
        )

        peak_prob = (self._calc_probability(entropy_1, is_bearish_div, ctx)
                     if (is_peak_state_req or is_potential_peak) else None)
        valley_prob = (self._calc_probability(entropy_1, is_bullish_div, ctx)
                       if (is_valley_state_req or is_potential_valley) else None)

        # effectiveMinProb
        if cfg.adaptive_entropy and trend_strength is not None and atr not in (None, 0):
            eff_min_prob = cfg.min_prob_threshold - (trend_strength / atr * 5)
        else:
            eff_min_prob = float(cfg.min_prob_threshold)

        bar_confirmed = True  # confirmedOnly=true, barstate.isconfirmed always true here

        dist_ok = (self.last_signal_bar is None) or (bi - self.last_signal_bar > eff_min_distance)

        valid_peak = (bar_confirmed and cfg.enable_rpd
                      and (is_peak_state_req or is_potential_peak)
                      and (peak_prob is not None and peak_prob >= eff_min_prob)
                      and dist_ok)
        valid_valley = (bar_confirmed and cfg.enable_rpd
                        and (is_valley_state_req or is_potential_valley)
                        and (valley_prob is not None and valley_prob >= eff_min_prob)
                        and dist_ok)

        if valid_peak:
            self.last_signal_bar = bi
            self.last_valid_peak_price = peak_price_at_pivot
            self.last_valid_peak_velocity = psr_vel_1
            self._ledger_record("RPD_Peak", c_, -1,
                                (peak_price_at_pivot + atr * 0.1) if (not is_na(peak_price_at_pivot) and atr is not None) else float("nan"))
        if valid_valley:
            self.last_signal_bar = bi
            self.last_valid_valley_price = valley_price_at_pivot
            self.last_valid_valley_velocity = psr_vel_1
            self._ledger_record("RPD_Valley", c_, 1,
                                (valley_price_at_pivot - atr * 0.1) if (not is_na(valley_price_at_pivot) and atr is not None) else float("nan"))

        # displayed probability (uses current ledger state, as Pine reads it in draw blocks)
        peak_display = self._display_prob("RPD_Peak", peak_prob) if valid_peak else None
        valley_display = self._display_prob("RPD_Valley", valley_prob) if valid_valley else None

        # ledger bar advance (barstate.isconfirmed always true)
        self._ledger_update(h, l, c_)
        self._ledger_prune()

        return RpdBar(
            t=t, valid_peak=valid_peak, valid_valley=valid_valley,
            peak_prob=peak_prob, valley_prob=valley_prob,
            peak_display=peak_display, valley_display=valley_display,
            r_trend=r_trend, state=state, entropy=entropy,
            psr_velocity=psr_velocity, psr_acceleration=psr_acceleration, rsi=rsi,
            is_peak_event=bool(is_peak_event), is_valley_event=bool(is_valley_event),
        )

    # -------------------------------------------------- sub-calcs
    def _supertrend(self, src: float, mult: float, atr_rpd: Num, close: float) -> int:
        # Pine getSupertrend(_src, _mult, _len):
        #   upper = _src - _mult*atr;  lower = _src + _mult*atr   (note: swapped naming)
        #   upper := close[1] > upper[1] ? max(upper, upper[1]) : upper
        #   lower := close[1] < lower[1] ? min(lower, lower[1]) : lower
        #   trend := trend==-1 and close>lower[1] ? 1 : trend==1 and close<upper[1] ? -1 : trend
        if is_na(atr_rpd):
            # upper/lower are na; the := with close[1]>na stays na. trend unchanged.
            upper = None
            lower = None
            # Pine: ternary with na condition keeps base value (na). Record na history.
            self._st_upper_prev = upper
            self._st_lower_prev = lower
            self._prev_close = close
            return self._st_trend
        upper = src - mult * atr_rpd
        lower = src + mult * atr_rpd
        pc = self._prev_close
        up_prev = self._st_upper_prev
        lo_prev = self._st_lower_prev
        if pc is not None and up_prev is not None and pc > up_prev:
            upper = max(upper, up_prev)
        if pc is not None and lo_prev is not None and pc < lo_prev:
            lower = min(lower, lo_prev)
        trend = self._st_trend
        if trend == -1 and lo_prev is not None and close > lo_prev:
            trend = 1
        elif trend == 1 and up_prev is not None and close < up_prev:
            trend = -1
        self._st_trend = trend
        self._st_upper_prev = upper
        self._st_lower_prev = lower
        self._prev_close = close
        return trend

    def _quantum_state(self, price: Num) -> Optional[int]:
        # ta.highest/ta.lowest(price, period): Pine returns na until `period` bars exist,
        # and na while any value in the window is na (strict-na like the other rolling
        # primitives in pine.py). hlc3_smooth is only na for the first 2 bars.
        self._qsa_buf.append(price)
        if len(self._qsa_buf) < self.cfg.adaptive_period or any(is_na(x) for x in self._qsa_buf):
            return None
        hi = max(self._qsa_buf)
        lo = min(self._qsa_buf)
        if price is None:
            return None
        rng = hi - lo
        if rng > 0:
            return pine_round((price - lo) / rng * (self.cfg.analysis_levels - 1))
        return 0

    def _psr(self, series: Num):
        # velocity = hlc3_smooth - hlc3_smooth[round(period/2)]
        # acceleration = velocity - velocity[1]
        lag = self._psr_lag
        s0 = self._hlc3s[0]
        slag = self._hlc3s[lag]
        if is_na(s0) or is_na(slag):
            vel = None
        else:
            vel = s0 - slag
        vel1 = self._psr_vel_series[0]  # previous bar's velocity (push happens after)
        accel = None if (vel is None or is_na(vel1)) else (vel - vel1)
        return vel, accel

    def _entropy(self, series: Num) -> Num:
        # isUp = series > series[1] ? 1 : 0  (na if series[1] na)
        s1 = self._hlc3s[1]
        if is_na(series) or is_na(s1):
            is_up = None
        else:
            is_up = 1.0 if series > s1 else 0.0
        p = self._entropy_isup.update(is_up)
        if p is None:
            return None  # ta.sma na during warmup
        if p > 0.0 and p < 1.0:
            return (-p * math.log(p) - (1.0 - p) * math.log(1.0 - p)) / math.log(2.0)
        return 0.5

    def _fractals(self, h: float, l: float):
        c = self.cfg
        fs = c.fractal_strength
        self._fh.append(h)
        self._fl.append(l)
        # Pine: only computes when bar_index >= fractalStrength*2, else both stay false.
        if self.bar_index < fs * 2:
            return False, False
        if len(self._fh) < fs * 2 + 1:
            return False, False
        # center index in deque (0=oldest): with maxlen fs*2+1, center = fs
        hs = list(self._fh)
        ls = list(self._fl)
        center = fs
        is_fh = True
        is_fl = True
        hc = hs[center]
        lc = ls[center]
        for i in range(1, fs + 1):
            if nz(hc) <= nz(hs[center + i]) or nz(hc) <= nz(hs[center - i]):
                is_fh = False
            if nz(lc) >= nz(ls[center + i]) or nz(lc) >= nz(ls[center - i]):
                is_fl = False
        return is_fh, is_fl

    def _calc_probability(self, p_entropy: Num, is_divergence: bool, ctx: "_ProbCtx") -> Num:
        # mirrors calculateProbability
        atr = ctx.atr
        ts = ctx.trend_strength if ctx.trend_strength is not None else 0.0
        # base_score = 35 + (trendStrength/atr*15) + (1-p_entropy)*8
        pe = nz(p_entropy, 0.0)
        atr_safe = atr if (atr is not None and atr != 0) else None
        base = 35.0
        if atr_safe is not None:
            base += ts / atr_safe * 15.0
        base += (1.0 - pe) * 8.0
        entropy_score = (5.0 + (1.0 - pe) * 5.0) if pe < ctx.eff_entropy_thresh else -5.0
        accel = nz(ctx.psr_acceleration, 0.0)
        divergence_bonus = (15.0 + abs(accel) * 2.0) if is_divergence else 0.0
        rsi = ctx.rsi
        rsi_bonus = 0.0
        if ((ctx.rsi_top_cond and ctx.is_peak_event) or (ctx.rsi_bot_cond and ctx.is_valley_event)) and rsi is not None:
            rsi_bonus = 5.0 + (rsi - 50.0) / 5.0
        vol_bonus = 0.0
        if ctx.vol_spike and ctx.vol_avg not in (None, 0):
            vol_bonus = 5.0 + (ctx.volume / ctx.vol_avg - 1.0) * 3.0
        adaptive_bonus = 0.0
        if ctx.adaptive_entropy and atr_safe is not None and ts > atr_safe:
            adaptive_bonus = 5.0 + ts * 0.5
        mtf_bonus = 10.0 if ((ctx.mtf_is_peak and ctx.is_peak_event) or (ctx.mtf_is_valley and ctx.is_valley_event)) else 0.0
        if atr_safe is not None:
            bar_range_factor = (ctx.high - ctx.low) / atr_safe
        else:
            bar_range_factor = 0.0
        variation = bar_range_factor * 2.0 - 1.0
        raw = base + entropy_score + divergence_bonus + rsi_bonus + vol_bonus + adaptive_bonus + mtf_bonus + variation
        return min(99.0, max(40.0, pine_round_to(raw, 1)))


class _PineEMA:
    """ta.ema seeded with SMA of first n (matches pine.EMA but tolerant of na stream)."""

    def __init__(self, n: int):
        self.n = n
        self.alpha = 2.0 / (n + 1)
        self.seed: List[float] = []
        self.value: Num = None

    def update(self, x: Num) -> Num:
        if is_na(x):
            # ta.ema propagates last value on na input after seeding; na before.
            return self.value
        if self.value is None:
            self.seed.append(x)
            if len(self.seed) < self.n:
                return None
            self.value = sum(self.seed) / self.n
            return self.value
        self.value = self.alpha * x + (1 - self.alpha) * self.value
        return self.value


@dataclass
class _ProbCtx:
    trend_strength: Num
    atr: Num
    psr_acceleration: Num
    rsi_top_cond: bool
    rsi_bot_cond: bool
    rsi: Num
    is_peak_event: bool
    is_valley_event: bool
    vol_spike: bool
    volume: float
    vol_avg: Num
    mtf_is_peak: bool
    mtf_is_valley: bool
    high: float
    low: float
    eff_entropy_thresh: float
    adaptive_entropy: bool
