import math

import pytest

from engine.calibration import Calibrator, compute_stat
from engine.ledger import Ledger, SignalRecord, score_bin
from engine.orderflow import OrderflowSnapshot, orderflow_evidence
from engine.risk import RiskConfig, build_plan
from engine.runtime import guardrails


# ── risk ────────────────────────────────────────────────────────────────────
def test_plan_session_sigma_and_sizing():
    cfg = RiskConfig()
    p = build_plan("LONG", 4000.0, session_vol=2.0, atr=3.0, cfg=cfg)
    assert p.stop == 4000.0 - 3.0 and p.tp1 == 4004.0 and p.tp2 == 4007.0
    assert p.stop_basis == "session_sigma"
    cost = 4000 * 0.0005 * 2 + 0.01
    expected_qty = math.floor(1.0 / (3.0 + cost) / 0.001 + 1e-9) * 0.001
    assert abs(p.qty - expected_qty) < 1e-9
    assert p.risk_usd <= 1.0 + 1e-9
    assert abs(p.cost_r - cost / 3.0) < 1e-4


def test_plan_risk_floor_and_short_side():
    p = build_plan("SHORT", 4000.0, session_vol=0.2, atr=3.0, cfg=RiskConfig())
    assert p.stop == 4001.5  # floor 0.5 ATR beats 1.5 * 0.2
    assert p.tp1 < 4000.0 < p.stop


def test_plan_wall_anchor_moves_stop_behind_wall():
    walls = [{"side": "bid", "price": 3996.8, "size": 50, "multiple": 4.0}]
    p = build_plan("LONG", 4000.0, session_vol=2.0, atr=3.0, cfg=RiskConfig(), walls=walls)
    assert p.stop_basis == "wall" and p.wall_price == 3996.8
    assert p.stop == round(3996.8 - 0.05, 2)


def test_plan_ignores_wrong_side_wall():
    walls = [{"side": "ask", "price": 3998.0, "size": 50, "multiple": 4.0}]
    p = build_plan("LONG", 4000.0, session_vol=2.0, atr=3.0, cfg=RiskConfig(), walls=walls)
    assert p.stop_basis == "session_sigma"


def test_plan_leverage_cap_and_oversize():
    cfg = RiskConfig(account_equity=100, risk_pct=5.0)
    p = build_plan("LONG", 4000.0, session_vol=0.5, atr=1.0, cfg=cfg)
    assert "leverage_capped" in p.flags and p.notional <= 100 * 10 + 1e-6
    tiny = RiskConfig(account_equity=10, risk_pct=0.1)
    p2 = build_plan("LONG", 4000.0, session_vol=20.0, atr=20.0, cfg=tiny)
    assert p2.qty == 0.001 and "oversize" in p2.flags


def test_risk_config_validation_roundtrip(tmp_path):
    with pytest.raises(ValueError):
        RiskConfig.from_dict({"risk_pct": 0})
    path = tmp_path / "config.json"
    RiskConfig(account_equity=250).save(str(path))
    assert RiskConfig.load(str(path)).account_equity == 250


# ── ledger resolution ───────────────────────────────────────────────────────
def _rec(direction="LONG", entry=100.0, stop=99.0, tp1=102.0, horizon=3, cost_r=0.1, **kw):
    return SignalRecord(id=kw.get("id", "x"), source=kw.get("source", "backtest"), symbol="XAUUSDT", tf="5m",
                        setup=kw.get("setup", "FVG_Bull"), direction=direction, tier=kw.get("tier", "A_PLUS"),
                        score=kw.get("score", 67.0), entry_time=kw.get("t", 0), entry=entry, stop=stop, tp1=tp1,
                        tp2=tp1 + 1, cost_r=cost_r, horizon=horizon)


def test_resolution_tp_sl_same_bar_and_timeout():
    r = _rec()
    assert r.step(1, 102.5, 99.5, 101) and r.outcome == "tp1" and r.win and r.r_net == pytest.approx(1.9)
    r = _rec()
    assert r.step(1, 102.5, 98.5, 101) and r.outcome == "sl_same_bar" and not r.win and r.r_net == pytest.approx(-1.1)
    r = _rec(horizon=2)
    assert not r.step(1, 100.5, 99.5, 100.4)
    assert r.step(2, 100.6, 99.6, 100.5) and r.outcome == "timeout" and r.r_net == pytest.approx(0.4) and r.win
    s = _rec(direction="SHORT", entry=100, stop=101, tp1=98)
    assert s.step(1, 101.2, 99.0, 100) and s.outcome == "sl"


