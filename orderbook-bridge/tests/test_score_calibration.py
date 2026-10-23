"""Regression: the displayed probability must NOT be stratified by the model score.

A reliability study (tests/validate_score_reliability.py) measured the institutional
model score as anti-correlated with realised outcome. The calibrator must therefore
calibrate at setup x tier (then tier), never at score_bin — otherwise the headline
"measured probability" would be read from a bin selected by a misleading score.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.dirname(HERE)
for p in (BRIDGE, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

from engine.calibration import Calibrator


def test_score_bin_is_not_a_calibration_level():
    keys = Calibrator.keys("5m", "FVG_Bear", "A_PLUS", sbin=95)
    levels = [lvl for lvl, _ in keys]
    assert "setup_tier_bin" not in levels, "score_bin must not drive calibration (score is non-predictive)"
    assert levels == ["setup_tier", "tier"]
    # every remaining key must be score-independent (length 3 or 2, no bin component)
    for _, k in keys:
        assert len(k) in (2, 3)
        assert "95" not in k, "a score-bin component leaked into a calibration key"


def test_estimate_bucket_label_is_score_independent():
    """When enough samples exist, the reported bucket must be setup|tier, not include a score bin."""
    from engine.ledger import Ledger, SignalRecord

    cal = Calibrator(None, min_samples=3)
    # three closed A_PLUS FVG_Bear trades at DIFFERENT scores must land in the SAME bucket
    for i, sc in enumerate((77.0, 90.0, 97.0)):
        rec = SignalRecord(
            id=f"t{i}", source="backtest", symbol="XAUUSDT", tf="5m", setup="FVG_Bear",
            direction="SHORT", tier="A_PLUS", score=sc, entry_time=1000 + i, entry=100.0,
            stop=102.0, tp1=96.0, tp2=94.0, cost_r=0.1, horizon=20, status="closed",
            outcome="tp1", win=True, r_gross=2.0, r_net=1.9,
        )
        cal.add(rec)
    est = cal.estimate("5m", "FVG_Bear", "A_PLUS", 97.0)
    assert est.status == "measured"
    assert est.level == "setup_tier"
    assert est.stat.n == 3, "all three scores must aggregate into one setup_tier bucket"
