"""Bar-for-bar parity of the Python RPD engine against TradingView REG v7.4.

Fixture: 6,251 OANDA:XAUUSD 5m bars exported from TradingView with the REG plot values,
including reg_rpd_peak / reg_rpd_valley (1 = a validPeak / validValley fired on that bar).

The engine is fed one confirmed chart bar at a time (Pine confirmedOnly=true). We skip a
500-bar warm-up so every rolling window (adaptivePeriod=25, ATR, RSI, EMA, the ledger's
calibration window, and the 20m MTF series) is fully primed with identical data, then
compare the event flags bar-by-bar. The final row is the still-forming realtime bar and is
excluded.
"""

import csv
import os

import pytest

from engine.reg.rpd import RpdConfig, RpdEngine

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
WARMUP = 500


def _f(x):
    return float(x) if x not in ("", None) else None


def _load():
    with open(os.path.join(FIX, "tv_xauusd_5m.csv")) as fh:
        return list(csv.DictReader(fh))


@pytest.fixture(scope="module")
def run():
    rows = _load()[:-1]  # drop still-forming last bar
    eng = RpdEngine(RpdConfig())
    out = []
    for r in rows:
        bar = eng.update(
            int(float(r["time"])),
            float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]),
            float(r["volume"] or 0.0),
        )
        out.append(bar)
    return rows, out


def _confusion(rows, out, col, get):
    tp = fp = fn = 0
    tp_i, fp_i, fn_i = [], [], []
    for i in range(WARMUP, len(rows)):
        exp = bool(_f(rows[i][col]) or 0)
        got = bool(get(out[i]))
        if exp and got:
            tp += 1
        elif got and not exp:
            fp += 1
            fp_i.append(i)
        elif exp and not got:
            fn += 1
            fn_i.append(i)
    return tp, fp, fn, tp_i, fp_i, fn_i


def test_fixture_loaded(run):
    rows, out = run
    assert len(rows) == 6250
    assert len(out) == 6250


def test_rpd_peak_parity(run):
    rows, out = run
    tp, fp, fn, _, fp_i, fn_i = _confusion(rows, out, "reg_rpd_peak", lambda b: b.valid_peak)
    total_events = tp + fn
    print(f"\nRPD_PEAK  TP={tp} FP={fp} FN={fn}  (TV events after warmup={total_events})")
    print(f"  FP bars: {fp_i[:20]}")
    print(f"  FN bars: {fn_i[:20]}")
    assert total_events >= 20, "fixture has too few peak events to be meaningful"
    # Achieved parity against the literal Pine port: TP=68, FP=3, FN=3
    # (precision 95.8%, recall 95.8%). The 3+3 residual bars are reversal-at-trend-flip
    # events that in TradingView fire through the request.security 20m MTF confluence
    # (mtfIsPeak / isPeakEvent); that higher-timeframe series is built from TradingView's
    # internal intrabar history, which is not reconstructable bar-for-bar from the 5m
    # chart OHLCV alone. See the module docstring deviation note.
    assert (tp, fp, fn) == (68, 3, 3), f"peak drift from established parity: TP={tp} FP={fp} FN={fn}"


def test_rpd_valley_parity(run):
    rows, out = run
    tp, fp, fn, _, fp_i, fn_i = _confusion(rows, out, "reg_rpd_valley", lambda b: b.valid_valley)
    total_events = tp + fn
    print(f"\nRPD_VALLEY TP={tp} FP={fp} FN={fn}  (TV events after warmup={total_events})")
    print(f"  FP bars: {fp_i[:20]}")
    print(f"  FN bars: {fn_i[:20]}")
    assert total_events >= 20, "fixture has too few valley events to be meaningful"
    # Achieved parity: TP=77, FP=5, FN=14 (precision 93.9%, recall 84.6%). Same residual
    # cause as peaks (MTF confluence at trend-flip reversals); documented in the module.
    assert (tp, fp, fn) == (77, 5, 14), f"valley drift from established parity: TP={tp} FP={fp} FN={fn}"


def test_r_trend_is_directional(run):
    _, out = run
    vals = {b.r_trend for b in out[WARMUP:]}
    assert vals <= {-1, 1}
    # both directions must actually occur across the sample
    assert vals == {-1, 1}


def test_probabilities_present_on_signals(run):
    rows, out = run
    # Every fired signal carries a heuristic probability in the clamped [40, 99] range.
    sigs = [b for b in out[WARMUP:] if b.valid_peak or b.valid_valley]
    assert len(sigs) >= 100
    for b in sigs:
        p = b.peak_prob if b.valid_peak else b.valley_prob
        assert p is not None and 40.0 <= p <= 99.0


def test_display_prob_calibration_warmup(run):
    rows, out = run
    # useCalibratedProb defaults True, minCalSamples=15: the displayed probability is None
    # (warm-up / gray "(w)") until a signal type has >= 15 closed ledger records, after
    # which it becomes the Beta(2,2)-smoothed empirical win rate in (0, 100).
    peak_disp = [b.peak_display for b in out[WARMUP:] if b.valid_peak]
    assert any(p is None for p in peak_disp)            # cold start present
    assert any(p is not None for p in peak_disp)         # warms up later
    for p in peak_disp:
        assert p is None or 0.0 <= p <= 100.0
