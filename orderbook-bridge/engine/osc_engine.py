"""
OSC-VIP v7.4 Institutional — bar-for-bar Python port.

Source of truth: ``pine-strategy/7.4/OSC-vip-v7-4-lite.pine``. Section numbers in the
comments below refer to that file so every block can be audited against the Pine.

The engine is *closed-bar only* (Pine ``confirmedOnly = true``): ``update()`` is called
once per finalized chart bar, which makes live behaviour identical to backtest behaviour.

Inputs per bar (``BarInput``)
  * OHLCV of the chart bar (open time in epoch seconds).
  * ``ltf_flows``: signed per-intrabar flow values (Pine ``request.security_lower_tf``
    of ``upAndDownVolume()``). ``None``/empty = lower-TF data unavailable. Use
    ``pine_ltf_flows`` for Pine parity or ``taker_ltf_flows`` for exchange-true delta.
  * ``htf``: previous *closed* 4H bar values (EMA200, 50-bar swing high/low, ATR14).
  * ``htf_new_bucket``: Pine ``timeframe.change("240")``.
  * ``dxy`` / ``vix``: macro closes aligned to the bar (``None`` = neutral / disabled).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Sequence, Tuple

from .pine import (
    ATR, EMA, SMA, Correlation, Hist, Lowest, Highest, Pivot, Stdev, Sum,
    clamp, is_na, nz, wilson_interval,
)
from .sessions import KillzoneConfig, session_flags

Num = Optional[float]


# ─────────────────────────────────────────────────────────────────────────────
# Inputs / config
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class OscConfig:
    """Defaults equal the Pine input defaults (verified against the live chart inputs)."""

    # §1 shock / HTF
    use_shock_guard: bool = True
    shock_atr_mult: float = 3.0
    shock_cooldown: int = 15
    use_htf_trend_filter: bool = True
    # independence
    corr_window: int = 100
    # bayes
    enable_bayes: bool = True
    base_prior: float = 0.50
    min_aplus: float = 65.0
    signal_cooldown: int = 3
    # oscillator
    rolling_vwap_bars: int = 24
    z_window: int = 40
    use_cf: bool = True
    er_len: int = 100
    er_trend: float = 0.45
    er_range: float = 0.20
    # micro
    use_vpin: bool = True
    vpin_thresh: float = 0.85
    vpin_buckets: int = 15
    use_dxy: bool = True
    dxy_corr_win: int = 50
    dxy_decouple: float = -0.30
    use_session_stops: bool = True
    session_vol_win: int = 100
    session_sl_mult: float = 1.5
    session_tp1_mult: float = 2.0
    session_tp2_mult: float = 3.5
    use_queue_depletion: bool = True
    cvd_div_lookback: int = 8
    # killzones
    killzones: KillzoneConfig = field(default_factory=KillzoneConfig)
    # calibration layer
    use_ledger_bridge: bool = True
    use_dynamic_threshold: bool = True
    use_risk_proxy: bool = True
    use_asian_breakout: bool = True
    use_temporal_decay: bool = True
    use_retest_mode: bool = False
    retest_max_age: int = 40
    use_liq_trap: bool = True
    use_eqs: bool = True
    # vacuum
    vac_enable: bool = True
    vac_pivot_len: int = 5
    vac_clust_tol_atr: float = 0.30
    vac_lookback: int = 150
    vac_disp_len: int = 3
    vac_fvg_min_atr: float = 0.20
    vac_prox_atr: float = 1.5
    vac_max_zones: int = 3
    # hopla
    hopla_range: int = 27
    hopla_multiplier: int = 1
    # toggles
    enable_fvg: bool = True
    enable_smc: bool = True
    enable_liquidity: bool = True
    # performance tracker
    aplus_horizon: int = 20
    # instrument
    mintick: float = 0.01
    swing_len: int = 5


@dataclass
class HtfValues:
    ema200: Num
    swing_high: Num
    swing_low: Num
    atr: Num


@dataclass
class BarInput:
    t: int
    o: float
    h: float
    l: float
    c: float
    v: float
    ltf_flows: Optional[Sequence[float]] = None
    htf: Optional[HtfValues] = None
    htf_new_bucket: bool = False
    dxy: Num = None
    vix: Num = None


def pine_up_down_volume(o: float, h: float, l: float, c: float, v: float) -> float:
    """Pine ``upAndDownVolume()`` evaluated on one intrabar (location-of-close proxy)."""
    rng = h - l
    mid = (h + l) / 2.0
    lr = (c - mid) / (rng / 2.0) if rng > 0 else 0.0
    return clamp(lr, -1.0, 1.0) * max(nz(v), 1e-10)


def pine_ltf_flows(intrabars: Sequence[Sequence[float]]) -> List[float]:
    """Intrabars as (o, h, l, c, v) -> Pine proxy flows (for TradingView parity)."""
    return [pine_up_down_volume(*b[:5]) for b in intrabars]


def taker_ltf_flows(intrabars: Sequence[Tuple[float, float]]) -> List[float]:
    """Intrabars as (volume, taker_buy_volume) -> exchange-true signed delta per intrabar.

    Binance klines carry taker-buy base volume, so delta = buy - sell = 2*takerBuy - vol.
    This is strictly better information than the Pine close-location proxy.
    """
    return [2.0 * tb - vol for vol, tb in intrabars]


# ─────────────────────────────────────────────────────────────────────────────
# Ledger records (§4b WP-B1.4 self-contained calibration bridge)
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class _OscRecord:
    sig_type: str
    entry_bar: int
    entry: float
    direction: int
    stop: Num
    risk: Num
    horizon: int = 20
    elapsed: int = 0
    closed: bool = False
    win: bool = False


@dataclass
class _AplusTrade:
    entry: float
    tp: float
    sl: float
    risk: float
    opened_bar: int
    is_bull: bool


@dataclass
class VacuumPocket:
    side: str  # "high" (above / buy-side pool) | "low"
    price: float
    top: float
    bottom: float
    strength: int  # 3 = equal highs/lows, 2 = FVG void, 1 = displacement void
    birth_bar: int
    birth_time: int


# ─────────────────────────────────────────────────────────────────────────────
# Per-bar output
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class OscBar:
    bar_index: int
    t: int
    close: float
    ready: bool
    # volatility / regime
    atr14: Num
    atr100: Num
    shock_hard: bool
    shock_soft: bool
    shock_start: bool
    er: float
    regime: str
    htf_bull: bool
    htf_bear: bool
    htf_extension: float
    # oscillators
    vwap: float
    vwap_z: float
    ofp_slope_z: float
    smpi: Num
    smpi_slope: Num
    snr: Num
    vol_z: float
    rng_z: float
    is_absorption: bool
    is_accumulating: bool
    toxic_flow: bool
    vpin: Num
    cvd_slope_z: float
    ltf_ok: bool
    dxy_corr: Num
    risk_off: bool
    risk_on: bool
    session_vol: Num
    # sessions
    killzone: str
    active_killzone: bool
    kz_confirmed: bool
    asian_mid: Num
    breakout_quality: float
    # structure
    choch_bull: bool
    choch_bear: bool
    trend_dir: int
    fvg_bull: bool
    fvg_bear: bool
    fvg_displaced_bull: bool
    fvg_displaced_bear: bool
    fvg_top_bull: Num
    fvg_bot_bull: Num
    fvg_top_bear: Num
    fvg_bot_bear: Num
    ob_bull: bool
    ob_bear: bool
    ob_bull_zone: Optional[Tuple[float, float]]
    ob_bear_zone: Optional[Tuple[float, float]]
    liq_sweep_bull: bool
    liq_sweep_bear: bool
    liq_trap_bull: bool
    liq_trap_bear: bool
    # vacuum
    vac_above: Num
    vac_below: Num
    vac_band: float
    vac_align_bull: bool
    vac_align_bear: bool
    vacuum_pockets: List[VacuumPocket]
    # hopla
    hopla: Dict[str, float]
    # scoring
    k_active: int
    n_eff: float
    r_bar: float
    prior: float
    long_prob: float
    short_prob: float
    long_weights: Dict[str, float]
    short_weights: Dict[str, float]
    eqs: float
    adj_long: float
    adj_short: float
    dynamic_min: float
    has_bull_setup: bool
    has_bear_setup: bool
    long_primary: str
    short_primary: str
    aplus_bull: bool
    aplus_bear: bool
    struct_bull: bool
    struct_bear: bool
    trap_bull: bool
    trap_bear: bool
    gates: Dict[str, bool]
    # Pine A+ performance tracker
    aplus_stats: Dict[str, float]

    def to_dict(self) -> Dict:
        d = asdict(self)
        return d


def _gt(a: Num, b: Num) -> bool:
    return a is not None and b is not None and a > b


def _lt(a: Num, b: Num) -> bool:
    return a is not None and b is not None and a < b


def _ge(a: Num, b: Num) -> bool:
    return a is not None and b is not None and a >= b


def _le(a: Num, b: Num) -> bool:
    return a is not None and b is not None and a <= b


def _clamp_z(x: Num) -> float:
    return max(min(nz(x), 5.0), -5.0)


def _safe_div_z(x: Num, mu: Num, sd: Num) -> float:
    """Pine: ``sd != 0 ? (x - mu) / sd : 0.0`` — na comparisons are false."""
    if sd is None or sd == 0 or x is None or mu is None:
        return 0.0
    return (x - mu) / sd


class OscEngine:
    """Incremental OSC-VIP v7.4 engine. Call ``update(BarInput)`` once per closed bar."""

    def __init__(self, cfg: Optional[OscConfig] = None):
        self.cfg = cfg or OscConfig()
        c = self.cfg
        self.bi = -1
        H = 300
        self.o = Hist(H); self.h = Hist(H); self.l = Hist(H); self.c = Hist(H); self.t = Hist(H)
        # §3
        self.atr14 = ATR(14)
        self.atr100 = ATR(100)
        self.last_shock_bar = -999
        self.shock_active_prev = False
        self.pv_roll = Sum(c.rolling_vwap_bars)
        self.v_roll = Sum(c.rolling_vwap_bars)
        self.res_mu = SMA(c.z_window); self.res_sd = Stdev(c.z_window)
        self.m1 = SMA(c.z_window); self.m2 = SMA(c.z_window); self.m3 = SMA(c.z_window); self.m4 = SMA(c.z_window)
        self.cumul = Hist(H)
        self.last_vol = Hist(3)
        self.ofp_mu = SMA(c.z_window); self.ofp_sd = Stdev(c.z_window)
        self.roll_buy = Sum(c.vpin_buckets); self.roll_sell = Sum(c.vpin_buckets)
        self.cvd_sd = Stdev(c.z_window); self.cvd_long_sd = Stdev(c.z_window)
        self.dxy_corr = Correlation(c.dxy_corr_win)
        self.vol_mu = SMA(c.z_window); self.vol_sd = Stdev(c.z_window)
        self.rng_mu = SMA(c.z_window); self.rng_sd = Stdev(c.z_window)
        self.accum = Sum(5)
        self.er_path = Sum(c.er_len)
        self.smpi_ema = EMA(3)
        self.smpi = Hist(3)
        self.smpi_sd = Stdev(20)
        self.in_london_prev = False
        self.asian_high: Num = None; self.asian_low: Num = None
        self.asian_mid: Num = None; self.asian_range: Num = None
        self.ret_sd = Stdev(c.session_vol_win)
        self.london_vol: Num = None; self.ny_vol: Num = None; self.asia_vol: Num = None
        # §4
        self.ph = Pivot(c.swing_len, c.swing_len, True)
        self.pl = Pivot(c.swing_len, c.swing_len, False)
        self.last_high: Num = None; self.last_low: Num = None
        self.x_high_prev: Num = None; self.x_low_prev: Num = None
        self.trend_dir = 0
        self.last_ob_bull_bar = -999; self.last_ob_bear_bar = -999
        self.low20 = Lowest(20); self.high20 = Highest(20)
        self.low20_prev: Num = None; self.high20_prev: Num = None
        self.liq_sweep_bull_prev = False; self.liq_sweep_bear_prev = False
        self.rt = {k: None for k in (
            "bull_ob_top", "bull_ob_bot", "bear_ob_top", "bear_ob_bot",
            "bull_fvg_top", "bull_fvg_bot", "bear_fvg_top", "bear_fvg_bot",
            "bull_ob_created", "bear_ob_created", "bull_fvg_created", "bear_fvg_created")}
        # §4b vacuum
        self.vac_ph = Pivot(c.vac_pivot_len, c.vac_pivot_len, True)
        self.vac_pl = Pivot(c.vac_pivot_len, c.vac_pivot_len, False)
        self.vac_hi: List[VacuumPocket] = []
        self.vac_lo: List[VacuumPocket] = []
        self.vac_sw_hi: List[Tuple[float, int]] = []
        self.vac_sw_lo: List[Tuple[float, int]] = []
        self.disp_hi = Hist(16); self.disp_lo = Hist(16)
        # §5
        self.corrs = [Correlation(c.corr_window) for _ in range(15)]
        self.r_bar = 0.0
        self.ledger: List[_OscRecord] = []
        self.open_ledger: List[_OscRecord] = []
        self.last_bull_setup_bar = -999; self.last_bear_setup_bar = -999
        self.last_aplus_bull_bar = -999; self.last_aplus_bear_bar = -999
        self.sd20 = Stdev(20); self.sd20_sma = SMA(100)
        # §6 tracker
        self.aplus_open: List[_AplusTrade] = []
        self.total_aplus = 0; self.resolved_aplus = 0; self.win_aplus = 0
        self.timeout_aplus = 0; self.aplus_sum_r = 0.0

    # ── ledger helpers (§4b) ────────────────────────────────────────────────
    def _ledger_record(self, sig_type: str, entry: float, direction: int, stop: Num, atr14: Num) -> None:
        r_floor = max(atr14 * 0.5, self.cfg.mintick * 10) if atr14 is not None else None
        wrong_side = stop is not None and (stop >= entry if direction == 1 else stop <= entry)
        r = None if (wrong_side or stop is None) else abs(entry - stop)
        if r is None or r <= 0:
            r = max(atr14 * 1.5, r_floor) if atr14 is not None else None
            stop = (entry - r if direction == 1 else entry + r) if r is not None else None
        elif r_floor is not None and r < r_floor:
            r = r_floor
            stop = entry - r if direction == 1 else entry + r
        rec = _OscRecord(sig_type, self.bi, entry, direction, stop, r)
        self.ledger.append(rec)
        self.open_ledger.append(rec)

    def _ledger_update(self, h: float, l: float, c: float) -> None:
        for i in range(len(self.open_ledger) - 1, -1, -1):
            rec = self.open_ledger[i]
            rec.elapsed += 1
            touched = (rec.stop is not None) and (l <= rec.stop if rec.direction == 1 else h >= rec.stop)
            if touched:
                rec.closed = True
                rec.win = False
                del self.open_ledger[i]
            elif rec.elapsed >= rec.horizon:
                pnl = c - rec.entry if rec.direction == 1 else rec.entry - c
                rec.win = pnl > 0
                rec.closed = True
                del self.open_ledger[i]

    def cal_stats(self, sig_type: str) -> Tuple[float, int]:
        wins = total = 0
        for rec in reversed(self.ledger):
            if rec.sig_type == sig_type and rec.closed:
                total += 1
                if rec.win:
                    wins += 1
                if total >= 50:
                    break
        rate = ((wins + 2.0) / (total + 4.0)) * 100.0 if total > 0 else 50.0
        return rate, total

    # ── vacuum helpers (§4b) ────────────────────────────────────────────────
    def _vac_fill_pct(self, top: float, bot: float, birth: int) -> float:
        n = min(self.bi - birth, 250)
        if n < 1:
            return 0.0
        filled = 0
        for i in range(n):
            lo = self.l[i]; hi = self.h[i]
            if lo is not None and hi is not None and lo <= top and hi >= bot:
                filled += 1
        return filled / n

    def _vac_add(self, is_hi: bool, price: float, top: float, bot: float, strength: int, atr14: float) -> None:
        pockets = self.vac_hi if is_hi else self.vac_lo
        for p in reversed(pockets):
            if abs(p.price - price) <= atr14 * self.cfg.vac_clust_tol_atr:
                if strength > p.strength:
                    p.strength = strength
                return
        pockets.append(VacuumPocket("high" if is_hi else "low", price, top, bot, strength, self.bi, int(self.t[0])))

    def _vac_prune(self, is_hi: bool, close: float) -> None:
        pockets = self.vac_hi if is_hi else self.vac_lo
        cfg = self.cfg
        for i in range(len(pockets) - 1, -1, -1):
            p = pockets[i]
            dead = (close > p.top if is_hi else close < p.bottom) or (self.bi - p.birth_bar) > cfg.vac_lookback \
                or self._vac_fill_pct(p.top, p.bottom, p.birth_bar) >= 0.85
            if dead:
                del pockets[i]
        while len(pockets) > cfg.vac_max_zones:
            weak = 0
            for i in range(1, len(pockets)):
                if pockets[i].strength < pockets[weak].strength or (
                        pockets[i].strength == pockets[weak].strength and pockets[i].birth_bar < pockets[weak].birth_bar):
                    weak = i
            del pockets[weak]

    def _vac_clean_swings(self, store: List[Tuple[float, int]], is_hi: bool, close: float) -> None:
        for i in range(len(store) - 1, -1, -1):
            p, b = store[i]
            if (self.bi - b) > self.cfg.vac_lookback or (close > p if is_hi else close < p):
                del store[i]

    # ── main update ─────────────────────────────────────────────────────────
    def update(self, bar: BarInput) -> OscBar:  # noqa: C901 — mirrors Pine top-to-bottom
        cfg = self.cfg
        self.bi += 1
        bi = self.bi
        o, h, l, c, v = bar.o, bar.h, bar.l, bar.c, bar.v
        close1 = self.c[0]  # previous close before push
        self.o.push(o); self.h.push(h); self.l.push(l); self.c.push(c); self.t.push(bar.t)

        # ═══ §3 microstructure ═══
        atr14 = self.atr14.update(h, l, c)
        tr = self.atr14.last_tr
        atr100 = self.atr100.update(h, l, c)
        price_ref = (h + l + c) / 3.0
        vol_ref = max(nz(v), 1e-10)

        is_shock_bar = _gt(tr, atr100 * cfg.shock_atr_mult if atr100 is not None else None)
        if is_shock_bar:
            self.last_shock_bar = bi
        bss = bi - self.last_shock_bar
        shock_hard = cfg.use_shock_guard and bss <= 3
        shock_soft = cfg.use_shock_guard and 3 < bss <= cfg.shock_cooldown
        shock_start = shock_hard and not self.shock_active_prev
        self.shock_active_prev = shock_hard

        # HTF 4H EMA200 guard (prior closed 4H values)
        htf = bar.htf or HtfValues(None, None, None, None)
        htf_bull = _gt(c, htf.ema200)
        htf_bear = _lt(c, htf.ema200)
        swing_mid = (nz(htf.swing_high, h) + nz(htf.swing_low, l)) / 2.0
        htf_atr = htf.atr if htf.atr is not None else atr14
        htf_ext = (c - swing_mid) / htf_atr if _gt(htf_atr, 0.0) else 0.0

        # Rolling VWAP
        pv = self.pv_roll.update(price_ref * vol_ref)
        vv = self.v_roll.update(vol_ref)
        vwap = pv / vv if (vv is not None and vv != 0 and pv is not None) else price_ref

        # Cornish-Fisher VWAP Z
        resid = price_ref - vwap
        mu = self.res_mu.update(resid)
        sd_raw = self.res_sd.update(resid)
        vwap_sd = max(sd_raw, 0.20 * atr14) if (sd_raw is not None and atr14 is not None) else None
        m1 = self.m1.update(resid); m2 = self.m2.update(resid * resid)
        m3 = self.m3.update(resid ** 3); m4 = self.m4.update(resid ** 4)
        skew: Num; kurt: Num
        if cfg.use_cf:
            if None in (m1, m2, m3, m4):
                skew = kurt = None
            else:
                var_ = max(m2 - m1 * m1, 0.0)
                s3 = m3 - 3.0 * m1 * m2 + 2.0 * m1 ** 3
                s4 = m4 - 4.0 * m1 * m3 + 6.0 * m1 * m1 * m2 - 3.0 * m1 ** 4
                skew = s3 / var_ ** 1.5 if var_ > 0 else 0.0
                kurt = s4 / (var_ * var_) if var_ > 0 else 3.0
        else:
            skew, kurt = 0.0, 3.0
        raw_z = _safe_div_z(resid, mu, vwap_sd)
        cf_valid = False
        cf_raw = 0.0
        if skew is not None and kurt is not None:
            z = raw_z
            cf_raw = z + (z * z - 1) * skew / 6.0 + (z ** 3 - 3 * z) * (kurt - 3) / 24.0 - (2 * z ** 3 - 5 * z) * skew * skew / 36.0
            cf_deriv = 1.0 + (2 * z) * skew / 6.0 + (3 * z * z - 3) * (kurt - 3) / 24.0 - (6 * z * z - 5) * skew * skew / 36.0
            cf_valid = cf_deriv > 0 and abs(cf_raw) < 8.0
        vwap_z = _clamp_z(cf_raw if (cfg.use_cf and cf_valid) else raw_z)

        # Lower-TF flow proxy
        flows = list(bar.ltf_flows) if bar.ltf_flows else []
        ltf_valid = len(flows) > 0
        last_vol = sum(flows) if ltf_valid else 0.0
        anchor = bar.htf_new_bucket or bi == 0
        cum_open = 0.0 if anchor else self.cumul[0]
        cumul = (cum_open + last_vol) if cum_open is not None else None
        self.cumul.push(cumul)
        ofp_slope = (cumul - nz(self.cumul[3])) if cumul is not None else None
        ofp_z = _clamp_z(_safe_div_z(ofp_slope, self.ofp_mu.update(ofp_slope), self.ofp_sd.update(ofp_slope)))

        buy = sum(x for x in flows if x > 0)
        sell = -sum(x for x in flows if x < 0)
        rb = self.roll_buy.update(buy)
        rs = self.roll_sell.update(sell)
        gross = (rb + rs) if (rb is not None and rs is not None) else None
        ltf_vol_valid = ltf_valid and (buy + sell) > 0
        vpin = min(abs(rb - rs) / gross, 1.0) if (ltf_vol_valid and gross) else None
        toxic = cfg.use_vpin and ltf_vol_valid and vpin is not None and vpin > cfg.vpin_thresh
        toxic_buy = toxic and rb > rs
        toxic_sell = toxic and rs > rb

        # CVD divergence
        L = cfg.cvd_div_lookback
        cvd_slope = (cumul - nz(self.cumul[L])) if cumul is not None else None
        price_slope = c - nz(self.c[L])
        cvd_sd = self.cvd_sd.update(cvd_slope)
        cvd_z = _clamp_z(cvd_slope / cvd_sd if (cvd_sd and cvd_slope is not None) else 0.0)
        cvd_flat = abs(cvd_z) < 0.5
        cvd_consume_up = price_slope > 0 and (cvd_z < 0 or cvd_flat)
        cvd_consume_dn = price_slope < 0 and (cvd_z > 0 or cvd_flat)
        cvd_defend_up = price_slope < 0 and cvd_z > 0.5
        cvd_defend_dn = price_slope > 0 and cvd_z < -0.5
        cvd_long = (cumul - nz(self.cumul[20])) if cumul is not None else None
        price_slope_long = c - nz(self.c[20])
        cvd_long_sd = self.cvd_long_sd.update(cvd_long)
        cvd_long_z = _clamp_z(cvd_long / cvd_long_sd if (cvd_long_sd and cvd_long is not None) else 0.0)
        cvd_long_fade_up = price_slope_long > 0 and cvd_long_z < -0.3
        cvd_long_fade_dn = price_slope_long < 0 and cvd_long_z > 0.3

        # DXY / VIX
        dxy_close = bar.dxy if cfg.use_dxy else None
        dxy_corr_raw = self.dxy_corr.update(c, dxy_close)
        dxy_corr = dxy_corr_raw if (cfg.use_dxy and dxy_close is not None) else None
        dxy_decoupled = cfg.use_dxy and dxy_corr is not None and dxy_corr > cfg.dxy_decouple
        vix_close = bar.vix if cfg.use_risk_proxy else None
        risk_off = cfg.use_risk_proxy and vix_close is not None and vix_close > 25.0
        risk_on = cfg.use_risk_proxy and vix_close is not None and vix_close < 18.0

        # Absorption & volatility
        candle_rng = h - l
        vol_z = _clamp_z(_safe_div_z(vol_ref, self.vol_mu.update(vol_ref), self.vol_sd.update(vol_ref)))
        rng_z = _clamp_z(_safe_div_z(candle_rng, self.rng_mu.update(candle_rng), self.rng_sd.update(candle_rng)))
        abs_score = vol_z - rng_z
        is_absorption = abs_score > 1.5 and vol_z > 1.0
        compression_defend = vol_z > 1.5 and rng_z < 0.0
        iceberg = (vol_z > 1.2 and rng_z < 0.2) or compression_defend
        accum = self.accum.update(1.0 if iceberg else 0.0)
        iceberg_accum = accum is not None and accum >= 2
        accum_persistent = accum is not None and accum >= 3

        # Kaufman ER
        c_er = self.c[cfg.er_len]
        net_move = abs(c - (c_er if c_er is not None else c))
        path = self.er_path.update(abs(c - nz(close1)))
        er = net_move / path if (path is not None and path > 0) else 0.0
        trending = er > cfg.er_trend
        ranging = er < cfg.er_range
        regime = "TRENDING" if trending else "RANGING" if ranging else "NEUTRAL"

        # SMPI & SNR
        smpi_raw = 0.40 * ofp_z + 0.30 * ((1.5 if ofp_z > 0 else -1.5) if is_absorption else 0.0) + 0.30 * (1.0 if c > o else -1.0)
        e = self.smpi_ema.update(smpi_raw)
        smpi = max(min(e, 3.0), -3.0) if e is not None else None
        smpi_prev = self.smpi[0]
        self.smpi.push(smpi)
        smpi_slope = (smpi - nz(smpi_prev)) if smpi is not None else None
        smpi_sd = self.smpi_sd.update(smpi)
        snr = abs(smpi) / max(smpi_sd, 0.1) if (smpi is not None and smpi_sd is not None) else None

        # Killzones
        sf = session_flags(bar.t, cfg.killzones)
        in_london, in_ny, in_asia, in_fix = sf.london, sf.ny_am, sf.asia, sf.london_fix
        active_kz = (not cfg.killzones.use_filter) or sf.any
        kz_confirmed = active_kz and vol_z > 0.0
        dealer_hedging = dxy_decoupled and active_kz

        # Asian range → London breakout
        if in_asia:
            self.asian_high = max(h, nz(self.asian_high, h))
            self.asian_low = min(l, nz(self.asian_low, l))
        elif in_london and not self.in_london_prev:
            self.asian_range = nz(self.asian_high, c) - nz(self.asian_low, c)
            self.asian_mid = (nz(self.asian_high, c) + nz(self.asian_low, c)) / 2.0
            self.asian_high = None
            self.asian_low = None
        self.in_london_prev = in_london
        london_move = abs(c - self.asian_mid) if (in_london and self.asian_mid is not None) else 0.0
        bq = london_move / self.asian_range if (_gt(self.asian_range, 0.0) and in_london) else 0.0
        hq_breakout = cfg.use_asian_breakout and bq > 0.5 and vol_z > 1.0

        # Session-empirical volatility
        bar_ret = (c - close1) if close1 is not None else None
        roll_ret_vol = self.ret_sd.update(bar_ret)
        if in_london:
            self.london_vol = roll_ret_vol
        if in_ny:
            self.ny_vol = roll_ret_vol
        if in_asia:
            self.asia_vol = roll_ret_vol
        session_vol = self.london_vol if in_london else self.ny_vol if in_ny else self.asia_vol if in_asia else None
        if session_vol is None:
            for alt in (self.london_vol, self.ny_vol, self.asia_vol, atr14):
                if alt is not None:
                    session_vol = alt
                    break

        # ═══ §4 structure ═══
        ph = self.ph.update(h)
        pl = self.pl.update(l)
        if ph is not None:
            self.last_high = ph
        if pl is not None:
            self.last_low = pl
        x_high = nz(self.last_high, 1e10)
        x_low = nz(self.last_low, -1e10)
        cross_high = close1 is not None and self.x_high_prev is not None and c > x_high and close1 <= self.x_high_prev
        cross_low = close1 is not None and self.x_low_prev is not None and c < x_low and close1 >= self.x_low_prev
        self.x_high_prev, self.x_low_prev = x_high, x_low
        choch_bull = cfg.enable_smc and self.last_high is not None and cross_high
        choch_bear = cfg.enable_smc and self.last_low is not None and cross_low
        if choch_bull:
            self.trend_dir = 1
        if choch_bear:
            self.trend_dir = -1

        h1, h2, l1, l2 = self.h[1], self.h[2], self.l[1], self.l[2]
        o1, c1 = self.o[1], self.c[1]
        fvg_bull = cfg.enable_fvg and _gt(l, h2) and _gt(c1, h2)
        fvg_bear = cfg.enable_fvg and _lt(h, l2) and _lt(c1, l2)
        disp_ok = atr14 is not None and candle_rng >= 0.7 * atr14 and vol_z >= 0.3
        fvg_disp_bull = fvg_bull and disp_ok and ofp_z >= 0
        fvg_disp_bear = fvg_bear and disp_ok and ofp_z <= 0
        fvg_top_bull = l if fvg_bull else None
        fvg_bot_bull = h2 if fvg_bull else None
        fvg_top_bear = l2 if fvg_bear else None
        fvg_bot_bear = h if fvg_bear else None

        ob_bull_raw = cfg.enable_smc and _gt(c, h1) and _lt(c1, o1)
        ob_bear_raw = cfg.enable_smc and _lt(c, l1) and _gt(c1, o1)
        ob_bull = ob_bull_raw and (bi - self.last_ob_bull_bar) >= 8
        ob_bear = ob_bear_raw and (bi - self.last_ob_bear_bar) >= 8
        if ob_bull:
            self.last_ob_bull_bar = bi
        if ob_bear:
            self.last_ob_bear_bar = bi

        low20 = self.low20_prev
        high20 = self.high20_prev
        self.low20_prev = self.low20.update(l)
        self.high20_prev = self.high20.update(h)
        body = abs(c - o)
        lower_wick = min(o, c) - l
        upper_wick = h - max(o, c)
        liq_rng = max(h - l, atr14 * 0.1) if atr14 is not None else None
        liq_sweep_bull = cfg.enable_liquidity and _lt(l, low20) and c > o and _lt(body, liq_rng * 0.5 if liq_rng else None) and lower_wick > body * 0.8
        liq_sweep_bear = cfg.enable_liquidity and _gt(h, high20) and c < o and _lt(body, liq_rng * 0.5 if liq_rng else None) and upper_wick > body * 0.8

        # Retest tracking
        rt = self.rt
        if ob_bull:
            rt["bull_ob_top"], rt["bull_ob_bot"], rt["bull_ob_created"] = h1, l1, bi
        if ob_bear:
            rt["bear_ob_top"], rt["bear_ob_bot"], rt["bear_ob_created"] = h1, l1, bi
        if fvg_bull:
            rt["bull_fvg_top"], rt["bull_fvg_bot"], rt["bull_fvg_created"] = fvg_top_bull, fvg_bot_bull, bi
        if fvg_bear:
            rt["bear_fvg_top"], rt["bear_fvg_bot"], rt["bear_fvg_created"] = fvg_top_bear, fvg_bot_bear, bi
        age = cfg.retest_max_age
        if rt["bull_ob_bot"] is not None and (c < rt["bull_ob_bot"] or bi - rt["bull_ob_created"] > age):
            rt["bull_ob_top"] = rt["bull_ob_bot"] = rt["bull_ob_created"] = None
        if rt["bear_ob_top"] is not None and (c > rt["bear_ob_top"] or bi - rt["bear_ob_created"] > age):
            rt["bear_ob_top"] = rt["bear_ob_bot"] = rt["bear_ob_created"] = None
        if rt["bull_fvg_bot"] is not None and (c < rt["bull_fvg_bot"] or bi - rt["bull_fvg_created"] > age):
            rt["bull_fvg_top"] = rt["bull_fvg_bot"] = rt["bull_fvg_created"] = None
        if rt["bear_fvg_top"] is not None and (c > rt["bear_fvg_top"] or bi - rt["bear_fvg_created"] > age):
            rt["bear_fvg_top"] = rt["bear_fvg_bot"] = rt["bear_fvg_created"] = None

        def fresh(key: str) -> bool:
            cr = rt[key]
            return cr is not None and bi > cr and bi - cr <= age

        um = cfg.use_retest_mode
        in_bull_ob = um and fresh("bull_ob_created") and l <= rt["bull_ob_top"] and h >= rt["bull_ob_bot"]
        in_bear_ob = um and fresh("bear_ob_created") and h >= rt["bear_ob_bot"] and l <= rt["bear_ob_top"]
        in_bull_fvg = um and fresh("bull_fvg_created") and l <= rt["bull_fvg_top"] and h >= rt["bull_fvg_bot"]
        in_bear_fvg = um and fresh("bear_fvg_created") and h >= rt["bear_fvg_bot"] and l <= rt["bear_fvg_top"]
        bull_retest = um and (in_bull_ob or in_bull_fvg) and _gt(smpi_slope, 0.0) and cvd_z > 0
        bear_retest = um and (in_bear_ob or in_bear_fvg) and _lt(smpi_slope, 0.0) and cvd_z < 0

        mid_bar = (h + l) / 2
        liq_trap_bull = cfg.use_liq_trap and cfg.enable_liquidity and self.liq_sweep_bear_prev and c > o and c > mid_bar and ofp_z > 0.5 and _gt(smpi, 0.0)
        liq_trap_bear = cfg.use_liq_trap and cfg.enable_liquidity and self.liq_sweep_bull_prev and c < o and c < mid_bar and ofp_z < -0.5 and _lt(smpi, 0.0)
        self.liq_sweep_bull_prev, self.liq_sweep_bear_prev = liq_sweep_bull, liq_sweep_bear

        # ═══ §4b liquidity vacuum ═══
        phv = self.vac_ph.update(h)
        plv = self.vac_pl.update(l)
        # displacement span = highest(high[dispLen], dispLen): bars dispLen .. 2*dispLen-1 ago
        if cfg.vac_enable and atr14 is not None:
            self._vac_clean_swings(self.vac_sw_hi, True, c)
            self._vac_clean_swings(self.vac_sw_lo, False, c)
            tol = atr14 * cfg.vac_clust_tol_atr
            if phv is not None:
                self.vac_sw_hi.append((phv, bi))
                if len(self.vac_sw_hi) > 40:
                    self.vac_sw_hi.pop(0)
                if sum(1 for p, _ in self.vac_sw_hi if abs(p - phv) <= tol) >= 2:
                    self._vac_add(True, phv, phv + atr14 * 0.15, phv - atr14 * 0.15, 3, atr14)
            if plv is not None:
                self.vac_sw_lo.append((plv, bi))
                if len(self.vac_sw_lo) > 40:
                    self.vac_sw_lo.pop(0)
                if sum(1 for p, _ in self.vac_sw_lo if abs(p - plv) <= tol) >= 2:
                    self._vac_add(False, plv, plv + atr14 * 0.15, plv - atr14 * 0.15, 3, atr14)
            fvg_min = atr14 * cfg.vac_fvg_min_atr
            if h2 is not None and (l - h2) > fvg_min:
                self._vac_add(False, (l + h2) / 2, l, h2, 2, atr14)
            if l2 is not None and (l2 - h) > fvg_min:
                self._vac_add(True, (l2 + h) / 2, l2, h, 2, atr14)
            dl = cfg.vac_disp_len
            if dl >= 2:
                hs = [self.h[k] for k in range(dl, 2 * dl)]
                ls = [self.l[k] for k in range(dl, 2 * dl)]
                if None not in hs:
                    span_h1 = max(hs)
                    if (l - span_h1) > atr14 * 0.3:
                        self._vac_add(False, (l + span_h1) / 2, l, span_h1, 1, atr14)
                if None not in ls:
                    span_l1 = min(ls)
                    if (span_l1 - h) > atr14 * 0.3:
                        self._vac_add(True, (span_l1 + h) / 2, span_l1, h, 1, atr14)
        self._vac_prune(True, c)
        self._vac_prune(False, c)

        vac_above = vac_below = None
        vac_above_d = vac_below_d = None
        for p in self.vac_hi:
            if p.price > c and (vac_above_d is None or p.price - c < vac_above_d):
                vac_above_d = p.price - c
                vac_above = p.price
        for p in self.vac_lo:
            if p.price < c and (vac_below_d is None or c - p.price < vac_below_d):
                vac_below_d = c - p.price
                vac_below = p.price
        vac_above_str = 3.0 * math.exp(-vac_above_d / (atr14 * cfg.vac_prox_atr)) if (vac_above_d is not None and atr14) else 0.0
        vac_below_str = 3.0 * math.exp(-vac_below_d / (atr14 * cfg.vac_prox_atr)) if (vac_below_d is not None and atr14) else 0.0
        magnet_up = vac_above is not None and (vac_below is None or vac_above_d <= vac_below_d)
        magnet_dn = vac_below is not None and (vac_above is None or vac_below_d < vac_above_d)
        bear_struct = fvg_bear or ob_bear or liq_sweep_bear or choch_bear
        bull_struct = fvg_bull or ob_bull or liq_sweep_bull or choch_bull
        vac_align_bear = magnet_up and bear_struct
        vac_align_bull = magnet_dn and bull_struct
        vac_anti_bear = magnet_dn and bear_struct
        vac_anti_bull = magnet_up and bull_struct
        vac_band = min(vac_above_str, 3.0) if magnet_up else -min(vac_below_str, 3.0) if magnet_dn else 0.0

        # Hopla 3-97
        hsize = float(cfg.hopla_range * cfg.hopla_multiplier)
        r_low = math.floor(c / hsize) * hsize if hsize > 0 else c
        hopla = {
            "range": hsize, "box_low": r_low, "box_high": r_low + hsize,
            "line_3": r_low + 0.03 * hsize, "line_50": r_low + 0.5 * hsize, "line_97": r_low + 0.97 * hsize,
            "line_97_above": r_low + 0.97 * hsize + hsize, "line_3_below": r_low + 0.03 * hsize - hsize,
        }
        near3 = atr14 is not None and abs(c - hopla["line_3"]) <= atr14 * 0.5
        near97 = atr14 is not None and abs(c - hopla["line_97"]) <= atr14 * 0.5
        hopla["in_discount"] = c <= hopla["line_3"]
        hopla["in_premium"] = c >= hopla["line_97"]
        hopla["near_3"] = near3
        hopla["near_97"] = near97

        # ═══ §5 scoring ═══
        min_hist_ok = bi >= max(cfg.z_window, cfg.er_len, cfg.corr_window)
        smpi_pos = _gt(smpi, 0.0)
        smpi_neg = _lt(smpi, 0.0)
        k_bull = int(fvg_bull) + int(ob_bull) + int(liq_sweep_bull) + int(choch_bull) + int(smpi_pos)
        k_bear = int(fvg_bear) + int(ob_bear) + int(liq_sweep_bear) + int(choch_bear) + int(smpi_neg)
        k_active = max(k_bull, k_bear)
        if _gt(atr14, 0.0):
            d_htf = (c - htf.ema200) / atr14 if htf.ema200 is not None else None
        else:
            d_htf = 0.0
        d_struct = float((int(fvg_bull) + int(ob_bull) + int(liq_sweep_bull) + int(choch_bull))
                         - (int(fvg_bear) + int(ob_bear) + int(liq_sweep_bear) + int(choch_bear)))
        series = (ofp_z, vwap_z, smpi, d_htf, er, d_struct)
        pairs = [(i, j) for i in range(6) for j in range(i + 1, 6)]
        r_sum = 0.0
        for k, (i, j) in enumerate(pairs):
            r = self.corrs[k].update(series[i], series[j])
            r_sum += max(min(nz(r), 0.95), -0.95)
        self.r_bar = max(min(r_sum / 15.0, 0.95), 0.0)
        r_bar = self.r_bar
        n_eff = k_active / (1.0 + (k_active - 1) * r_bar) if k_active > 0 else 0.0

        prior = min(cfg.base_prior + 0.05, 0.65) if trending else max(cfg.base_prior - 0.03, 0.40) if ranging else cfg.base_prior
        prior_lo = math.log(prior / (1.0 - prior))

        # Ledger bridge (records closed bar outcomes before scoring, as in Pine)
        self._ledger_update(h, l, c)
        while len(self.ledger) > 250:
            self.ledger.pop(0)
        if fvg_bull:
            self._ledger_record("FVG_Bull", c, 1, fvg_bot_bull if fvg_bot_bull is not None else (l - atr14 if atr14 is not None else None), atr14)
        if fvg_bear:
            self._ledger_record("FVG_Bear", c, -1, fvg_top_bear if fvg_top_bear is not None else (h + atr14 if atr14 is not None else None), atr14)
        if ob_bull:
            self._ledger_record("OB_Bull", c, 1, l1, atr14)
        if ob_bear:
            self._ledger_record("OB_Bear", c, -1, h1, atr14)
        if liq_sweep_bull:
            self._ledger_record("LIQ_Bull", c, 1, l, atr14)
        if liq_sweep_bear:
            self._ledger_record("LIQ_Bear", c, -1, h, atr14)
        if choch_bull:
            self._ledger_record("CH_Bull", c, 1, l - atr14 if atr14 is not None else None, atr14)
        if choch_bear:
            self._ledger_record("CH_Bear", c, -1, h + atr14 if atr14 is not None else None, atr14)

        has_bull = fvg_bull or ob_bull or liq_sweep_bull or choch_bull or liq_trap_bull
        has_bear = fvg_bear or ob_bear or liq_sweep_bear or choch_bear or liq_trap_bear
        if has_bull:
            self.last_bull_setup_bar = bi
        if has_bear:
            self.last_bear_setup_bar = bi
        bull_fresh = max(0.0, 1.0 - (bi - self.last_bull_setup_bar) / 8.0) if cfg.use_temporal_decay else 1.0
        bear_fresh = max(0.0, 1.0 - (bi - self.last_bear_setup_bar) / 8.0) if cfg.use_temporal_decay else 1.0

        long_primary = "FVG_Bull" if fvg_bull else "OB_Bull" if ob_bull else "LIQ_Bull" if liq_sweep_bull else "CH_Bull" if choch_bull else ("TRAP_Bull" if liq_trap_bull else "")
        short_primary = "FVG_Bear" if fvg_bear else "OB_Bear" if ob_bear else "LIQ_Bear" if liq_sweep_bear else "CH_Bear" if choch_bear else ("TRAP_Bear" if liq_trap_bear else "")

        def score(is_long: bool) -> Tuple[Num, Dict[str, float]]:
            if not cfg.enable_bayes:
                hs = has_bull if is_long else has_bear
                return (68.0 if hs else 40.0), {}
            indep = (n_eff / float(k_active)) if k_active > 1 else 1.0
            w: Dict[str, Num] = {}
            if is_long:
                base_loc = 0.85 if (fvg_disp_bull or ob_bull or liq_sweep_bull) else 0.65 if fvg_bull else 0.50 if choch_bull else -0.30
                ptype = "FVG_Bull" if fvg_bull else "OB_Bull" if ob_bull else "LIQ_Bull" if liq_sweep_bull else "CH_Bull" if choch_bull else ""
            else:
                base_loc = 0.85 if (fvg_disp_bear or ob_bear or liq_sweep_bear) else 0.65 if fvg_bear else 0.50 if choch_bear else -0.30
                ptype = "FVG_Bear" if fvg_bear else "OB_Bear" if ob_bear else "LIQ_Bear" if liq_sweep_bear else "CH_Bear" if choch_bear else ""
            bridge = 1.0
            if cfg.use_ledger_bridge and ptype:
                rate, n = self.cal_stats(ptype)
                if n >= 15:
                    bridge = max(0.5, min(1.5, 0.5 + rate / 100.0))
            w["loc"] = base_loc * bridge
            if is_long:
                w["vwap"] = 0.80 if (-3.2 <= vwap_z <= -1.7) else -1.40 if vwap_z >= 2.0 else 0.20
                if _gt(smpi_slope, 0.0) and _gt(smpi, -0.5):
                    w["press"] = 0.65 + 0.15 * min(snr, 2.0) if snr is not None else None
                else:
                    w["press"] = -0.70 if _lt(smpi_slope, 0.0) else 0.0
                w["reg"] = 0.55 if (trending and self.trend_dir == 1) else 0.45 if (ranging and vwap_z <= -1.5) else -0.20
                htf_base = 0.40 if htf_bull else -0.50
                w["iceberg"] = 0.40 if (accum_persistent and ofp_z >= 0) else 0.30 if (iceberg_accum and ofp_z >= 0) else 0.0
                w["vpin"] = -0.90 if toxic_sell else 0.0
                w["queue"] = 0.45 if cvd_defend_up else -0.55 if cvd_consume_up else 0.0
                w["vwapDiv"] = -0.25 if cvd_long_fade_up else 0.0
                w["vix"] = 0.50 if risk_off else -0.20 if risk_on else 0.0
                w["asian"] = 0.35 if (hq_breakout and c > nz(self.asian_mid, c)) else 0.0
                w["decay"] = (bull_fresh - 1.0) * 0.15 if cfg.use_temporal_decay else 0.0
                w["retest"] = 0.30 if (um and bull_retest) else -0.20 if (um and (in_bull_ob or in_bull_fvg)) else 0.0
                w["trap"] = 0.90 if (cfg.use_liq_trap and liq_trap_bull) else 0.0
                w["vac"] = (0.55 if vac_align_bull else -0.45 if vac_anti_bull else 0.0) if cfg.vac_enable else 0.0
            else:
                w["vwap"] = 0.80 if (1.7 <= vwap_z <= 3.2) else -1.40 if vwap_z <= -2.0 else 0.20
                if _lt(smpi_slope, 0.0) and _lt(smpi, 0.5):
                    w["press"] = 0.65 + 0.15 * min(snr, 2.0) if snr is not None else None
                else:
                    w["press"] = -0.70 if _gt(smpi_slope, 0.0) else 0.0
                w["reg"] = 0.55 if (trending and self.trend_dir == -1) else 0.45 if (ranging and vwap_z >= 1.5) else -0.20
                htf_base = 0.40 if htf_bear else -0.50
                w["iceberg"] = 0.40 if (accum_persistent and ofp_z <= 0) else 0.30 if (iceberg_accum and ofp_z <= 0) else 0.0
                w["vpin"] = -0.90 if toxic_buy else 0.0
                w["queue"] = 0.45 if cvd_defend_dn else -0.55 if cvd_consume_dn else 0.0
                w["vwapDiv"] = -0.25 if cvd_long_fade_dn else 0.0
                w["vix"] = -0.50 if risk_off else 0.20 if risk_on else 0.0
                w["asian"] = 0.35 if (hq_breakout and c < nz(self.asian_mid, c)) else 0.0
                w["decay"] = (bear_fresh - 1.0) * 0.15 if cfg.use_temporal_decay else 0.0
                w["retest"] = 0.30 if (um and bear_retest) else -0.20 if (um and (in_bear_ob or in_bear_fvg)) else 0.0
                w["trap"] = 0.90 if (cfg.use_liq_trap and liq_trap_bear) else 0.0
                w["vac"] = (0.55 if vac_align_bear else -0.45 if vac_anti_bear else 0.0) if cfg.vac_enable else 0.0
            w["htf"] = htf_base * (0.5 if abs(htf_ext) > 2.0 else 1.0) if cfg.use_htf_trend_filter else 0.0
            w["sess"] = 0.50 if kz_confirmed else 0.15 if active_kz else -0.50
            w["dxy"] = 0.35 if dealer_hedging else 0.0
            w["shock"] = -0.35 if shock_soft else 0.0
            if any(x is None for x in w.values()):
                return None, {k: nz(x) for k, x in w.items()}
            raw = prior_lo + sum(w.values())
            post = prior_lo + (raw - prior_lo) * indep
            # contribution actually applied (after independence scaling), for explainability
            scaled = {k: x * indep for k, x in w.items()}
            return 100.0 / (1.0 + math.exp(-post)), scaled

        if min_hist_ok:
            lp, lw = score(True)
            sp, sw = score(False)
        else:
            lp, lw, sp, sw = 50.0, {}, 50.0, {}

        cooldown_bull = (bi - self.last_aplus_bull_bar) >= cfg.signal_cooldown
        cooldown_bear = (bi - self.last_aplus_bear_bar) >= cfg.signal_cooldown

        eqs = 1.0
        if cfg.use_eqs:
            eqs *= 1.0 if active_kz else 0.88
            eqs *= 0.65 if shock_hard else 0.88 if shock_soft else 1.0
            eqs *= 0.75 if toxic else 1.0
            eqs *= 1.0 if ltf_vol_valid else 0.92
            eqs *= 1.12 if iceberg_accum else 1.0
        adj_long = (min(lp * eqs, 99.0) if cfg.use_eqs else lp) if lp is not None else None
        adj_short = (min(sp * eqs, 99.0) if cfg.use_eqs else sp) if sp is not None else None

        sd20 = self.sd20.update(c)
        sd20_mean = self.sd20_sma.update(sd20)
        vol_regime = (sd20 / max(sd20_mean, 0.0001)) if (sd20 is not None and sd20_mean is not None) else None
        dyn = cfg.min_aplus
        if cfg.use_dynamic_threshold:
            dyn = cfg.min_aplus + (-3.0 if in_fix else 0.0) + (-4.0 if _gt(vol_regime, 1.3) else 3.0 if _lt(vol_regime, 0.7) else 0.0) + (-2.0 if risk_off else 0.0)
        dyn = max(min(dyn, 80.0), 50.0)

        vol_gate = vol_z > 0.0
        long_no_conflict = _lt(adj_short, 55.0)
        short_no_conflict = _lt(adj_long, 55.0)
        aplus_bull_raw = min_hist_ok and has_bull and _ge(adj_long, dyn) and active_kz and not shock_hard and vol_gate and long_no_conflict
        aplus_bear_raw = min_hist_ok and has_bear and _ge(adj_short, dyn) and active_kz and not shock_hard and vol_gate and short_no_conflict
        aplus_bull = aplus_bull_raw and cooldown_bull and (not um or bull_retest or liq_trap_bull or choch_bull)
        aplus_bear = aplus_bear_raw and cooldown_bear and (not um or bear_retest or liq_trap_bear or choch_bear)
        if aplus_bull:
            self.last_aplus_bull_bar = bi
        if aplus_bear:
            self.last_aplus_bear_bar = bi
        struct_bull = min_hist_ok and has_bull and _ge(adj_long, 50.0) and _lt(adj_long, dyn) and not shock_hard
        struct_bear = min_hist_ok and has_bear and _ge(adj_short, 50.0) and _lt(adj_short, dyn) and not shock_hard
        trap_bull = min_hist_ok and has_bull and _lt(adj_long, 50.0)
        trap_bear = min_hist_ok and has_bear and _lt(adj_short, 50.0)

        # ═══ §6 Pine A+ performance tracker (session-σ stops, Wilson CI) ═══
        if aplus_bull or aplus_bear:
            self.total_aplus += 1
            unit = session_vol if cfg.use_session_stops else atr14
            if unit is not None:
                risk = (cfg.session_sl_mult if cfg.use_session_stops else 1.5) * unit
                tpd = (cfg.session_tp1_mult if cfg.use_session_stops else 2.0) * unit
                self.aplus_open.append(_AplusTrade(c, c + tpd if aplus_bull else c - tpd, c - risk if aplus_bull else c + risk, risk, bi, aplus_bull))
        for i in range(len(self.aplus_open) - 1, -1, -1):
            tdx = self.aplus_open[i]
            if bi <= tdx.opened_bar:
                continue
            sl_hit = l <= tdx.sl if tdx.is_bull else h >= tdx.sl
            tp_hit = h >= tdx.tp if tdx.is_bull else l <= tdx.tp
            if sl_hit:
                self.resolved_aplus += 1
                self.aplus_sum_r -= 1.0
                del self.aplus_open[i]
            elif tp_hit:
                self.resolved_aplus += 1
                self.win_aplus += 1
                self.aplus_sum_r += (tdx.tp - tdx.entry if tdx.is_bull else tdx.entry - tdx.tp) / tdx.risk
                del self.aplus_open[i]
            elif bi >= tdx.opened_bar + cfg.aplus_horizon:
                pnl = c - tdx.entry if tdx.is_bull else tdx.entry - c
                tr_ = pnl / tdx.risk
                self.timeout_aplus += 1
                self.resolved_aplus += 1
                if tr_ > 0:
                    self.win_aplus += 1
                self.aplus_sum_r += tr_
                del self.aplus_open[i]
        wlo, whi = wilson_interval(self.win_aplus, self.resolved_aplus)

        return OscBar(
            bar_index=bi, t=bar.t, close=c, ready=min_hist_ok,
            atr14=atr14, atr100=atr100, shock_hard=shock_hard, shock_soft=shock_soft, shock_start=shock_start,
            er=er, regime=regime, htf_bull=htf_bull, htf_bear=htf_bear, htf_extension=htf_ext,
            vwap=vwap, vwap_z=vwap_z, ofp_slope_z=ofp_z, smpi=smpi, smpi_slope=smpi_slope, snr=snr,
            vol_z=vol_z, rng_z=rng_z, is_absorption=is_absorption, is_accumulating=iceberg_accum,
            toxic_flow=toxic, vpin=vpin, cvd_slope_z=cvd_z, ltf_ok=ltf_vol_valid, dxy_corr=dxy_corr,
            risk_off=risk_off, risk_on=risk_on, session_vol=session_vol,
            killzone=sf.name, active_killzone=active_kz, kz_confirmed=kz_confirmed,
            asian_mid=self.asian_mid, breakout_quality=bq,
            choch_bull=choch_bull, choch_bear=choch_bear, trend_dir=self.trend_dir,
            fvg_bull=fvg_bull, fvg_bear=fvg_bear, fvg_displaced_bull=fvg_disp_bull, fvg_displaced_bear=fvg_disp_bear,
            fvg_top_bull=fvg_top_bull, fvg_bot_bull=fvg_bot_bull, fvg_top_bear=fvg_top_bear, fvg_bot_bear=fvg_bot_bear,
            ob_bull=ob_bull, ob_bear=ob_bear,
            ob_bull_zone=(h1, l1) if ob_bull else None, ob_bear_zone=(h1, l1) if ob_bear else None,
            liq_sweep_bull=liq_sweep_bull, liq_sweep_bear=liq_sweep_bear,
            liq_trap_bull=liq_trap_bull, liq_trap_bear=liq_trap_bear,
            vac_above=vac_above, vac_below=vac_below, vac_band=vac_band,
            vac_align_bull=vac_align_bull, vac_align_bear=vac_align_bear,
            vacuum_pockets=[VacuumPocket(**asdict(p)) for p in (self.vac_hi + self.vac_lo)],
            hopla=hopla,
            k_active=k_active, n_eff=n_eff, r_bar=r_bar, prior=prior,
            long_prob=nz(lp, 50.0), short_prob=nz(sp, 50.0), long_weights=lw, short_weights=sw,
            eqs=eqs, adj_long=nz(adj_long, 50.0), adj_short=nz(adj_short, 50.0), dynamic_min=dyn,
            has_bull_setup=has_bull, has_bear_setup=has_bear,
            long_primary=long_primary, short_primary=short_primary,
            aplus_bull=aplus_bull, aplus_bear=aplus_bear, struct_bull=struct_bull, struct_bear=struct_bear,
            trap_bull=trap_bull, trap_bear=trap_bear,
            gates={
                "min_history": min_hist_ok, "killzone": active_kz, "no_shock": not shock_hard,
                "volume": vol_gate, "long_no_conflict": long_no_conflict, "short_no_conflict": short_no_conflict,
                "cooldown_long": cooldown_bull, "cooldown_short": cooldown_bear,
            },
            aplus_stats={
                "total": self.total_aplus, "resolved": self.resolved_aplus, "wins": self.win_aplus,
                "timeouts": self.timeout_aplus,
                "expectancy_r": (self.aplus_sum_r / self.resolved_aplus) if self.resolved_aplus else 0.0,
                "wilson_lo": wlo, "wilson_hi": whi,
            },
        )
