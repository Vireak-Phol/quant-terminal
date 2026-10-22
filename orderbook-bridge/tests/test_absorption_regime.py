"""Tests for regime-normalised absorption thresholds (audit F4)."""

from analytics.absorption_engine import AbsorptionEngine


def _make_engine():
    return AbsorptionEngine(symbol="XAUUSDT", window_duration_ms=4000, min_confidence=0.50)


def _drive_cluster(eng, n_trades=8, side="buy", qty_each=3.0, price=2000.0, start_ms=1_700_000_000_000, step_ms=300):
    """Push a burst of aggressive same-side trades into the window."""
    for i in range(n_trades):
        eng.ingest_trade(
            price=price,
            qty=qty_each,
            aggressor_side=side,
            timestamp_ms=start_ms + i * step_ms,
            resting_zones=[],
        )


def test_default_thresholds_unchanged():
    eng = _make_engine()
    assert eng.effective_min_cluster_vol == 10.0
    assert eng.effective_min_side_vol == 12.0
    assert eng.effective_window_ms == 4000


def test_thin_session_lowers_gates():
    eng = _make_engine()
    # Long-run median is 40 oz. Feed a thin-session median of 20 oz -> ratio 0.5.
    eng.update_session_baseline(40.0)
    eng.update_session_baseline(20.0)
    assert eng.effective_min_cluster_vol < 10.0, (
        f"thin session should LOWER the gate, got {eng.effective_min_cluster_vol}"
    )


def test_fat_session_raises_gates():
    eng = _make_engine()
    eng.update_session_baseline(40.0)
    eng.update_session_baseline(80.0)  # ratio 2.0, clamped to 2.0
    assert eng.effective_min_cluster_vol > 10.0, (
        f"fat session should RAISE the gate, got {eng.effective_min_cluster_vol}"
    )


def test_scale_clamped():
    eng = _make_engine()
    eng.update_session_baseline(40.0)
    eng.update_session_baseline(1.0)   # extreme thin, ratio clamps at 0.5
    assert 5.0 <= eng.effective_min_cluster_vol <= 40.0
    eng2 = _make_engine()
    eng2.update_session_baseline(40.0)
    eng2.update_session_baseline(400.0)  # extreme fat, ratio clamps at 2.0
    assert 5.0 <= eng2.effective_min_cluster_vol <= 40.0


def test_zero_or_negative_baseline_ignored():
    eng = _make_engine()
    eng.update_session_baseline(0.0)
    eng.update_session_baseline(-5.0)
    assert eng.effective_min_cluster_vol == 10.0
