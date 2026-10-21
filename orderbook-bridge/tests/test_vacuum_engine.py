"""Unit tests for the liquidity vacuum engine (Pine v7.4 port)."""

import math

from analytics.vacuum_engine import Candle, VacuumEngine


def _warm(eng: VacuumEngine, base: float = 2000.0, n: int = 40, atr_target: float = 2.0):
    """Feed flat-ish bars so ATR warms to roughly `atr_target` and pivots can form."""
    t = 1_700_000_000_000
    for i in range(n):
        # alternate small ranges to build a stable ATR without creating gaps
        o = base
        c = base
        h = base + atr_target / 2
        l = base - atr_target / 2
        eng.update(Candle(t=t + i * 60_000, o=o, h=h, l=l, c=c))


def test_atr_and_bar_index_advance():
    eng = VacuumEngine()
    _warm(eng, n=20)
    assert eng.bar_index == 19
    assert eng.atr14 > 0


def test_fvg_bull_creates_low_side_zone():
    """A clean upward gap (low - high[2] > fvgMin) registers a low-side vacuum."""
    eng = VacuumEngine(pivot_len=5)
    _warm(eng, base=2000.0, n=30, atr_target=1.0)  # atr ~ 1.0 -> fvgMin ~ 0.20
    t = 1_700_100_000_000
    # bar[2]: high=2000.5 ; then a middle bar ; then a bar whose low jumps above high[2]
    eng.update(Candle(t=t, o=2000.0, h=2000.5, l=1999.5, c=2000.0))       # this becomes high[2]
    eng.update(Candle(t=t + 60_000, o=2001.0, h=2002.0, l=2000.8, c=2001.5))
    eng.update(Candle(t=t + 120_000, o=2002.0, h=2003.0, l=2001.5, c=2002.5))  # low=2001.5 - high[2]=2000.5 = 1.0 > min
    lows = [z for z in eng.zones() if z.side == "low"]
    assert any(z.strength == 2 for z in lows), "expected an FVG (strength 2) low-side vacuum"


def test_fvg_bear_creates_high_side_zone():
    eng = VacuumEngine(pivot_len=5)
    _warm(eng, base=2000.0, n=30, atr_target=1.0)
    t = 1_700_200_000_000
    eng.update(Candle(t=t, o=2000.0, h=2000.5, l=1999.5, c=2000.0))        # low[2] = 1999.5
    eng.update(Candle(t=t + 60_000, o=1999.0, h=1999.2, l=1998.0, c=1998.5))
    eng.update(Candle(t=t + 120_000, o=1998.0, h=1998.0, l=1997.0, c=1997.5))  # low[2]=1999.5 - high=1998.0 = 1.5 > min
    highs = [z for z in eng.zones() if z.side == "high"]
    assert any(z.strength == 2 for z in highs)


def test_equal_lows_cluster_is_strength_3():
    """Two pivot lows at the same level within tolerance -> strength-3 stop pool."""
    eng = VacuumEngine(pivot_len=2, clust_tol_atr=0.30)
    t = 1_700_300_000_000
    # Warm ATR first with bars that sit ABOVE the future 2005 pool so they create
    # no spurious low pivots and never close through it (ATR target ~2.0).
    for i in range(20):
        eng.update(Candle(t=t + i * 60_000, o=2010.0, h=2011.0, l=2009.0, c=2010.0))
    assert eng.atr14 > 0
    # Now fire pivotlow (len=2) twice at ~ the same low (2005), price staying ABOVE.
    base_t = t + 20 * 60_000
    seq = [
        (2010, 2011, 2009),   # 0
        (2010, 2011, 2009),   # 1
        (2010, 2011, 2005),   # 2  <- pivot low candidate center (needs 2 left/right)
        (2010, 2011, 2009),   # 3
        (2010, 2011, 2009),   # 4
        (2010, 2011, 2009),   # 5
        (2010, 2011, 2005),   # 6  <- second pivot low near 2005
        (2010, 2011, 2009),   # 7
        (2010, 2011, 2009),   # 8
        (2012, 2013, 2011),   # 9  stays well above the 2005 pool
        (2012, 2013, 2011),   # 10
    ]
    for i, (o, h, l) in enumerate(seq):
        c = o
        eng.update(Candle(t=base_t + i * 60_000, o=float(o), h=float(h), l=float(l), c=float(c)))
    lows = [z for z in eng.zones() if z.side == "low"]
    assert any(z.strength == 3 for z in lows), f"expected strength-3 cluster, got {[z.strength for z in lows]}"


