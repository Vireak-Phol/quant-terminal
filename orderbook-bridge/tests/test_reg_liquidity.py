"""Bar-for-bar parity of the Python REG liquidity engine vs TradingView REG v7.4.

Fixture: 6,251 OANDA:XAUUSD 5m bars exported from TradingView with REG plot values.
Compared columns:
  * ``reg_liq_sweep``  — 1 on bars where Pine ``newLiqSweep`` fired (280 events total).
  * ``reg_active_liq`` — the "Active Liquidity Zones" data-window plot.

The final row is the still-forming realtime bar at export time and is excluded. A 500-bar
warm-up lets the pivot / ATR / lookback windows fill with identical data before comparing.
"""

import csv
import os

import pytest

from engine.reg.liquidity import LiquidityConfig, LiquidityEngine

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
WARMUP = 500


def _f(x):
    return float(x) if x not in ("", None) else None


def _load():
    with open(os.path.join(FIX, "tv_xauusd_5m.csv")) as fh:
        return list(csv.DictReader(fh))


@pytest.fixture(scope="module")
def run():
    rows = _load()[:-1]  # drop forming bar
    eng = LiquidityEngine(LiquidityConfig())
    out = []
    for r in rows:
        out.append(eng.update(
            int(float(r["time"])), float(r["open"]), float(r["high"]),
            float(r["low"]), float(r["close"]), float(r["volume"] or 0),
        ))
    return rows, out


def _window(run):
    rows, out = run
    return list(zip(rows, out))[WARMUP:]


# ── liquidity sweep flag ────────────────────────────────────────────────────
def test_liq_sweep_confusion(run):
    """Report TP/FP/FN for reg_liq_sweep and assert the match rate achieved."""
    pairs = _window(run)
    tp = fp = fn = 0
    for r, o in pairs:
        exp = bool(_f(r["reg_liq_sweep"]) or 0)
        got = bool(o.new_liq_sweep)
        if exp and got:
            tp += 1
        elif got and not exp:
            fp += 1
        elif exp and not got:
            fn += 1
    total_events = tp + fn
    print(f"\n[reg_liq_sweep] TP={tp} FP={fp} FN={fn} expected_events={total_events}")
    # There must be a meaningful number of real events to compare against.
    assert total_events >= 200, f"too few expected sweep events in window: {total_events}"
    # Exact parity achieved on the warm-up-trimmed window.
    assert fp == 0 and fn == 0, f"liq sweep mismatch: TP={tp} FP={fp} FN={fn}"


def test_liq_sweep_total_events_matches_fixture(run):
    """The fixture advertises 280 sweep events across the full (pre-forming) set."""
    rows, out = run
    exp = sum(1 for r in rows if bool(_f(r["reg_liq_sweep"]) or 0))
    got = sum(1 for o in out if o.new_liq_sweep)
    print(f"\n[reg_liq_sweep full set] expected={exp} got={got}")
    assert got == exp


def test_liq_sweep_direction_is_set(run):
    """Every fired sweep carries a non-zero direction."""
    pairs = _window(run)
    bad = [i for i, (_, o) in enumerate(pairs) if o.new_liq_sweep and o.new_liq_sweep_dir == 0]
    assert bad == []


# ── active zone count ───────────────────────────────────────────────────────
def test_active_liq_zones_exact(run):
    """Active Liquidity Zones count must match bar-for-bar after warm-up."""
    pairs = _window(run)
    mism = [(i, int(_f(r["reg_active_liq"]) or 0), o.active_liq_zones)
            for i, (r, o) in enumerate(pairs)
            if int(_f(r["reg_active_liq"]) or 0) != o.active_liq_zones]
    rate = 1.0 - len(mism) / len(pairs)
    print(f"\n[reg_active_liq] mismatches={len(mism)}/{len(pairs)} match_rate={rate:.6f}")
    if mism:
        print("  first 5:", mism[:5])
    assert mism == [], f"active-zone mismatch on {len(mism)} bars (rate={rate:.6f})"


# ── HTF key levels sanity ───────────────────────────────────────────────────
def test_htf_levels_present_and_sane(run):
    """PDH/PDL/PWH/PWL populate after warm-up and respect high>=low ordering.

    The fixture spans only ~1 month (~4.4 weeks), so a prior *completed* daily bar is
    available for almost the whole window, but a prior completed *weekly* bar only exists
    after the first full week closes — hence the lower weekly coverage threshold.
    """
    pairs = _window(run)
    have_day = [o for _, o in pairs if o.pdh is not None and o.pdl is not None]
    have_wk = [o for _, o in pairs if o.pwh is not None and o.pwl is not None]
    assert len(have_day) > len(pairs) * 0.95
    assert len(have_wk) > len(pairs) * 0.80
    assert all(o.pdh >= o.pdl for o in have_day)
    assert all(o.pwh >= o.pwl for o in have_wk)


def test_levels_snapshot_matches_count(run):
    """The exported active-level snapshot length equals the active-zone count."""
    pairs = _window(run)
    assert all(len(o.levels) == o.active_liq_zones for _, o in pairs)
