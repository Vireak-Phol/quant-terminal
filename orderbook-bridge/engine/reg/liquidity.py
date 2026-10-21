"""REG v7.4 — Liquidity Zones, Liquidity Sweeps, and HTF Key Levels, ported bar-for-bar.

Pine source: ``pine-strategy/7.4/REG-v7-4-light.pine``.
Sections ported:
  * LIQUIDITY ZONE TYPES        (type LiquidityLevel, ~line 198)
  * LIQUIDITY ZONES INPUTS      (~line 411)
  * HTF KEY LEVELS INPUTS       (~line 441)
  * LIQUIDITY ZONE VARIABLES    (levelsH / levelsL, ~line 772)
  * LIQUIDITY ZONE METHODS      (f_cleanupLiq / f_createLiqZone / isVisible, ~line 1091)
  * DAILY / WEEKLY LEVELS       (pdh/pdl/pwh/pwl via request.security, ~line 2108)
  * newLiqSweep                 (~line 2303)
  * LIQUIDITY ZONE DETECTION    (~line 2878-3045)
  * plot "Active Liquidity Zones" (~line 3019)

Design
------
This engine is called once per *confirmed* chart bar (Pine ``confirmedOnly = true``), in
bar order.  Every drawing-only branch in the Pine (``box.*``, ``line.*``, ``label.*``,
and the ``barstate.islast`` cosmetics) is a no-op for state, so only the *logical* state
is reproduced: the two level arrays, their ``active`` / ``lastSweepBar`` fields, the
daily/weekly key levels, and the per-bar flags.

Pine statement ordering matters and is preserved exactly:
  1. ``atr = ta.atr(14)``                      (global ATR)
  2. daily/weekly PDH/PDL/PWH/PWL update       (line 2108)
  3. ``newLiqSweep`` computed                  (line 2303) — reads array state produced
     by *previous* bars; this bar's new pivots and sweep-bookkeeping happen later.
  4. LIQUIDITY ZONE DETECTION & PROCESSING     (line 2878) — cleanup, add pivots,
     mitigate, and record sweeps (mutates ``active`` / ``lastSweepBar``).
  5. ``activeLiqZones`` counted                (line 3019) — AFTER processing.
  6. final cleanup on ``barstate.isconfirmed`` (line 3040).

Defaults match the Pine input defaults under the ``Minimalist (Clean)`` preset with
``optimizeForScalping = true``, ``cullFarZones = true`` and ``maxZoneDistAtr = 20``.
Those options only touch cosmetics or the (logic-equivalent) cull/mitigation paths.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from zoneinfo import ZoneInfo

from engine.pine import ATR, Pivot, is_na

NY = ZoneInfo("America/New_York")


# ─────────────────────────────────────────────────────────────────────────────
# Config — Pine input defaults
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class LiquidityConfig:
    enable_liquidity: bool = True          # enableLiquidity
    pivot_len_liq: int = 5                 # pivotLenLiq
    atr_length: int = 14                   # globalAtrLength
    sweep_cooldown_bars: int = 5           # sweepCooldownBars
    use_lookback_liq: bool = True          # useLookbackLiq
    lookback_len_liq: int = 500            # lookbackLenLiq
    optimize_for_scalping: bool = True     # optimizeForScalping
    cull_far_zones: bool = True            # cullFarZones
    max_zone_dist_atr: float = 20.0        # maxZoneDistAtr
    show_bear_sweep: bool = True           # showBearSweep
    show_bull_sweep: bool = True           # showBullSweep
    # HTF key levels
    show_pdh: bool = True                  # showPDH (prev day high/low)
    show_pwh: bool = True                  # showPWH (prev week high/low)


# ─────────────────────────────────────────────────────────────────────────────
# State type — mirrors Pine ``type LiquidityLevel`` (logical fields only)
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class LiquidityLevel:
    price: float
    created_bar: int
    side: str                       # "high" (bear/resistance) or "low" (bull/support)
    active: bool = True
    last_sweep_bar: int = -999


@dataclass
class LiquidityBar:
    """Per-bar output of :class:`LiquidityEngine`."""

    t: int
    bar_index: int
    atr: Optional[float]

    # Liquidity sweep (Pine ``newLiqSweep`` — computed pre-detection on prior state)
    new_liq_sweep: bool = False
    new_liq_sweep_dir: int = 0      # swept high => -1 (bearish), swept low => +1 (bullish)

    # Active-zone count (Pine plot "Active Liquidity Zones", post-detection)
    active_liq_zones: int = 0

    # HTF key levels (prior completed day / week)
    pdh: Optional[float] = None
    pdl: Optional[float] = None
    pwh: Optional[float] = None
    pwl: Optional[float] = None

    # Derived HTF sweeps (not a direct Pine plot column; wick pierces + close rejects)
    sweep_pdh: bool = False
    sweep_pdl: bool = False
    sweep_pwh: bool = False
    sweep_pwl: bool = False

    # Snapshot of active levels this bar: list of dicts (price, side, touches, created)
    levels: List[dict] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Daily / weekly session aggregation (OANDA:XAUUSD rolls at 17:00 America/New_York)
# ─────────────────────────────────────────────────────────────────────────────
def _session_day(ts_sec: int) -> int:
    """Ordinal of the TradingView *trading day* containing bar-open ``ts_sec``.

    OANDA metals days start at 17:00 NY; a bar at or after 17:00 NY belongs to the next
    calendar day's session.  Returns a monotonically increasing integer id.
    """
    dt = datetime.fromtimestamp(ts_sec, tz=timezone.utc).astimezone(NY)
    d = dt.date()
    if dt.hour >= 17:
        d = d + timedelta(days=1)
    return d.toordinal()


def _session_week(ts_sec: int) -> int:
    """Week id for the session day.  TradingView forex/metals weeks open Sunday 17:00 NY,
    so the session day that falls on Sunday starts a new week.  We bucket by the Monday
    (ISO) of the session day; Sunday's session (session_day == Monday) already maps forward.
    """
    sd = _session_day(ts_sec)                 # ordinal of the trading day
    day = datetime.fromordinal(sd)            # weekday(): Mon=0 .. Sun=6
    monday = sd - day.weekday()
    return monday


class _PeriodLevels:
    """Reproduces ``request.security(sym, tf, [high[1], low[1]], lookahead=lookahead_on)``.

    With ``lookahead_on`` and the ``[1]`` offset, the value returned for every chart bar
    inside period *k* is the high/low of period *k-1* (the last fully-closed period) and
    is known from the first bar of period *k* — non-repainting, live == backtest.
    """

    def __init__(self, key_fn):
        self._key_fn = key_fn
        self._cur_id: Optional[int] = None
        self._cur_hi: Optional[float] = None
        self._cur_lo: Optional[float] = None
        self._prev_hi: Optional[float] = None   # high of last *closed* period == PDH/PWH
        self._prev_lo: Optional[float] = None

    def update(self, ts_sec: int, h: float, l: float):
        """Fold one chart bar; return (prev_high, prev_low) available on this bar."""
        pid = self._key_fn(ts_sec)
        if self._cur_id is None:
            self._cur_id = pid
            self._cur_hi, self._cur_lo = h, l
        elif pid != self._cur_id:
            # Period rolled over: the period we were accumulating is now closed.
            self._prev_hi, self._prev_lo = self._cur_hi, self._cur_lo
            self._cur_id = pid
            self._cur_hi, self._cur_lo = h, l
        else:
            self._cur_hi = h if self._cur_hi is None else max(self._cur_hi, h)
            self._cur_lo = l if self._cur_lo is None else min(self._cur_lo, l)
        return self._prev_hi, self._prev_lo


# ─────────────────────────────────────────────────────────────────────────────
# Engine
# ─────────────────────────────────────────────────────────────────────────────
class LiquidityEngine:
    """Incremental port of the REG v7.4 liquidity sub-engine.

    Call :meth:`update` once per confirmed bar, in order.
    """

    def __init__(self, cfg: Optional[LiquidityConfig] = None):
        self.cfg = cfg or LiquidityConfig()
        self._atr = ATR(self.cfg.atr_length)
        self._piv_h = Pivot(self.cfg.pivot_len_liq, self.cfg.pivot_len_liq, high=True)
        self._piv_l = Pivot(self.cfg.pivot_len_liq, self.cfg.pivot_len_liq, high=False)

        self.levels_h: List[LiquidityLevel] = []   # bear zones (resistance/supply)
        self.levels_l: List[LiquidityLevel] = []    # bull zones (support/demand)

        self._bar_index = -1
        self._atr_val: Optional[float] = None

        self._daily = _PeriodLevels(_session_day)
        self._weekly = _PeriodLevels(_session_week)
        # Pine holds pdh/pdl/pwh/pwl in `var` and overwrites them every confirmed bar.
        self.pdh: Optional[float] = None
        self.pdl: Optional[float] = None
        self.pwh: Optional[float] = None
        self.pwl: Optional[float] = None

    # ── helpers mirroring Pine functions ──────────────────────────────────
    def _is_visible(self, c: float, level: float, n: float) -> bool:
        """Pine ``isVisible(level, n)``: |close - level| <= atr * n."""
        if self._atr_val is None:
            return True  # atr na early; Pine na*n -> na, |x|<=na -> na(false-ish)
        return abs(c - level) <= self._atr_val * n

    def _cleanup(self, arr: List[LiquidityLevel], c: float) -> None:
        """Pine ``f_cleanupLiq`` — remove inactive / too-far / too-old levels."""
        cfg = self.cfg
        for i in range(len(arr) - 1, -1, -1):
            lvl = arr[i]
            too_far = cfg.cull_far_zones and not self._is_visible(c, lvl.price, cfg.max_zone_dist_atr)
            too_old = cfg.use_lookback_liq and (self._bar_index - lvl.created_bar) > cfg.lookback_len_liq
            if (not lvl.active) or too_far or too_old:
                del arr[i]

    # ── main ──────────────────────────────────────────────────────────────
    def update(self, t: int, o: float, h: float, l: float, c: float, v: float) -> LiquidityBar:
        cfg = self.cfg
        self._bar_index += 1
        bi = self._bar_index

        # (1) global ATR — computed every bar, same series Pine's `atr` uses.
        self._atr_val = self._atr.update(h, l, c)
        atr = self._atr_val

        # Pivots fed every bar; they return a value `pivotLenLiq` bars after formation.
        ph = self._piv_h.update(h)
        pl = self._piv_l.update(l)

        out = LiquidityBar(t=t, bar_index=bi, atr=atr)

        # (2) DAILY / WEEKLY KEY LEVELS (Pine line 2108). Updated on every confirmed bar.
        pdh_raw, pdl_raw = self._daily.update(t, h, l)
        pwh_raw, pwl_raw = self._weekly.update(t, h, l)
        self.pdh, self.pdl = pdh_raw, pdl_raw
        self.pwh, self.pwl = pwh_raw, pwl_raw
        out.pdh, out.pdl, out.pwh, out.pwl = self.pdh, self.pdl, self.pwh, self.pwl

        if not cfg.enable_liquidity:
            # newLiqSweep requires enableLiquidity; nothing else runs.
            out.levels = []
            return out

        # (3) newLiqSweep (Pine line 2303) — evaluated on the array state carried in from
        #     prior bars, BEFORE this bar adds pivots or records sweeps.
        swept_high = False
        swept_low = False
        for lvl in self.levels_h:
            if lvl.active and h > lvl.price and c < lvl.price and (bi - lvl.last_sweep_bar) >= cfg.sweep_cooldown_bars:
                swept_high = True
        for lvl in self.levels_l:
            if lvl.active and l < lvl.price and c > lvl.price and (bi - lvl.last_sweep_bar) >= cfg.sweep_cooldown_bars:
                swept_low = True
        out.new_liq_sweep = swept_high or swept_low
        # Direction: swept high => bearish context (-1), swept low => bullish (+1).
        # If both fire the same bar, prefer the bearish reading (Pine OR, no direction stored).
        out.new_liq_sweep_dir = -1 if swept_high else (1 if swept_low else 0)

        # (4) LIQUIDITY ZONE DETECTION & PROCESSING (Pine line 2878).
        # Cleanup routine every 20 bars.
        if bi % 20 == 0:
            self._cleanup(self.levels_h, c)
            self._cleanup(self.levels_l, c)

        # Create Bear Zone (resistance) from a confirmed pivot high.
        if not is_na(ph):
            already = False
            for ex in self.levels_h:
                if ex.active and abs(ex.price - ph) < ((atr or 0.0) * 0.5):
                    already = True
                    break
            if not already:
                self.levels_h.append(LiquidityLevel(price=ph, created_bar=bi - cfg.pivot_len_liq, side="high"))

        # Create Bull Zone (support) from a confirmed pivot low.
        if not is_na(pl):
            already = False
            for ex in self.levels_l:
                if ex.active and abs(ex.price - pl) < ((atr or 0.0) * 0.5):
                    already = True
                    break
            if not already:
                self.levels_l.append(LiquidityLevel(price=pl, created_bar=bi - cfg.pivot_len_liq, side="low"))

        # Process Bear Sweeps (resistance). Mitigation then sweep recording.
        for lvl in self.levels_h:
            if not lvl.active:
                continue
            if c > lvl.price:
                lvl.active = False
                continue  # mitigated this bar: no sweep recorded (Pine if/else-if)
            bear_hit = h > lvl.price and c < lvl.price and cfg.show_bear_sweep
            cooldown_ok = (bi - lvl.last_sweep_bar) >= cfg.sweep_cooldown_bars
            if bear_hit and cooldown_ok:  # barConfirmed is always true here
                lvl.last_sweep_bar = bi

        # Process Bull Sweeps (support).
        for lvl in self.levels_l:
            if not lvl.active:
                continue
            if c < lvl.price:
                lvl.active = False
                continue
            bull_hit = l < lvl.price and c > lvl.price and cfg.show_bull_sweep
            cooldown_ok = (bi - lvl.last_sweep_bar) >= cfg.sweep_cooldown_bars
            if bull_hit and cooldown_ok:
                lvl.last_sweep_bar = bi

        # (5) activeLiqZones count — AFTER processing (Pine line 3019).
        active = 0
        snap: List[dict] = []
        for lvl in self.levels_h:
            if lvl.active:
                active += 1
                snap.append({
                    "price": lvl.price, "side": "high",
                    "touches": 0 if lvl.last_sweep_bar < 0 else 1,
                    "created_bar": lvl.created_bar, "last_sweep_bar": lvl.last_sweep_bar,
                })
        for lvl in self.levels_l:
            if lvl.active:
                active += 1
                snap.append({
                    "price": lvl.price, "side": "low",
                    "touches": 0 if lvl.last_sweep_bar < 0 else 1,
                    "created_bar": lvl.created_bar, "last_sweep_bar": lvl.last_sweep_bar,
                })
        out.active_liq_zones = active
        out.levels = snap

        # (6) final cleanup on confirmed bar (Pine line 3040). Always confirmed here.
        self._cleanup(self.levels_h, c)
        self._cleanup(self.levels_l, c)

        # Derived HTF key-level sweeps (wick pierces, close rejects back inside).
        if cfg.show_pdh and self.pdh is not None and self.pdl is not None:
            out.sweep_pdh = h > self.pdh and c < self.pdh
            out.sweep_pdl = l < self.pdl and c > self.pdl
        if cfg.show_pwh and self.pwh is not None and self.pwl is not None:
            out.sweep_pwh = h > self.pwh and c < self.pwh
            out.sweep_pwl = l < self.pwl and c > self.pwl

        return out
