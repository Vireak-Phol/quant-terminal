from datetime import datetime, timezone

from engine.pine import ATR, EMA, SMA, Correlation, Pivot, Stdev, wilson_interval
from engine.sessions import KillzoneConfig, parse_session, session_flags
from engine.osc_engine import BarInput, OscEngine


def ts(y, m, d, hh, mm):
    return int(datetime(y, m, d, hh, mm, tzinfo=timezone.utc).timestamp())


def test_sma_stdev_population():
    s, sd = SMA(3), Stdev(3)
    for x in (1.0, 2.0, 3.0):
        a, b = s.update(x), sd.update(x)
    assert a == 2.0
    assert abs(b - (2 / 3) ** 0.5) < 1e-12


def test_ema_seeded_with_sma():
    e = EMA(3)
    assert e.update(1.0) is None and e.update(2.0) is None
    assert e.update(3.0) == 2.0
    assert abs(e.update(4.0) - (0.5 * 4 + 0.5 * 2)) < 1e-12


def test_atr_wilder():
    a = ATR(2)
    assert a.update(10, 8, 9) is None  # tr=2
    assert a.update(11, 9, 10) == 2.0  # tr=2 -> seed sma(2,2)
    assert a.update(14, 10, 13) == 0.5 * 4 + 0.5 * 2


def test_correlation_perfect():
    c = Correlation(5)
    r = None
    for i in range(5):
        r = c.update(float(i), 2.0 * i + 1)
    assert abs(r - 1.0) < 1e-9


def test_pivot_tie_rules():
    p = Pivot(2, 2, True)
    out = [p.update(x) for x in (1, 5, 5, 3, 2)]  # centre 5 ties with left 5 -> pivot
    assert out[-1] == 5
    p = Pivot(2, 2, True)
    out = [p.update(x) for x in (1, 2, 5, 5, 2)]  # centre ties with right -> not a pivot
    assert out[-1] is None


def test_wilson_matches_reference():
    lo, hi = wilson_interval(60, 100)
    assert abs(lo - 50.20) < 0.05 and abs(hi - 69.06) < 0.05


def test_session_boundaries_and_dst():
    cfg = KillzoneConfig()
    assert parse_session("2000-0000") == (1200, 1440)
    # NY AM 08:30 EDT (summer) = 12:30 UTC; 08:30 EST (winter) = 13:30 UTC
    assert session_flags(ts(2026, 7, 1, 12, 30), cfg).ny_am
    assert not session_flags(ts(2026, 7, 1, 12, 25), cfg).ny_am
    assert session_flags(ts(2026, 12, 1, 13, 30), cfg).ny_am
    assert not session_flags(ts(2026, 12, 1, 12, 30), cfg).ny_am
    # London 02:00-05:00 NY; 05:00 itself is outside
    assert not session_flags(ts(2026, 12, 1, 10, 0), cfg).london
    assert session_flags(ts(2026, 12, 1, 9, 55), cfg).london
    # Asia 20:00-24:00 NY
    assert session_flags(ts(2026, 12, 2, 4, 55), cfg).asia
    assert not session_flags(ts(2026, 12, 2, 5, 0), cfg).asia


def test_engine_no_lookahead():
    """Values for bar N must not change when bar N+1 is appended."""
    import random
    random.seed(7)
    bars = []
    p = 4000.0
    for i in range(260):
        o = p
        p += random.gauss(0, 1.5)
        h = max(o, p) + abs(random.gauss(0, 0.7))
        l = min(o, p) - abs(random.gauss(0, 0.7))
        bars.append(BarInput(t=1_700_000_000 + i * 300, o=o, h=h, l=l, c=p, v=100 + random.random() * 50,
                             ltf_flows=[random.gauss(0, 10) for _ in range(5)]))
    e1, e2 = OscEngine(), OscEngine()
    out1 = [e1.update(b) for b in bars[:-1]]
    out2 = [e2.update(b) for b in bars]
    for a, b in zip(out1, out2[:-1]):
        assert a.long_prob == b.long_prob and a.short_prob == b.short_prob and a.vwap_z == b.vwap_z
