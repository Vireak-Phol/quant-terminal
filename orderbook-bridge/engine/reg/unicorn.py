"""FVG Breaker 'Unicorn' setups (CTF + MTF) — Python port of REG v7.4.

Ports the Pine sections: FVG INPUTS, FVG VARIABLES, FVG METHODS (validate,
isLevelInvalidated), CONFLUENCE DETECTION, passQualityFilters,
FVG CURRENT TIMEFRAME SETUP DETECTION, FVG MTF DETECTION (processTimeframeMTF),
FVG VALIDATION & CLEANUP, and the newBullish/newBearish alert logic.

Called once per CONFIRMED chart bar via :meth:`UnicornEngine.update`.

MTF semantics
-------------
Pine pulls higher-timeframe (HTF) series with ``request.security(tf, ...,
lookahead_off)``. On historical bars TradingView returns an HTF bar's FINAL values
only on the chart bar that *closes* that HTF bar; on earlier chart bars within the HTF
bar it returns the previous HTF bar's values. We reproduce this by resampling the 5m
chart stream into HTF buckets aligned to the OANDA:XAUUSD daily roll (17:00
America/New_York) and running a per-timeframe detection pass on the chart bar that is
the last 5m bar of each HTF bucket (detected deterministically from the clock, so no
look-ahead is needed). Each HTF runs its own pivot/ATR/EMA state on its own resampled
series, exactly as ``request.security`` evaluates the requested expressions on the HTF.

Deviation: the chart is 5m, so Pine's "3m"/"5m" sub-chart timeframes are off by default
and not ported (they are under-sampled by request.security and excluded from Pine's
ledger anyway). Weekly ("W") is off by default in Pine and also skipped.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from engine.pine import ATR, EMA, SMA, Pivot

NY = ZoneInfo("America/New_York")
_NA = None


# ───────────────────────── configuration (Pine input defaults) ─────────────────────────


@dataclass
class UnicornConfig:
    # Master
    enable_fvg: bool = True
    enable_mtf: bool = True
    enable_rpd: bool = True
    confirmed_only: bool = True
    global_atr_length: int = 14
    use_rpd_as_filter: bool = False
    rpd_filter_min_prob: float = 60.0
    optimize_for_scalping: bool = True   # "Optimize for Gold Scalping" default ON
    is_preset_minimal: bool = True       # Minimalist (Clean) default preset
    signal_priority: str = "Show All"
    mintick: float = 0.01
    chart_tf_seconds: int = 300  # chart bar length; used to detect the bar that closes an HTF bucket

    # MTF show toggles (Pine defaults). 3m/5m off, W off.
    show_current: bool = True
    show_3min: bool = False
    show_5min: bool = False
    show_15min: bool = True
    show_30min: bool = True
    show_1hour: bool = True
    show_2hour: bool = True
    show_4hour: bool = True
    show_daily: bool = True
    show_weekly: bool = False
    min_confluence_tfs: int = 2
    show_confluence: bool = True

    # FVG settings
    swing_length: int = 5
    fvg_threshold: float = 0.2
    fvg_adapt_thresh: bool = True
    fvg_min_ticks: int = 0
    min_bars_between: int = 10
    invalidation_mode: str = "Close"     # or "Wick"
    delete_invalid: bool = False
    max_active_setups: int = 10
    max_bars_active: int = 500

    # Quality filters
    enable_filters: bool = True
    min_risk_reward: float = 1.5
    filter_trend_alignment: bool = True
    trend_length: int = 20
    filter_volatility: bool = True
    min_volatility: float = 0.5
    filter_price_action: bool = True
    min_candle_size: float = 0.3

    # scoring display tiers (useCalibratedProb default True)
    use_calibrated_prob: bool = True


# Interval (seconds) for each MTF label.  "D" handled specially.
_MTF_SECONDS = {"15m": 900, "30m": 1800, "1H": 3600, "2H": 7200, "4H": 14400}


# ───────────────────────── output dataclasses ─────────────────────────


@dataclass
class ActiveSetup:
    id: int
    tf: str
    side: str            # "bull" / "bear"
    fvg_top: float
    fvg_bottom: float
    breaker_top: float
    breaker_bottom: float
    entry: float
    stop: float
    confluence: int
    score: int


@dataclass
class UnicornBar:
    t: int
    new_bullish: bool
    new_bearish: bool
    active_fvg_count: int
    setups: List[ActiveSetup] = field(default_factory=list)


# ───────────────────────── internal setup record ─────────────────────────


@dataclass
class _Swing:
    price: float
    index: int
    is_high: bool


@dataclass
class _Setup:
    id: int
    is_bullish: bool
    breaker_top: float
    breaker_bottom: float
    breaker_index: int
    fvg_top: float
    fvg_bottom: float
    fvg_index: int
    entry: float
    stop: float
    is_active: bool
    bars_active: int
    timeframe: str
    confluence: int


# ───────────────────────── HTF resampler ─────────────────────────


def _ny_session_day_start(ts: int) -> int:
    """Unix ts of the most recent 17:00 America/New_York boundary at or before ``ts``."""
    dt = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(NY)
    anchor = dt.replace(hour=17, minute=0, second=0, microsecond=0)
    if dt < anchor:
        # before today's 17:00 -> session started at yesterday's 17:00 NY
        prev = datetime.fromtimestamp(ts - 86400, tz=timezone.utc).astimezone(NY)
        anchor = prev.replace(hour=17, minute=0, second=0, microsecond=0)
    return int(anchor.timestamp())


def _bucket_of(ts: int, tf: str) -> int:
    """Open time of the HTF bucket of ``tf`` containing chart time ``ts``.

    Intraday buckets align to the session start (17:00 NY); daily buckets *are* the
    session (17:00 NY roll).
    """
    day_start = _ny_session_day_start(ts)
    if tf == "D":
        return day_start
    secs = _MTF_SECONDS[tf]
    off = (ts - day_start) // secs
    return day_start + off * secs


class _HtfStream:
    """Resamples the 5m chart stream into one HTF and evaluates the requested
    ``request.security`` expressions on its own series.

    On the chart bar that closes an HTF bucket, :meth:`feed` returns the finalized HTF
    OHLC plus ``high[2]/low[2]`` (two HTF bars back), the swing-length pivots, and the
    ATR / SMA(ATR,50) computed on the HTF series — mirroring the Pine request.security
    expression list.
    """

    def __init__(self, tf: str, swing_length: int, atr_len: int, chart_tf_seconds: int = 300):
        self.tf = tf
        self.chart_tf_seconds = chart_tf_seconds
        self.sl = swing_length
        self.atr = ATR(atr_len)
        self.atr_sma = SMA(50)
        self.ph = Pivot(swing_length, swing_length, True)
        self.pl = Pivot(swing_length, swing_length, False)
        self.cur_bucket: Optional[int] = None
        self.o = self.h = self.l = self.c = 0.0
        # history of finalized HTF closes/highs/lows for [2] lookback
        self.hist_high: List[float] = []
        self.hist_low: List[float] = []

    def feed(self, t: int, o: float, h: float, l: float, c: float):
        """Accumulate chart bar into current HTF bucket; if this chart bar closes the
        bucket return the finalized HTF data dict, else return None."""
        b = _bucket_of(t, self.tf)
        if self.cur_bucket is None or b != self.cur_bucket:
            # start a fresh HTF bar
            self.cur_bucket = b
            self.o, self.h, self.l, self.c = o, h, l, c
        else:
            self.h = max(self.h, h)
            self.l = min(self.l, l)
            self.c = c
        # does this chart bar close the HTF bucket?  (next 5m bar starts a new bucket)
        closes = _bucket_of(t + self.chart_tf_seconds, self.tf) != b
        if not closes:
            return None
        # finalize: push into HTF indicator state
        atr = self.atr.update(self.h, self.l, self.c)
        atr_avg = self.atr_sma.update(atr if atr is not None else float("nan"))
        ph = self.ph.update(self.h)
        pl = self.pl.update(self.l)
        high2 = self.hist_high[-2] if len(self.hist_high) >= 2 else None
        low2 = self.hist_low[-2] if len(self.hist_low) >= 2 else None
        data = {
            "open": self.o, "high": self.h, "low": self.l, "close": self.c,
            "high2": high2, "low2": low2,
            "atr": atr, "atr_avg": atr_avg, "ph": ph, "pl": pl,
        }
        self.hist_high.append(self.h)
        self.hist_low.append(self.l)
        return data


# ───────────────────────── engine ─────────────────────────


class UnicornEngine:
    def __init__(self, cfg: Optional[UnicornConfig] = None):
        self.cfg = cfg or UnicornConfig()
        c = self.cfg
        self.bar_index = -1

        # CTF indicator state
        self.atr = ATR(c.global_atr_length)
        self.atr_avg = SMA(20)               # ta.sma(atr,20) for volatility ratio
        self.atr_base = SMA(50)              # ta.sma(atr,50) regime baseline
        self.trend_ema = EMA(c.trend_length)
        self.ph = Pivot(c.swing_length, c.swing_length, True)
        self.pl = Pivot(c.swing_length, c.swing_length, False)

        # rolling OHLC history (index 0 == current)
        self._o: List[float] = []
        self._h: List[float] = []
        self._l: List[float] = []
        self._c: List[float] = []

        self.swings: List[_Swing] = []
        self.setups: List[_Setup] = []

        # per-bar context (set in update)
        self._atr = None
        self._is_up = False
        self._is_down = False
        self._is_high_vol = False
        self._rpd_bull = None
        self._rpd_bear = None
        self._r_trend = 0

        # MTF streams
        self._htf: Dict[str, _HtfStream] = {}
        for tf, on in self._enabled_tfs().items():
            if on:
                self._htf[tf] = _HtfStream(tf, c.swing_length, c.global_atr_length, c.chart_tf_seconds)

    def _enabled_tfs(self) -> Dict[str, bool]:
        c = self.cfg
        if not c.enable_mtf or not c.enable_fvg:
            return {}
        allow_sub = not c.optimize_for_scalping
        return {
            "15m": c.show_15min,
            "30m": c.show_30min,
            "1H": c.show_1hour,
            "2H": c.show_2hour,
            "4H": c.show_4hour,
            "D": c.show_daily,
            # sub-chart TFs only when not scalping; chart is 5m so 3m/5m unused regardless
        }

    # ---- helpers mirroring Pine ----

    def _px(self, series: List[float], k: int):
        return series[k] if k < len(series) else None

    def _f_fvg_regime_mult(self, regime: Optional[float]) -> float:
        if not self.cfg.fvg_adapt_thresh or regime is None:
            return 1.0
        if regime < 0.70:
            return 1.75
        if regime < 0.85:
            return 1.30
        return 1.0

    def _display_prob(self, is_bull: bool) -> Optional[float]:
        """f_displayProb — without the ledger we only have the heuristic. The engine
        accepts an external rpd probability; return it (already on whatever scale the
        caller supplies). None propagates to na like Pine."""
        return self._rpd_bull if is_bull else self._rpd_bear

    def _calc_signal_score(self, is_trend_aligned: bool, rpd_prob: Optional[float],
                           confluence: int, liq_sweep: bool) -> int:
        c = self.cfg
        tier_high = 60.0 if c.use_calibrated_prob else 80.0
        tier_mid = 52.0 if c.use_calibrated_prob else 60.0
        tier_show = 50.0 if c.use_calibrated_prob else 75.0
        score = 0
        if is_trend_aligned:
            score += 30
        if rpd_prob is not None and not (isinstance(rpd_prob, float) and math.isnan(rpd_prob)):
            if rpd_prob >= tier_high:
                score += 25
            elif rpd_prob >= tier_mid:
                score += 15
            elif rpd_prob >= tier_show:
                score += 5
        if confluence >= 3:
            score += 20
        elif confluence >= 2:
            score += 12
        if liq_sweep:
            score += 25
        return min(100, score)

    def _score_for(self, s: _Setup) -> int:
        rpd = self._display_prob(s.is_bullish)
        is_trend = (self._r_trend == 1) if s.is_bullish else (self._r_trend == -1)
        return self._calc_signal_score(is_trend, rpd, s.confluence, False)

    def _calculate_confluence(self, new_setup: _Setup) -> int:
        conf = 1
        tol = (self._atr or 0.0) * 0.5
        for s in self.setups:
            if s is new_setup:
                continue
            if s.is_active and s.is_bullish == new_setup.is_bullish:
                price_overlap = not (s.fvg_bottom > new_setup.fvg_top or s.fvg_top < new_setup.fvg_bottom)
                entry_near = abs(s.entry - new_setup.entry) < tol
                if price_overlap or entry_near:
                    conf += 1
        return conf

    def _pass_quality_filters(self, is_bull: bool, entry: float, stop: float,
                              candle_size: float, fvg_top: float, fvg_bot: float) -> bool:
        c = self.cfg
        if not c.enable_filters:
            return True
        risk = abs(entry - stop)
        fvg_size = abs(entry - (fvg_top if is_bull else fvg_bot))
        potential_reward = fvg_size * 2
        rr = potential_reward / risk if risk > 0 else 0
        if rr < c.min_risk_reward:
            return False
        if c.filter_trend_alignment:
            if is_bull and self._is_down:
                return False
            if (not is_bull) and self._is_up:
                return False
        if c.filter_volatility:
            if not self._is_high_vol:
                return False
        if c.filter_price_action:
            if candle_size < (self._atr or 0.0) * c.min_candle_size:
                return False
        if c.use_rpd_as_filter and c.enable_rpd:
            heuristic = self._rpd_bull if is_bull else self._rpd_bear
            prob = heuristic if heuristic is not None else 0.0
            if prob < c.rpd_filter_min_prob:
                return False
        return True

    def _is_level_invalidated(self, level: float, start_index: int, end_index: int,
                              check_below: bool, mode: str) -> bool:
        """method isLevelInvalidated — scans close/wick from [1]..len back."""
        length = min(end_index - start_index - 1, 100)
        if length >= 1:
            for i in range(1, length + 1):
                if mode == "Wick":
                    price = (self._px(self._l, i) if check_below else self._px(self._h, i))
                else:
                    price = self._px(self._c, i)
                if price is None:
                    continue
                if (price < level) if check_below else (price > level):
                    return True
        return False

    # ---- main update ----

    def update(self, t: int, o: float, h: float, l: float, c: float, v: float = 0.0,
               rpd_prob_bull: Optional[float] = None, rpd_prob_bear: Optional[float] = None,
               r_trend: int = 0) -> UnicornBar:
        cfg = self.cfg
        self.bar_index += 1
        bi = self.bar_index
        self._rpd_bull = rpd_prob_bull
        self._rpd_bear = rpd_prob_bear
        self._r_trend = r_trend

        # push OHLC history (index 0 == current)
        self._o.insert(0, o); self._h.insert(0, h); self._l.insert(0, l); self._c.insert(0, c)
        if len(self._o) > 600:
            self._o.pop(); self._h.pop(); self._l.pop(); self._c.pop()

        # indicators
        atr = self.atr.update(h, l, c)
        self._atr = atr
        atr_avg = self.atr_avg.update(atr if atr is not None else float("nan"))
        atr_base = self.atr_base.update(atr if atr is not None else float("nan"))
        trend_ema = self.trend_ema.update(c)
        self._is_up = trend_ema is not None and c > trend_ema
        self._is_down = trend_ema is not None and c < trend_ema
        vol_ratio = (atr / atr_avg) if (atr is not None and atr_avg) else None
        self._is_high_vol = vol_ratio is not None and vol_ratio > cfg.min_volatility

        # pivots (confirmed `swing_length` bars ago)
        ph = self.ph.update(h)
        pl = self.pl.update(l)
        if ph is not None:
            self.swings.append(_Swing(ph, bi - cfg.swing_length, True))
            if len(self.swings) > 30:
                self.swings.pop(0)
        if pl is not None:
            self.swings.append(_Swing(pl, bi - cfg.swing_length, False))
            if len(self.swings) > 30:
                self.swings.pop(0)

        new_bullish = False
        new_bearish = False
        bar_confirmed = True  # engine is called on confirmed bars only

        # ── FVG DETECTION (CTF) ──
        self._detect_ctf(bi, o, h, l, c, atr, atr_base, bar_confirmed)

        # ── FVG MTF DETECTION ──
        if cfg.enable_mtf and cfg.enable_fvg and bar_confirmed:
            for tf, stream in self._htf.items():
                data = stream.feed(t, o, h, l, c)
                if data is not None:
                    self._detect_mtf(bi, tf, data)

        # ── newBullish / newBearish (last pushed setup with id == bar_index) ──
        if cfg.enable_fvg and self.setups:
            last = self.setups[-1]
            if last.id == bi:
                p = 1
                if last.confluence >= 3:
                    p = 3
                elif last.confluence >= 2:
                    p = 2
                allow = True
                if cfg.signal_priority == "A+ Only" and p < 3:
                    allow = False
                elif cfg.signal_priority == "A and A+ Only" and p < 2:
                    allow = False
                if allow:
                    if last.is_bullish:
                        new_bullish = True
                    else:
                        new_bearish = True

        # ── FVG VALIDATION & CLEANUP ──
        self._validate_cleanup(bi, o, h, l, c)

        # ── active FVG count (Pine "Active FVG Setups" plot) ──
        active_count = sum(1 for s in self.setups if s.is_active)

        out_setups = [
            ActiveSetup(
                id=s.id, tf=s.timeframe, side="bull" if s.is_bullish else "bear",
                fvg_top=s.fvg_top, fvg_bottom=s.fvg_bottom,
                breaker_top=s.breaker_top, breaker_bottom=s.breaker_bottom,
                entry=s.entry, stop=s.stop, confluence=s.confluence,
                score=self._score_for(s),
            )
            for s in self.setups if s.is_active
        ]

        return UnicornBar(t=t, new_bullish=new_bullish, new_bearish=new_bearish,
                          active_fvg_count=active_count, setups=out_setups)

    # ---- CTF detection ----

    def _detect_ctf(self, bi, o, h, l, c, atr, atr_base, bar_confirmed):
        cfg = self.cfg
        if not (cfg.enable_fvg and cfg.show_current and bar_confirmed):
            return
        h2 = self._px(self._h, 2)
        l0 = self._px(self._l, 0)
        l2 = self._px(self._l, 2)
        h0 = self._px(self._h, 0)
        if atr is None or h2 is None or l2 is None:
            return

        regime = (atr / atr_base) if atr_base else 1.0
        min_size = max(atr * cfg.fvg_threshold * self._f_fvg_regime_mult(regime),
                       cfg.mintick * cfg.fvg_min_ticks)

        is_bull_fvg = h2 < l0
        bull_top, bull_bot = l0, h2
        valid_bull = is_bull_fvg and (bull_top - bull_bot) > min_size

        is_bear_fvg = l2 > h0
        bear_top, bear_bot = l2, h0
        valid_bear = is_bear_fvg and (bear_top - bear_bot) > min_size

        # count CTF setups + last setup bar
        ctf_count = 0
        last_setup_bar = -999
        for s in self.setups:
            if s.timeframe == "CTF" and s.is_active:
                ctf_count += 1
                if s.id > last_setup_bar:
                    last_setup_bar = s.id
        can_create = (bi - last_setup_bar) >= cfg.min_bars_between

        # BULLISH
        if valid_bull and ctf_count < cfg.max_active_setups and can_create and self.swings:
            for i in range(len(self.swings) - 1, -1, -1):
                s = self.swings[i]
                is_first_break = not self._is_level_invalidated(s.price, s.index, bi, False, cfg.invalidation_mode)
                is_body_break = c > s.price and o < c
                if s.is_high and is_body_break and is_first_break:
                    offset = bi - s.index
                    b_open = self._px(self._o, offset)
                    b_close = self._px(self._c, offset)
                    if b_open is None or b_close is None:
                        continue
                    btop = max(b_open, b_close)
                    bbot = min(b_open, b_close)
                    overlap = not (bbot > bull_top or btop < bull_bot)
                    if overlap:
                        stop = min(self._px(self._l, 0), self._px(self._l, 1), self._px(self._l, 2))
                        candle_size = abs(c - o)
                        if self._pass_quality_filters(True, bull_bot, stop, candle_size, bull_top, bull_bot):
                            setup = _Setup(bi, True, btop, bbot, s.index, bull_top, bull_bot, bi,
                                           bull_bot, stop, True, 0, "CTF", 0)
                            self.setups.append(setup)
                            setup.confluence = self._calculate_confluence(setup)
                            for ex in self.setups:
                                if ex.is_active and ex.is_bullish and ex.id != setup.id:
                                    ex.confluence = self._calculate_confluence(ex)
                            break

        # BEARISH
        if valid_bear and ctf_count < cfg.max_active_setups and can_create and self.swings:
            for i in range(len(self.swings) - 1, -1, -1):
                s = self.swings[i]
                is_first_break = not self._is_level_invalidated(s.price, s.index, bi, True, cfg.invalidation_mode)
                is_body_break = c < s.price and o > c
                if (not s.is_high) and is_body_break and is_first_break:
                    offset = bi - s.index
                    b_open = self._px(self._o, offset)
                    b_close = self._px(self._c, offset)
                    if b_open is None or b_close is None:
                        continue
                    btop = max(b_open, b_close)
                    bbot = min(b_open, b_close)
                    overlap = not (bbot > bear_top or btop < bear_bot)
                    if overlap:
                        stop = max(self._px(self._h, 0), self._px(self._h, 1), self._px(self._h, 2))
                        candle_size = abs(c - o)
                        if self._pass_quality_filters(False, bear_top, stop, candle_size, bear_top, bear_bot):
                            setup = _Setup(bi, False, btop, bbot, s.index, bear_top, bear_bot, bi,
                                           bear_top, stop, True, 0, "CTF", 0)
                            self.setups.append(setup)
                            setup.confluence = self._calculate_confluence(setup)
                            for ex in self.setups:
                                if ex.is_active and (not ex.is_bullish) and ex.id != setup.id:
                                    ex.confluence = self._calculate_confluence(ex)
                            break

    # ---- MTF detection ----

    def _detect_mtf(self, bi, tf_label, d):
        cfg = self.cfg
        atr = d["atr"]
        atr_avg = d["atr_avg"]
        if atr is None:
            return
        regime = (atr / atr_avg) if atr_avg else 1.0
        min_size = max(atr * cfg.fvg_threshold * self._f_fvg_regime_mult(regime),
                       cfg.mintick * cfg.fvg_min_ticks)

        hi2, lo0, lo2, hi0 = d["high2"], d["low"], d["low2"], d["high"]
        hopen, hclose, hhigh, hlow = d["open"], d["close"], d["high"], d["low"]
        hph, hpl = d["ph"], d["pl"]

        bull_fvg = hi2 is not None and hi2 < lo0
        bull_top, bull_bot = lo0, hi2
        valid_bull = bull_fvg and (bull_top - bull_bot) > min_size

        bear_fvg = lo2 is not None and lo2 > hi0
        bear_top, bear_bot = lo2, hi0
        valid_bear = bear_fvg and (bear_top - bear_bot) > min_size

        tf_count = 0
        last_setup_bar = -999
        for s in self.setups:
            if s.timeframe == tf_label and s.is_active:
                tf_count += 1
                if s.id > last_setup_bar:
                    last_setup_bar = s.id
        can_create = (bi - last_setup_bar) >= cfg.min_bars_between

        if valid_bull and hph is not None and tf_count < cfg.max_active_setups and can_create:
            if hclose > hph and hopen < hclose:
                btop = max(hopen, hclose)
                bbot = min(hopen, hclose)
                overlap = not (bbot > bull_top or btop < bull_bot)
                if overlap:
                    stop = hlow
                    candle_size = abs(hclose - hopen)
                    if self._pass_quality_filters(True, bull_bot, stop, candle_size, bull_top, bull_bot):
                        setup = _Setup(bi, True, btop, bbot, bi - 1, bull_top, bull_bot, bi,
                                       bull_bot, stop, True, 0, tf_label, 0)
                        self.setups.append(setup)
                        setup.confluence = self._calculate_confluence(setup)

        if valid_bear and hpl is not None and tf_count < cfg.max_active_setups and can_create:
            if hclose < hpl and hopen > hclose:
                btop = max(hopen, hclose)
                bbot = min(hopen, hclose)
                overlap = not (bbot > bear_top or btop < bear_bot)
                if overlap:
                    stop = hhigh
                    candle_size = abs(hclose - hopen)
                    if self._pass_quality_filters(False, bear_top, stop, candle_size, bear_top, bear_bot):
                        setup = _Setup(bi, False, btop, bbot, bi - 1, bear_top, bear_bot, bi,
                                       bear_top, stop, True, 0, tf_label, 0)
                        self.setups.append(setup)
                        setup.confluence = self._calculate_confluence(setup)

    # ---- validation & cleanup (method validate) ----

    def _validate_cleanup(self, bi, o, h, l, c):
        cfg = self.cfg
        if not (cfg.enable_fvg and self.setups):
            return
        for i in range(len(self.setups) - 1, -1, -1):
            s = self.setups[i]
            if s.is_active:
                s.bars_active += 1
                invalid = False
                check_high = h if cfg.invalidation_mode == "Wick" else c
                check_low = l if cfg.invalidation_mode == "Wick" else c
                if s.is_bullish:
                    if check_low < s.stop:
                        invalid = True
                else:
                    if check_high > s.stop:
                        invalid = True
                if s.bars_active > cfg.max_bars_active:
                    invalid = True
                if invalid:
                    s.is_active = False
            if (not s.is_active) and cfg.delete_invalid:
                self.setups.pop(i)

        # keep memory bounded like Pine's cleanup of old inactive setups
        if len(self.setups) > cfg.max_active_setups * 7 + 20:
            remove = 0
            i = 0
            while i < len(self.setups) and remove < 10:
                if not self.setups[i].is_active:
                    self.setups.pop(i)
                    remove += 1
                else:
                    i += 1
