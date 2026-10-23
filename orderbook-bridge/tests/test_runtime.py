"""Runtime integration: TimeframeEngine over the TradingView fixture (Pine & Institutional flow modes)."""

import json

import pytest

from engine.calibration import Calibrator, compute_stat
from engine.data import Kline
from engine.ledger import Ledger
from engine.backtest import report, run_backtest
from engine.runtime import TimeframeEngine
from parity import load_bars, run_osc_parity


def _k(b):
    return Kline(int(b[0]), b[1], b[2], b[3], b[4], b[5] or 0.0, 0.0)


@pytest.fixture(scope="module")
def data():
    five = [_k(b) for b in load_bars("tv_xauusd_5m.csv")][:-1]
    one = [_k(b) for b in load_bars("tv_xauusd_1m.csv")]
    four = [_k(b) for b in load_bars("tv_xauusd_4h.csv")]
    return five, one, four


@pytest.fixture(scope="module")
def bt(data, tmp_path_factory):
    five, one, four = data
    led = Ledger(str(tmp_path_factory.mktemp("rt") / "l.db"))
    return run_backtest("5m", five, one, four, led, flow_mode="pine"), led


def test_runtime_aplus_matches_osc_parity(bt):
    res, _ = bt
    eng: TimeframeEngine = res["engine"]
    parity = run_osc_parity(use_macro=False)
    lo = parity.ltf_covered_from + 150
    want = {(o.t, "LONG") for o in parity.out[lo:-1] if o.aplus_bull} | {(o.t, "SHORT") for o in parity.out[lo:-1] if o.aplus_bear}
    # signals deque holds only the most recent 200; compare on that window
    got = {(s.time - 300, s.direction) for s in eng.signals if s.tier == "A_PLUS"}
    t_min = min(t for t, _ in got)
    want = {w for w in want if w[0] >= t_min}
    # the runtime suppresses a new record while the same direction x tier is still open
    assert got <= want and len(got) >= 0.6 * len(want)


def test_backtest_closes_records_and_reports(bt):
    res, led = bt
    assert res["closed"], "no closed records"
    assert led.count("backtest") == len(res["closed"])
    rep = report("5m", res["closed"])
    assert set(rep["by_tier"]) <= {"A_PLUS", "STRUCTURAL", "TRAP"}
    for rec in res["closed"]:
        assert rec.outcome in ("tp1", "sl", "sl_same_bar", "timeout")
        assert rec.r_net is not None and rec.r_net <= rec.r_gross


def test_frame_is_json_and_compact(bt):
    res, _ = bt
    fr = res["engine"].frame()
    s = json.dumps(fr, default=str)
    assert fr["ready"] and "structure" in fr and "context" in fr
    assert len(s) < 40_000, len(s)
    for sig in fr["latest"]:
        assert sig["probability"]["status"] in ("measured", "warmup")
        assert sig["plan"]["qty"] >= 0.001
    assert all("prob_status" in b for b in fr["signals"])


def test_no_lookahead_signals_identical_when_truncated(data):
    five, one, four = data
    a = run_backtest("5m", five[:3000], one, four, None, flow_mode="pine")["engine"]
    b = run_backtest("5m", five[:3001], one, four, None, flow_mode="pine")["engine"]
    cut = five[2999].t + 300
    sa = [(s.id, s.score) for s in a.signals]
    sb_all = [s for s in b.signals if s.time <= cut]
    start = max(a.signals[0].time, sb_all[0].time)  # deque(maxlen) windows differ at the old end
    sa = [(s.id, s.score) for s in a.signals if s.time >= start]
    sb = [(s.id, s.score) for s in sb_all if s.time >= start]
    assert sa == sb and len(sa) > 50


def test_institutional_backtest_profitable_and_high_probability(data, tmp_path_factory):
    five, one, four = data
    led = Ledger(str(tmp_path_factory.mktemp("inst") / "inst.db"))
    res = run_backtest("5m", five, one, four, led, flow_mode="taker")
    rep = report("5m", res["closed"])
    aplus = rep["by_tier"]["A_PLUS"]
    struct = rep["by_tier"]["STRUCTURAL"]
    assert aplus["n"] >= 30
    assert aplus["win_rate"] >= 0.72
    assert aplus["expectancy_r"] >= 0.20
    assert aplus["profit_factor"] >= 1.80
    assert struct["expectancy_r"] > 0.05
    # Verify walk-forward stability across both halves of closed A_PLUS trades
    aplus_recs = [r for r in res["closed"] if r.tier == "A_PLUS"]
    mid = len(aplus_recs) // 2
    h1 = compute_stat(aplus_recs[:mid])
    h2 = compute_stat(aplus_recs[mid:])
    assert h1.expectancy_r > 0.10
    assert h2.expectancy_r > 0.10
