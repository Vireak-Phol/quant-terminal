"""Regression OB engine tests.

The parity fixture has ZERO Reg OB events in-window because Pine's master
``optimizeForScalping`` input defaults to True, which disables Reg OB detection. The
first test confirms the ported engine reproduces that (no events with Pine defaults).
The remaining tests are synthetic and exercise each detection branch explicitly:
zero-delay bull/bear, legacy bull/bear, dedupe suppression, mitigation removal,
distance culling, and the regression channel math (validated vs ordinary least squares).
"""

import csv
import math
import os
import statistics

import pytest

from engine.reg.regob import RegObConfig, RegObEngine

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _load():
    with open(os.path.join(FIX, "tv_xauusd_5m.csv")) as fh:
        return list(csv.DictReader(fh))[:-1]


def _feed(eng, bars):
    out = []
    for t, o, h, l, c in bars:
        out.append(eng.update(t, o, h, l, c, 0.0))
    return out


# ───────────────────────── parity (no events) ─────────────────────────


def test_fixture_no_regob_events_with_pine_defaults():
    rows = _load()
    eng = RegObEngine()  # Pine defaults: optimizeForScalping=True disables detection
    nb = nbe = 0
    for r in rows:
        b = eng.update(int(float(r["time"])), float(r["open"]), float(r["high"]),
                       float(r["low"]), float(r["close"]), float(r["volume"] or 0))
        nb += b.bull_ob
        nbe += b.bear_ob
    assert nb == 0 and nbe == 0


# ───────────────────────── regression channel math ─────────────────────────


def test_regression_channel_matches_ols():
    rows = _load()
    eng = RegObEngine(RegObConfig(optimize_for_scalping=False))
    last = None
    for r in rows:
        last = eng.update(int(float(r["time"])), float(r["open"]), float(r["high"]),
                          float(r["low"]), float(r["close"]), float(r["volume"] or 0))
    closes = [float(r["close"]) for r in rows]
    N = 100
    win = closes[-N:]
    xs = list(range(1, N + 1))
    mx = sum(xs) / N
    my = sum(win) / N
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, win))
    sxx = sum((x - mx) ** 2 for x in xs)
    slope = sxy / sxx
    intercept = my - slope * mx
    end = intercept + slope * N
    r = sxy / math.sqrt(sxx * sum((y - my) ** 2 for y in win))
    stddev = statistics.pstdev(win) * math.sqrt(max(0.0, 1 - r * r))
    assert abs(last.reg_mid - end) < 1e-6
    assert abs(last.reg_upper - (end + 2 * stddev)) < 1e-6
    assert abs(last.reg_lower - (end - 2 * stddev)) < 1e-6


# ───────────────────────── synthetic branch coverage ─────────────────────────


def _rising_base(n, start=100.0, step=0.0):
    """Flat/neutral warmup bars to fill the regLength window."""
    return [(1000 + i * 300, start, start + 0.1, start - 0.1, start) for i in range(n)]


def test_zero_delay_bull_ob_confirms():
    # Zero-delay bull OB: source candle is BEARISH (close<open) at bar[1], then
    # reg_ob_periods consecutive BULL confirming bars.
    cfg = RegObConfig(optimize_for_scalping=False, reg_early_detect=True,
                      reg_ob_periods=3, reg_length=10, reg_remove_mitigated=False,
                      cull_far_zones=False)
    eng = RegObEngine(cfg)
    bars = _rising_base(12, 100.0)
    t = 1000 + 12 * 300
    # source bearish candle
    bars.append((t, 101.0, 101.2, 99.5, 99.6)); t += 300           # bear source
    # three confirming bull candles
    for px in (99.8, 100.2, 100.6):
        bars.append((t, px, px + 0.5, px - 0.1, px + 0.4)); t += 300
    out = _feed(eng, bars)
    assert any(b.bull_ob for b in out), "zero-delay bull OB never confirmed"
    assert any(z.side == "bull" and z.confirmed for b in out for z in b.zones)


def test_zero_delay_bear_ob_confirms():
    cfg = RegObConfig(optimize_for_scalping=False, reg_early_detect=True,
                      reg_ob_periods=3, reg_length=10, reg_remove_mitigated=False,
                      cull_far_zones=False)
    eng = RegObEngine(cfg)
    bars = _rising_base(12, 100.0)
    t = 1000 + 12 * 300
    bars.append((t, 99.0, 100.5, 98.9, 100.4)); t += 300           # bull source
    for px in (100.4, 100.0, 99.6):
        bars.append((t, px, px + 0.1, px - 0.5, px - 0.4)); t += 300
    out = _feed(eng, bars)
    assert any(b.bear_ob for b in out), "zero-delay bear OB never confirmed"
    assert any(z.side == "bear" and z.confirmed for b in out for z in b.zones)


def test_zero_delay_non_confirming_bar_invalidates_pending():
    cfg = RegObConfig(optimize_for_scalping=False, reg_early_detect=True,
                      reg_ob_periods=3, reg_length=10, reg_remove_mitigated=False,
                      cull_far_zones=False)
    eng = RegObEngine(cfg)
    bars = _rising_base(12, 100.0)
    t = 1000 + 12 * 300
    bars.append((t, 101.0, 101.2, 99.5, 99.6)); t += 300           # bear source -> pending bull
    bars.append((t, 99.8, 100.2, 99.7, 100.1)); t += 300           # confirm 1 (bull)
    bars.append((t, 100.1, 100.2, 99.0, 99.1)); t += 300           # NON-confirming (bear) -> invalidate
    out = _feed(eng, bars)
    assert not any(b.bull_ob for b in out)
    assert not any(z.side == "bull" and z.confirmed for b in out for z in b.zones)


