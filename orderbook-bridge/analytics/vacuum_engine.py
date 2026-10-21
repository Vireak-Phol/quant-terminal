"""
Liquidity Vacuum Engine — Python port of the OSC-VIP v7.4 Pine vacuum engine.

A "vacuum" is an UNTRADED price pocket in front of resting stops that price
accelerates through (no fills to slow it). Three confirmed-bar sources, each
ranked by strength:

    1. Equal highs / lows      -> clustered stop pools (strength 3, strongest)
    2. Unmitigated FVGs        -> single-bar voids       (strength 2)
    3. Displacement voids      -> multi-bar impulse gaps (strength 1, weakest)

Lifecycle (mirrors the Pine source exactly):
    * dedupe within atr * vacClustTolAtr (keep the higher strength)
    * a pocket is dead when price CLOSES fully through it, OR its wick-scan
      fill fraction >= 0.85, OR it is older than vacLookback bars
    * cap vacMaxZones per side, dropping the weakest (ties -> oldest)

Magnet: the nearest live pocket on each side of close. Effective strength is
    3.0 * exp(-distance / (atr * vacProxAtr))
and the magnet direction is the nearest side (the way price must travel to
reach the pool).

This engine is deterministic and operates on CLOSED candles only, so results
never repaint — exactly like the Pine strategy (a pivot is registered
``vacPivotLen`` bars after it forms).

Reference: pine-strategy/7.4/OSC-vip-v7-4-lite.pine  (sections 1c and 4b).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# Reuse the exact ATR (Wilder RMA) and Pivot (no-repaint) primitives the rest of
# the v7.4 engine uses, so vacuum output is bar-for-bar faithful to Pine.
from engine.pine import ATR, Pivot


@dataclass
class Candle:
    """A closed OHLC bar. ``t`` is an epoch millisecond timestamp (bar open time)."""

    t: int
    o: float
    h: float
    l: float
    c: float


@dataclass
class VacuumZone:
    """A live untraded pocket (magnet)."""

    side: str          # "high" (above) | "low" (below)
    price: float       # magnet level
    top: float         # zone top
    bot: float         # zone bottom
    strength: int      # 1..3 source rank
    birth_bar: int     # bar_index at registration

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": "vacuum_zone",
            "side": self.side,
            "price": round(self.price, 2),
            "top": round(self.top, 2),
            "bot": round(self.bot, 2),
            "strength": self.strength,
            "birthBar": self.birth_bar,
        }


@dataclass
class _Swing:
    price: float
    bar: int


class VacuumEngine:
    """Candle-based liquidity vacuum detector.

    Feed CLOSED bars via :meth:`update`. Query live zones / magnet state via
    :meth:`zones`, :meth:`magnet`, and :meth:`to_dict`.
    """

    def __init__(
        self,
        atr_len: int = 14,
        pivot_len: int = 5,
        clust_tol_atr: float = 0.30,
        lookback: int = 150,
        fvg_min_atr: float = 0.20,
        prox_atr: float = 1.5,
        disp_len: int = 3,
        max_zones: int = 3,
        fill_dead_pct: float = 0.85,
    ):
        self.pivot_len = pivot_len
        self.clust_tol_atr = clust_tol_atr
        self.lookback = lookback
        self.fvg_min_atr = fvg_min_atr
        self.prox_atr = prox_atr
        self.disp_len = disp_len
        self.max_zones = max_zones
        self.fill_dead_pct = fill_dead_pct

        self._atr = ATR(atr_len)
        self._pivot_hi = Pivot(pivot_len, pivot_len, high=True)
        self._pivot_lo = Pivot(pivot_len, pivot_len, high=False)

        self.atr14: float = 0.0
        self.bar_index: int = -1

        # Rolling OHLC history (newest last). We index Pine-style via helpers.
        self._bars: List[Candle] = []

        # Live pockets, split by side.
        self._hi: List[VacuumZone] = []
        self._lo: List[VacuumZone] = []

        # Stored confirmed swings for the cluster (equal-high/low) detector.
        self._swing_hi: List[_Swing] = []
        self._swing_lo: List[_Swing] = []

        # Magnet state (refreshed each confirmed bar).
        self.vac_above: Optional[float] = None
        self.vac_below: Optional[float] = None
        self.vac_above_dist: Optional[float] = None
        self.vac_below_dist: Optional[float] = None
        self.vac_above_str: float = 0.0
        self.vac_below_str: float = 0.0
        self.magnet_dir: str = "none"  # "up" | "down" | "none"

    # ---- Pine-style back-indexing on closed bars ----------------------------
    def _close(self, back: int = 0) -> float:
        return self._bars[-1 - back].c

    def _high(self, back: int = 0) -> float:
        return self._bars[-1 - back].h

    def _low(self, back: int = 0) -> float:
        return self._bars[-1 - back].l

    def _highest(self, start_back: int, length: int) -> float:
        # ta.highest(high[start_back], length): window of `length` highs ending at start_back
        return max(self._high(start_back + i) for i in range(length))

    def _lowest(self, start_back: int, length: int) -> float:
        return min(self._low(start_back + i) for i in range(length))

    # ---- fill / consumption -------------------------------------------------
    def _fill_pct(self, p_top: float, p_bot: float, birth: int) -> float:
        """Fraction of bars since birth whose wick range overlaps the pocket."""
        n = min(self.bar_index - birth, 250)
        if n < 1:
            return 0.0
        tot = 0
        filled = 0
        for i in range(n):  # i = 0..n-1  (0 == current bar)
            tot += 1
            if self._low(i) <= p_top and self._high(i) >= p_bot:
                filled += 1
        return filled / tot if tot > 0 else 0.0

    # ---- registration -------------------------------------------------------
    def _add(self, is_hi: bool, price: float, p_top: float, p_bot: float, strg: int) -> None:
        arr = self._hi if is_hi else self._lo
        tol = self.atr14 * self.clust_tol_atr
        # dedupe against an existing live pocket on the same level (keep higher strength)
        for z in reversed(arr):
            if abs(z.price - price) <= tol:
                if strg > z.strength:
                    z.strength = strg
                return
        arr.append(
            VacuumZone(
                side="high" if is_hi else "low",
                price=price,
                top=p_top,
                bot=p_bot,
                strength=strg,
                birth_bar=self.bar_index,
            )
        )

    def _prune(self, is_hi: bool) -> None:
        arr = self._hi if is_hi else self._lo
        close = self._close()
        kept: List[VacuumZone] = []
        for z in arr:
            closed_through = close > z.top if is_hi else close < z.bot
            too_old = (self.bar_index - z.birth_bar) > self.lookback
            consumed = self._fill_pct(z.top, z.bot, z.birth_bar) >= self.fill_dead_pct
            if not (closed_through or too_old or consumed):
                kept.append(z)
        # cap count: drop weakest (lowest strength; tie -> oldest = lowest birth_bar)
        while len(kept) > self.max_zones:
            weak = 0
            for i in range(1, len(kept)):
                a, b = kept[i], kept[weak]
                if a.strength < b.strength or (a.strength == b.strength and a.birth_bar < b.birth_bar):
                    weak = i
            kept.pop(weak)
        if is_hi:
            self._hi = kept
        else:
            self._lo = kept

    # ---- swing / cluster helpers --------------------------------------------
    def _push_swing(self, store: List[_Swing], price: float) -> None:
        store.append(_Swing(price, self.bar_index))
        if len(store) > 40:
            store.pop(0)

    def _clean_swings(self, store: List[_Swing], is_hi: bool) -> None:
        close = self._close()
        kept: List[_Swing] = []
        for s in store:
            gone = (self.bar_index - s.bar) > self.lookback or (
                close > s.price if is_hi else close < s.price
            )
            if not gone:
                kept.append(s)
        store[:] = kept

    def _cluster_count(self, store: List[_Swing], pivot: float) -> int:
        tol = self.atr14 * self.clust_tol_atr
        return sum(1 for s in store if abs(s.price - pivot) <= tol)

    # ---- main step ----------------------------------------------------------
    def update(self, bar: Candle) -> None:
        """Ingest one CLOSED candle and advance all vacuum state."""
        self._bars.append(bar)
        if len(self._bars) > max(self.lookback + 300, 600):
            self._bars.pop(0)
        self.bar_index += 1

        self.atr14 = self._atr.update(bar.h, bar.l, bar.c) or 0.0
        phv = self._pivot_hi.update(bar.h)
        plv = self._pivot_lo.update(bar.l)

        # Vacuum engine requires a valid ATR to size everything.
        if self.atr14 <= 0.0:
            # still record pivots so cluster history builds up
            if phv is not None:
                self._push_swing(self._swing_hi, phv)
            if plv is not None:
                self._push_swing(self._swing_lo, plv)
            self._refresh_magnet()
            return

        self._clean_swings(self._swing_hi, is_hi=True)
        self._clean_swings(self._swing_lo, is_hi=False)

        # 1. Equal highs / lows (clustered stop pools) — strength 3
        if phv is not None:
            self._push_swing(self._swing_hi, phv)
            if self._cluster_count(self._swing_hi, phv) >= 2:
                self._add(True, phv, phv + self.atr14 * 0.15, phv - self.atr14 * 0.15, 3)
        if plv is not None:
            self._push_swing(self._swing_lo, plv)
            if self._cluster_count(self._swing_lo, plv) >= 2:
                self._add(False, plv, plv + self.atr14 * 0.15, plv - self.atr14 * 0.15, 3)

        # 2. Unmitigated FVGs (single-bar voids) — strength 2
        if len(self._bars) >= 3:
            fvg_min = self.atr14 * self.fvg_min_atr
            # bullish gap below: low - high[2] (pocket sits BELOW -> low side)
            if (self._low(0) - self._high(2)) > fvg_min:
                self._add(False, (self._low(0) + self._high(2)) / 2, self._low(0), self._high(2), 2)
            # bearish gap above: low[2] - high (pocket sits ABOVE -> high side)
            if (self._low(2) - self._high(0)) > fvg_min:
                self._add(True, (self._low(2) + self._high(0)) / 2, self._low(2), self._high(0), 2)

        # 3. Displacement voids (multi-bar impulse gap) — strength 1
        if self.disp_len >= 2 and len(self._bars) >= self.disp_len * 2 + 1:
            span_h1 = self._highest(self.disp_len, self.disp_len)
            span_l1 = self._lowest(self.disp_len, self.disp_len)
            if (self._low(0) - span_h1) > self.atr14 * 0.3:
                self._add(False, (self._low(0) + span_h1) / 2, self._low(0), span_h1, 1)
            if (span_l1 - self._high(0)) > self.atr14 * 0.3:
                self._add(True, (span_l1 + self._high(0)) / 2, span_l1, self._high(0), 1)

        self._prune(True)
        self._prune(False)
        self._refresh_magnet()

    def _refresh_magnet(self) -> None:
        if not self._bars:
            return
        close = self._close()
        self.vac_above = None
        self.vac_below = None
        self.vac_above_str = 0.0
        self.vac_below_str = 0.0
        bd_a = float("inf")
        bd_b = float("inf")
        for z in self._hi:
            if z.price > close:
                d = z.price - close
                if d < bd_a:
                    bd_a = d
                    self.vac_above = z.price
        for z in self._lo:
            if z.price < close:
                d = close - z.price
                if d < bd_b:
                    bd_b = d
                    self.vac_below = z.price
        self.vac_above_dist = None if bd_a == float("inf") else bd_a
        self.vac_below_dist = None if bd_b == float("inf") else bd_b

        import math

        if self.vac_above_dist is not None and self.atr14 > 0:
            self.vac_above_str = 3.0 * math.exp(-self.vac_above_dist / (self.atr14 * self.prox_atr))
        if self.vac_below_dist is not None and self.atr14 > 0:
            self.vac_below_str = 3.0 * math.exp(-self.vac_below_dist / (self.atr14 * self.prox_atr))

        # magnet direction: nearest side price must travel to reach the pool
        up = self.vac_above is not None and (
            self.vac_below is None or self.vac_above_dist <= self.vac_below_dist
        )
        down = self.vac_below is not None and (
            self.vac_above is None or self.vac_below_dist < self.vac_above_dist
        )
        self.magnet_dir = "up" if up else "down" if down else "none"

    # ---- queries ------------------------------------------------------------
    def zones(self) -> List[VacuumZone]:
        return list(self._hi) + list(self._lo)

    def magnet(self) -> Dict[str, Any]:
        return {
            "direction": self.magnet_dir,
            "abovePrice": None if self.vac_above is None else round(self.vac_above, 2),
            "belowPrice": None if self.vac_below is None else round(self.vac_below, 2),
            "aboveDistance": None if self.vac_above_dist is None else round(self.vac_above_dist, 3),
            "belowDistance": None if self.vac_below_dist is None else round(self.vac_below_dist, 3),
            "aboveStrength": round(self.vac_above_str, 3),
            "belowStrength": round(self.vac_below_str, 3),
            "atr": round(self.atr14, 3),
        }

    def to_dict(self) -> Dict[str, Any]:
        return {
            "vacuum_zones": [z.to_dict() for z in self.zones()],
            "vacuum_magnet": self.magnet(),
        }
