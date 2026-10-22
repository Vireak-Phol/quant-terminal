"""Tests for the OI + liquidation Bubble Regime classifier."""

from analytics.bubble_regime_engine import (
    BubbleRegimeEngine,
    Liquidation,
    REGIME_INSTITUTIONAL_ABSORPTION_OPEN,
    REGIME_LIQUIDATION_EXHAUSTION_FLUSH,
    REGIME_VACUUM_SWEEP_BREAKOUT,
    REGIME_STANDARD_FLOW,
)

BASE = 1_760_000_000_000


def _engine(**kw):
    defaults = dict(sweep_coalesce_ms=15, min_bubble_qty=20.0, absorption_max_ticks=0.30)
    defaults.update(kw)
    return BubbleRegimeEngine(**defaults)


def test_sub_threshold_sweep_emits_nothing():
    eng = _engine()
    # Single 5 oz fill is below min_bubble_qty (20) -> no signal on flush.
    eng.process_trade(price=4140.0, qty=5.0, aggressor_side="sell", timestamp_ms=BASE)
    assert eng.flush_pending() is None
    assert eng.recent_signals() == []


def test_institutional_absorption_open_rising_oi_tight_band():
    eng = _engine()
    # Rising OI: first reading anchors prev=self (delta 0), second lifts it.
    eng.update_open_interest(12_500.0)
    eng.update_open_interest(12_540.0)
    # Three fills all at 4140.00 within the coalesce window -> sweep_ticks = 0.
    for i, q in enumerate([18.0, 20.0, 17.0]):
        eng.process_trade(price=4140.00, qty=q, aggressor_side="sell", timestamp_ms=BASE + i * 3)
    sig = eng.flush_pending()
    assert sig is not None
    assert sig.regime == REGIME_INSTITUTIONAL_ABSORPTION_OPEN
    assert sig.total_qty == 55.0
    assert sig.sweep_ticks == 0.0
    assert sig.oi_delta == 40.0
    assert sig.aggressor_side == "sell"


def test_liquidation_exhaustion_flush_dropping_oi():
    eng = _engine()
    # Dropping OI.
    eng.update_open_interest(12_540.0)
    eng.update_open_interest(12_500.0)
    # A forced SELL liquidation near the sweep start, > 15% of total volume.
    eng.record_liquidation(Liquidation(timestamp_ms=BASE + 10, side="sell", price=4139.0, qty=30.0))
    # Sell sweep of 60 oz over a moderate band (0.5 -> not absorption, not breakout by span).
    for i, (p, q) in enumerate([(4140.0, 20.0), (4139.8, 20.0), (4139.5, 20.0)]):
        eng.process_trade(price=p, qty=q, aggressor_side="sell", timestamp_ms=BASE + i * 3)
    sig = eng.flush_pending()
    assert sig is not None
    assert sig.regime == REGIME_LIQUIDATION_EXHAUSTION_FLUSH
    assert sig.oi_delta == -40.0
    assert sig.liquidation_qty == 30.0


def test_vacuum_sweep_breakout_large_span():
    eng = _engine()
    eng.update_open_interest(12_500.0)
    eng.update_open_interest(12_500.0)  # flat OI
    # Buy sweep ripping 1.50 USD through the book -> breakout.
    for i, (p, q) in enumerate([(4140.0, 20.0), (4140.8, 20.0), (4141.5, 20.0)]):
        eng.process_trade(price=p, qty=q, aggressor_side="buy", timestamp_ms=BASE + i * 3)
    sig = eng.flush_pending()
    assert sig is not None
    assert sig.regime == REGIME_VACUUM_SWEEP_BREAKOUT
    assert sig.sweep_ticks == 1.50


def test_side_flip_emits_previous_sweep():
    eng = _engine()
    eng.update_open_interest(12_500.0)
    eng.update_open_interest(12_500.0)
    # Build a qualifying sell sweep, then a buy trade flips side and flushes it.
    for i, q in enumerate([20.0, 20.0]):
        eng.process_trade(price=4140.0, qty=q, aggressor_side="sell", timestamp_ms=BASE + i * 2)
    emitted = eng.process_trade(price=4141.0, qty=5.0, aggressor_side="buy", timestamp_ms=BASE + 50)
    assert emitted is not None
    assert emitted.aggressor_side == "sell"
    assert emitted.total_qty == 40.0


def test_cvd_signed_accumulation():
    eng = _engine()
    eng.process_trade(price=4140.0, qty=10.0, aggressor_side="buy", timestamp_ms=BASE)
    eng.process_trade(price=4140.0, qty=4.0, aggressor_side="sell", timestamp_ms=BASE + 1)
    assert eng.cvd == 6.0


def test_invalid_side_rejected():
    eng = _engine()
    try:
        eng.process_trade(price=4140.0, qty=1.0, aggressor_side="BID", timestamp_ms=BASE)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for non buy/sell side")


def test_to_dict_is_json_friendly():
    eng = _engine()
    eng.update_open_interest(12_500.0)
    eng.update_open_interest(12_540.0)
    for i, q in enumerate([18.0, 20.0, 17.0]):
        eng.process_trade(price=4140.0, qty=q, aggressor_side="sell", timestamp_ms=BASE + i * 3)
    eng.flush_pending()
    d = eng.to_dict()
    assert d["oi_delta"] == 40.0
    assert len(d["bubbles"]) == 1
    b = d["bubbles"][0]
    assert b["regime"] == REGIME_INSTITUTIONAL_ABSORPTION_OPEN
    assert b["aggressorSide"] == "sell"
    # prices/quantities emitted as strings per repo convention
    assert isinstance(b["priceCenter"], str)
    assert isinstance(b["totalQuantity"], str)