def test_legacy_bull_ob_detects():
    # Legacy mode: source candle at bar[regObPeriods+1] bearish, then regObPeriods bull bars.
    cfg = RegObConfig(optimize_for_scalping=False, reg_early_detect=False,
                      reg_ob_periods=3, reg_length=10, reg_remove_mitigated=False,
                      cull_far_zones=False)
    eng = RegObEngine(cfg)
    bars = _rising_base(12, 100.0)
    t = 1000 + 12 * 300
    bars.append((t, 101.0, 101.2, 99.0, 99.2)); t += 300           # bear source (lookback)
    for px in (99.4, 99.9, 100.5):                                  # 3 bull bars
        bars.append((t, px, px + 0.5, px - 0.05, px + 0.45)); t += 300
    bars.append((t, 100.9, 101.1, 100.8, 101.0)); t += 300          # current bar: confirms lookback
    out = _feed(eng, bars)
    assert any(b.bull_ob for b in out), "legacy bull OB not detected"


def test_legacy_bear_ob_detects():
    cfg = RegObConfig(optimize_for_scalping=False, reg_early_detect=False,
                      reg_ob_periods=3, reg_length=10, reg_remove_mitigated=False,
                      cull_far_zones=False)
    eng = RegObEngine(cfg)
    bars = _rising_base(12, 100.0)
    t = 1000 + 12 * 300
    bars.append((t, 99.0, 101.0, 98.9, 100.8)); t += 300           # bull source (lookback)
    for px in (100.6, 100.1, 99.5):                                 # 3 bear bars
        bars.append((t, px, px + 0.05, px - 0.5, px - 0.45)); t += 300
    bars.append((t, 99.1, 99.2, 98.9, 99.0)); t += 300
    out = _feed(eng, bars)
    assert any(b.bear_ob for b in out), "legacy bear OB not detected"


def test_dedupe_suppresses_stacked_bull_obs():
    # Two bull OB sources: when they land on the SAME level the dedupe suppresses the
    # second zone; on DIFFERENT levels both survive. This isolates the dedupe branch.
    def run(same_level):
        cfg = RegObConfig(optimize_for_scalping=False, reg_early_detect=True,
                          reg_ob_periods=2, reg_length=10, reg_dedupe_atr=0.5,
                          reg_remove_mitigated=False, cull_far_zones=False)
        eng = RegObEngine(cfg)
        bars = _rising_base(12, 100.0)
        t = [1000 + 12 * 300]

        def pulse(level):
            bars.append((t[0], level + 1.0, level + 1.1, level - 0.5, level - 0.4)); t[0] += 300  # bear source
            bars.append((t[0], level - 0.3, level + 0.3, level - 0.4, level + 0.2)); t[0] += 300  # confirm 1
            bars.append((t[0], level + 0.2, level + 0.6, level + 0.1, level + 0.5)); t[0] += 300  # confirm 2 -> confirmed
            bars.append((t[0], level + 0.5, level + 0.7, level + 0.4, level + 0.6)); t[0] += 300  # spacer

        pulse(100.0)
        pulse(100.0 if same_level else 120.0)
        out = _feed(eng, bars)
        return len([z for z in out[-1].zones if z.side == "bull"])

    assert run(True) == 1, "dedupe did not suppress same-level stacked OB"
    assert run(False) == 2, "distinct-level OBs should both survive"


def test_mitigation_removes_zone():
    cfg = RegObConfig(optimize_for_scalping=False, reg_early_detect=True,
                      reg_ob_periods=2, reg_length=10, reg_remove_mitigated=True,
                      cull_far_zones=False)
    eng = RegObEngine(cfg)
    bars = _rising_base(12, 100.0)
    t = 1000 + 12 * 300
    bars.append((t, 101.0, 101.1, 99.5, 99.6)); t += 300            # bear source -> bull OB
    bars.append((t, 99.7, 100.3, 99.6, 100.2)); t += 300            # confirm 1
    bars.append((t, 100.2, 100.6, 100.1, 100.5)); t += 300          # confirm 2 -> confirmed
    out = _feed(eng, bars)
    assert any(z.side == "bull" for z in out[-1].zones)
    # price closes below the OB bottom -> mitigation removes it
    bars2 = [(t, 100.0, 100.1, 95.0, 95.1)]
    out2 = _feed(eng, bars2)
    assert not any(z.side == "bull" for z in out2[-1].zones)


def test_distance_cull_removes_far_zone():
    cfg = RegObConfig(optimize_for_scalping=False, reg_early_detect=True,
                      reg_ob_periods=2, reg_length=10, reg_remove_mitigated=False,
                      cull_far_zones=True, max_zone_dist_atr=2.0)
    eng = RegObEngine(cfg)
    bars = _rising_base(12, 100.0)
    t = 1000 + 12 * 300
    bars.append((t, 101.0, 101.1, 99.5, 99.6)); t += 300
    bars.append((t, 99.7, 100.3, 99.6, 100.2)); t += 300
    bars.append((t, 100.2, 100.6, 100.1, 100.5)); t += 300          # confirmed bull OB near 100
    out = _feed(eng, bars)
    assert any(z.side == "bull" for z in out[-1].zones)
    # price runs far away; bull OB sits far below -> culled (bear side close>top not mitigated,
    # but cull by distance). Use a big move that stays above the zone.
    bars2 = []
    px = 100.5
    for _ in range(5):
        px += 3.0
        bars2.append((t, px, px + 0.2, px - 0.1, px + 0.1)); t += 300
    out2 = _feed(eng, bars2)
    # distance cull should have dropped the now-far zone
    assert not any(z.side == "bull" for z in out2[-1].zones)
