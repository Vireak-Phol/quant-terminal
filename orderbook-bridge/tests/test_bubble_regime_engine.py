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


def test_flush_if_stale():
    eng = BubbleRegimeEngine(sweep_coalesce_ms=12, min_bubble_qty=20.0)
    # Trade starts at 1000ms
    eng.process_trade(price=4100.0, qty=30.0, aggressor_side="buy", timestamp_ms=1000)
    # At 1005ms (5ms elapsed, <= 12ms coalesce): should NOT flush
    assert eng.flush_if_stale(1005) is None
    # At 1015ms (15ms elapsed, > 12ms coalesce): should flush and emit
    sig = eng.flush_if_stale(1015)
    assert sig is not None
    assert sig.total_qty == 30.0
    assert sig.aggressor_side == "buy"
    # Subsequent call with empty buffer: returns None
    assert eng.flush_if_stale(1020) is None


def test_has_pending_sweep_quiet_vs_active():
    eng = BubbleRegimeEngine(sweep_coalesce_ms=12, min_bubble_qty=20.0)
    # No active sweep yet.
    assert eng.has_pending_sweep(1000) is False
    eng.process_trade(price=4100.0, qty=30.0, aggressor_side="buy", timestamp_ms=1000)
    # Still inside the coalesce window → not yet pending.
    assert eng.has_pending_sweep(1008) is False
    # Gone quiet past the window → a trailing sweep is pending for real-time flush.
    assert eng.has_pending_sweep(1015) is True


def test_real_time_flush_without_next_trade():
    """Audit #4: a trailing absorption must ship without waiting for a new trade."""
    eng = BubbleRegimeEngine(sweep_coalesce_ms=12, min_bubble_qty=20.0)
    eng.update_open_interest(12_500.0)
    eng.update_open_interest(12_540.0)
    # Institutional absorption: three tight fills, then the tape goes silent.
    for i, q in enumerate([18.0, 20.0, 17.0]):
        eng.process_trade(price=4140.0, qty=q, aggressor_side="sell", timestamp_ms=1000 + i * 3)
    # Before the flush the bubble is trapped in the accumulator — UI would be empty.
    assert eng.to_dict()["bubbles"] == []
    # Broadcast loop detects the quiet sweep and flushes it in real time.
    flushed = eng.flush_if_stale(1050)
    assert flushed is not None
    assert flushed.regime == REGIME_INSTITUTIONAL_ABSORPTION_OPEN
    assert len(eng.to_dict()["bubbles"]) == 1


def test_rev_counter_monotonic_on_emit():
    """The UI keys its sweep-feed re-render off `bubblesRev`; it must advance once
    per emitted signal and never on sub-threshold / no-op flushes (Audit #1)."""
    eng = BubbleRegimeEngine(sweep_coalesce_ms=12, min_bubble_qty=20.0)
    assert eng.rev == 0
    assert eng.to_dict()["bubblesRev"] == 0
    # Sub-threshold sweep: no emit, rev unchanged.
    eng.process_trade(price=4100.0, qty=5.0, aggressor_side="buy", timestamp_ms=1000)
    assert eng.flush_if_stale(1050) is None
    assert eng.rev == 0
    # First qualifying sweep → rev 1.
    eng.process_trade(price=4100.0, qty=30.0, aggressor_side="buy", timestamp_ms=2000)
    assert eng.flush_if_stale(2050) is not None
    assert eng.rev == 1
    assert eng.to_dict()["bubblesRev"] == 1
    # Second qualifying sweep → rev 2 (monotonic).
    eng.process_trade(price=4101.0, qty=40.0, aggressor_side="sell", timestamp_ms=3000)
    assert eng.flush_if_stale(3050) is not None
    assert eng.rev == 2
    # No pending sweep → flush is a no-op, rev stays at 2.
    assert eng.flush_if_stale(4000) is None
    assert eng.rev == 2