def test_timeout_win_requires_positive_net():
    r = _rec(horizon=1, cost_r=0.2)
    r.step(1, 100.2, 99.9, 100.1)  # gross +0.1R, net -0.1R
    assert r.outcome == "timeout" and not r.win


def test_ledger_persistence_roundtrip(tmp_path):
    db = str(tmp_path / "l.db")
    led = Ledger(db)
    led.add(_rec(id="a", source="live"))
    led2 = Ledger(db)
    assert "a" in led2.open
    closed = led2.on_bar("5m", 10, 103, 99.5, 102)
    assert closed and closed[0].win
    assert Ledger(db).closed()[0].outcome == "tp1"


# ── calibration ─────────────────────────────────────────────────────────────
def test_compute_stat_beta_and_wilson():
    recs = []
    for i in range(20):
        r = _rec(id=str(i))
        r.step(1, 102.5, 99.5, 101) if i < 12 else r.step(1, 100, 98, 99)
        recs.append(r)
    s = compute_stat(recs)
    assert s.n == 20 and s.wins == 12
    assert s.win_rate == pytest.approx((12 + 2) / 24 * 100, abs=0.01)
    assert 38 < s.ci_lo < 40 and 77 < s.ci_hi < 79


def test_calibrator_warmup_then_measured_and_fallback():
    cal = Calibrator(None, min_samples=15)
    est = cal.estimate("5m", "FVG_Bull", "A_PLUS", 67)
    assert est.status == "warmup" and est.stat is None
    for i in range(10):
        r = _rec(id=f"a{i}", score=67)
        r.step(1, 102.5, 99.5, 101)
        cal.add(r)
    est = cal.estimate("5m", "FVG_Bull", "A_PLUS", 67)
    assert est.status == "warmup" and est.stat.n == 10
    for i in range(10):
        r = _rec(id=f"b{i}", score=72)  # different bin, same setup x tier
        r.step(1, 100, 98, 99)
        cal.add(r)
    est = cal.estimate("5m", "FVG_Bull", "A_PLUS", 67)
    assert est.status == "measured" and est.level == "setup_tier" and est.stat.n == 20
    assert est.source == "backtest"


def test_calibrator_prefers_live_when_enough():
    cal = Calibrator(None, min_samples=3)
    for i in range(5):
        r = _rec(id=f"bt{i}")
        r.step(1, 100, 98, 99)
        cal.add(r)
    for i in range(3):
        r = _rec(id=f"lv{i}", source="live")
        r.step(1, 102.5, 99.5, 101)
        cal.add(r)
    est = cal.estimate("5m", "FVG_Bull", "A_PLUS", 67)
    assert est.source == "live" and est.stat.wins == 3 and est.backtest.wins == 0


def test_score_bin():
    assert score_bin(67.9) == 65 and score_bin(100) == 95 and score_bin(-1) == 0


# ── order-flow evidence ─────────────────────────────────────────────────────
def test_orderflow_tags():
    snap = OrderflowSnapshot(mid=4000.0, imbalance=0.3, timestamp_ms=1000,
                             walls=[{"side": "bid", "price": 3999.0, "size": 40, "multiple": 3.0},
                                    {"side": "ask", "price": 4000.5, "size": 40, "multiple": 3.0}],
                             absorptions=[{"side": "sell", "confidence": 0.8, "timestamp": 900, "price": "3999.1"}])
    ev = orderflow_evidence("LONG", snap, atr=3.0)
    assert set(ev.tags) == {"of_wall_support", "of_wall_against", "of_absorption", "of_imbalance_with"}
    ev = orderflow_evidence("SHORT", snap, atr=3.0)
    assert "of_imbalance_against" in ev.tags and "of_absorption" not in ev.tags
    assert orderflow_evidence("LONG", None, 3.0).tags == []


# ── guardrails ──────────────────────────────────────────────────────────────
def test_guardrails_soft_warnings(tmp_path):
    led = Ledger(str(tmp_path / "g.db"))
    now = 1_800_000_000
    for i in range(3):
        r = _rec(id=f"g{i}", source="live", t=now - 600 * (i + 1))
        r.step(now - 600 * i, 100, 98, 99)
        led.add(r, track=False)
    g = guardrails(led, RiskConfig(), now=now)
    codes = {w["code"] for w in g["warnings"]}
    assert g["consecutive_losses"] == 3 and "loss_streak" in codes and "daily_loss" in codes
