"""Unit tests for the trade-price candle aggregator (OHLCV + delta + CVD)."""

from analytics.trade_candles import TradeCandleAggregator


def _buy(px, q, t):
    return ("buy", px, q, t)


def _sell(px, q, t):
    return ("sell", px, q, t)


def test_first_trade_opens_forming_bucket_no_close():
    agg = TradeCandleAggregator(60_000)
    out = agg.ingest(price=2000.0, qty=1.0, aggressor_side="buy", ts_ms=1_700_000_000_500)
    assert out is None
    f = agg.forming()
    assert f is not None and f.o == f.h == f.l == f.c == 2000.0
    assert f.volume == 1.0 and f.buy_volume == 1.0 and f.sell_volume == 0.0
    assert f.delta == 1.0 and not f.closed


def test_bucket_rolls_emit_closed_candle_with_delta():
    agg = TradeCandleAggregator(60_000)
    t0 = 1_700_000_000_000
    # minute bucket 0
    agg.ingest(2000.0, 2.0, "buy", t0 + 100)
    agg.ingest(2000.5, 1.0, "buy", t0 + 200)
    agg.ingest(1999.5, 3.0, "sell", t0 + 300)
    # first trade of the next minute -> closes bucket 0
    closed = agg.ingest(2001.0, 0.5, "buy", t0 + 60_001)
    assert closed is not None and closed.closed
    assert closed.o == 2000.0 and closed.h == 2000.5 and closed.l == 1999.5 and closed.c == 1999.5
    assert abs(closed.volume - 6.0) < 1e-9
    assert abs(closed.buy_volume - 3.0) < 1e-9
    assert abs(closed.sell_volume - 3.0) < 1e-9
    assert abs(closed.delta - 0.0) < 1e-9


def test_cvd_running_sum_and_sign():
    agg = TradeCandleAggregator(60_000)
    t0 = 1_700_000_000_000
    agg.ingest(2000.0, 5.0, "buy", t0)
    assert agg.cvd() == 5.0
    agg.ingest(2000.0, 2.0, "sell", t0 + 100)
    assert agg.cvd() == 3.0
    agg.ingest(2000.0, 10.0, "sell", t0 + 200)
    assert agg.cvd() == -7.0


def test_cvd_resets_at_utc_midnight():
    agg = TradeCandleAggregator(60_000)
    day0 = 1_700_000_000_000            # arbitrary point in day A
    day1 = day0 + 86_400_000            # same time next UTC day
    agg.ingest(2000.0, 5.0, "buy", day0)
    assert agg.cvd() == 5.0
    # first trade of the next day resets CVD BEFORE applying the new trade
    agg.ingest(2001.0, 1.5, "buy", day1)
    assert abs(agg.cvd() - 1.5) < 1e-9
    # and a sell then drives it negative within the new session
    agg.ingest(2001.0, 4.0, "sell", day1 + 100)
    assert abs(agg.cvd() - (-2.5)) < 1e-9


def test_forming_bucket_updates_high_low_close():
    agg = TradeCandleAggregator(60_000)
    t0 = 1_700_000_000_000
    agg.ingest(2000.0, 1.0, "buy", t0)
    agg.ingest(2002.0, 1.0, "buy", t0 + 10)
    agg.ingest(1998.0, 1.0, "sell", t0 + 20)
    agg.ingest(2001.0, 1.0, "buy", t0 + 30)
    f = agg.forming()
    assert f.h == 2002.0 and f.l == 1998.0 and f.c == 2001.0
    assert f.volume == 4.0


def test_out_of_order_trade_does_not_close_bar():
    """A late trade (bucket < current) must NOT roll the bar or emit a candle.
    Its volume/delta fold into the current forming bucket instead. (Audit #6)"""
    agg = TradeCandleAggregator(60_000)
    t0 = 1_700_000_000_000
    # Open bucket 1 (next minute) directly.
    agg.ingest(2000.0, 2.0, "buy", t0 + 60_000)
    forming_before = agg.forming()
    assert forming_before.volume == 2.0
    # A trade from the PREVIOUS minute arrives late (network jitter).
    late = agg.ingest(1999.0, 1.0, "sell", t0 + 100)
    assert late is None, "late out-of-order trade must not emit a closed candle"
    f = agg.forming()
    # Still the same bucket; volume folded, low extended, close unchanged.
    assert f.t == ((t0 + 60_000) // 60_000) * 60_000
    assert abs(f.volume - 3.0) < 1e-9
    assert f.l == 1999.0
    assert f.c == 2000.0  # late tick does not move the close
    assert abs(f.sell_volume - 1.0) < 1e-9


def test_to_dict_shape_and_rounding():
    agg = TradeCandleAggregator(60_000)
    t0 = 1_700_000_000_000
    agg.ingest(2000.1234, 1.23456, "buy", t0)
    d = agg.forming().to_dict()
    assert set(d.keys()) == {"t", "o", "h", "l", "c", "v", "d", "bv", "sv", "closed"}
    assert d["o"] == 2000.12 and d["v"] == 1.235 and d["d"] == 1.235
    assert d["closed"] is False
