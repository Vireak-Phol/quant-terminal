"""Bar-for-bar parity of the Python Unicorn FVG engine vs TradingView REG v7.4.

Fixture columns used:
  reg_bull_setup  -> newBullish alert (18 events in-window)
  reg_bear_setup  -> newBearish alert (17 events in-window)
  reg_active_fvg  -> "Active FVG Setups" data-window plot

The last CSV row is the still-forming realtime bar and is excluded. A warm-up prefix is
skipped before scoring events so EMA(200)/SMA(50) MTF state has filled with identical
data on both sides.
"""

import csv
import os

import pytest

from engine.reg.unicorn import UnicornConfig, UnicornEngine

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
WARMUP = 150  # full-series parity is exact; a short warm-up keeps a safety margin


def _load():
    with open(os.path.join(FIX, "tv_xauusd_5m.csv")) as fh:
        return list(csv.DictReader(fh))


def _truthy(v):
    try:
        return float(v) != 0.0
    except (TypeError, ValueError):
        return bool(v)


@pytest.fixture(scope="module")
def replay():
    rows = _load()[:-1]  # drop forming bar
    eng = UnicornEngine(UnicornConfig(mintick=0.01))
    out = []
    for r in rows:
        bar = eng.update(
            int(float(r["time"])), float(r["open"]), float(r["high"]),
            float(r["low"]), float(r["close"]), float(r["volume"] or 0),
        )
        out.append(bar)
    return rows, out


def _confusion(rows, out, col, get):
    tp = fp = fn = 0
    for i in range(WARMUP, len(rows)):
        exp = _truthy(rows[i][col])
        got = bool(get(out[i]))
        if exp and got:
            tp += 1
        elif got and not exp:
            fp += 1
        elif exp and not got:
            fn += 1
    return tp, fp, fn


def test_new_bullish_parity(replay):
    rows, out = replay
    tp, fp, fn = _confusion(rows, out, "reg_bull_setup", lambda b: b.new_bullish)
    print(f"\nnewBullish  TP={tp} FP={fp} FN={fn}")
    assert tp >= 1, "no true-positive bullish events captured"
    # exact parity target on CTF-driven events
    assert fp == 0 and fn == 0, f"bullish mismatch TP={tp} FP={fp} FN={fn}"


def test_new_bearish_parity(replay):
    rows, out = replay
    tp, fp, fn = _confusion(rows, out, "reg_bear_setup", lambda b: b.new_bearish)
    print(f"\nnewBearish  TP={tp} FP={fp} FN={fn}")
    assert tp >= 1, "no true-positive bearish events captured"
    assert fp == 0 and fn == 0, f"bearish mismatch TP={tp} FP={fp} FN={fn}"


def test_active_fvg_count_parity(replay):
    rows, out = replay
    errs = []
    for i in range(WARMUP, len(rows)):
        exp = rows[i]["reg_active_fvg"]
        if exp in ("", None):
            continue
        errs.append(abs(int(float(exp)) - out[i].active_fvg_count))
    assert len(errs) > 500
    print(f"\nactive_fvg max|Δ|={max(errs)} mean|Δ|={sum(errs)/len(errs):.3f}")
    assert max(errs) == 0


def test_events_exist(replay):
    rows, out = replay
    assert sum(1 for b in out if b.new_bullish) >= 10
    assert sum(1 for b in out if b.new_bearish) >= 10