def test_dedupe_keeps_higher_strength():
    eng = VacuumEngine()
    _warm(eng, n=20, atr_target=2.0)
    eng.atr14 = 2.0  # pin tolerance -> 0.6
    # add a weak zone then a strong zone at ~same level
    eng._add(True, 2005.0, 2005.3, 2004.7, 1)
    eng._add(True, 2005.1, 2005.4, 2004.8, 3)  # within 0.6 tol -> dedupe, upgrade strength
    highs = [z for z in eng.zones() if z.side == "high"]
    assert len(highs) == 1
    assert highs[0].strength == 3


def test_closed_through_consumes_zone():
    eng = VacuumEngine()
    _warm(eng, base=2000.0, n=20, atr_target=2.0)
    eng._add(True, 2005.0, 2005.3, 2004.7, 2)  # high-side pocket above
    assert any(z.side == "high" for z in eng.zones())
    # a bar that closes ABOVE the pocket top consumes it
    t = eng._bars[-1].t + 60_000
    eng.update(Candle(t=t, o=2005.0, h=2006.5, l=2004.9, c=2006.0))  # close 2006 > top 2005.3
    assert not any(z.side == "high" and abs(z.price - 2005.0) < 0.1 for z in eng.zones())


def test_age_expiry():
    eng = VacuumEngine(lookback=10)
    _warm(eng, base=2000.0, n=20, atr_target=2.0)
    eng._add(False, 1990.0, 1990.3, 1989.7, 1)  # low-side far below, won't be closed-through
    # advance > lookback bars with price staying above (so only age kills it)
    t = eng._bars[-1].t
    for i in range(1, 15):
        eng.update(Candle(t=t + i * 60_000, o=2000.0, h=2001.0, l=1999.0, c=2000.0))
    assert not any(abs(z.price - 1990.0) < 0.1 for z in eng.zones())


def test_cap_per_side_drops_weakest():
    eng = VacuumEngine(max_zones=3)
    _warm(eng, base=2000.0, n=20, atr_target=2.0)
    eng.atr14 = 2.0
    # four distinct high-side pockets, strengths 1,2,3,3 -> weakest (strength 1) dropped
    eng._add(True, 2010.0, 2010.3, 2009.7, 1)
    eng._add(True, 2020.0, 2020.3, 2019.7, 2)
    eng._add(True, 2030.0, 2030.3, 2029.7, 3)
    eng._add(True, 2040.0, 2040.3, 2039.7, 3)
    eng._prune(True)
    highs = [z for z in eng.zones() if z.side == "high"]
    assert len(highs) == 3
    assert all(z.strength >= 2 for z in highs)
    assert not any(abs(z.price - 2010.0) < 0.1 for z in highs)


def test_magnet_strength_and_direction():
    eng = VacuumEngine(prox_atr=1.5)
    _warm(eng, base=2000.0, n=20, atr_target=2.0)
    eng.atr14 = 2.0
    # a pocket above at 2003 (dist 3 from close 2000) and below at 1990 (dist 10)
    # nearest side is up -> magnet up
    eng._hi = []
    eng._lo = []
    eng._add(True, 2003.0, 2003.3, 2002.7, 3)
    eng._add(False, 1990.0, 1990.3, 1989.7, 3)
    # pin close to 2000 by refreshing after setting last bar close
    eng._bars[-1].c = 2000.0
    eng._refresh_magnet()
    assert eng.magnet_dir == "up"
    # strength = 3 * exp(-dist/(atr*prox)) ; above dist=3, atr=2, prox=1.5 -> exp(-1)
    expected = 3.0 * math.exp(-3.0 / (2.0 * 1.5))
    assert abs(eng.vac_above_str - expected) < 1e-9


def test_to_dict_shape():
    eng = VacuumEngine()
    _warm(eng, n=20, atr_target=2.0)
    d = eng.to_dict()
    assert set(d.keys()) == {"vacuum_zones", "vacuum_magnet"}
    assert "direction" in d["vacuum_magnet"]
    assert isinstance(d["vacuum_zones"], list)
