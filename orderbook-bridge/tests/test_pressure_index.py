"""Unit tests for the Smart-Money Pressure Index (SMPI) engine."""

import math

from analytics.pressure_index import PressureIndexEngine


def _feed(engine, rows):
    """rows: list of (cvd, open_, close, absorption)."""
    st = None
    for cvd, o, c, ab in rows:
        st = engine.update(cvd, o, c, ab)
    return st


def test_none_until_slope_and_zwindow_ready():
    eng = PressureIndexEngine(z_window=10, cvd_lookback=3, ema_len=3, snr_window=5)
    # Fewer bars than cvd_lookback → slope None → smpi None.
    st = eng.update(cvd=1.0, open_=100.0, close=101.0, absorption=False)
    assert st.smpi is None
    assert st.slope is None


def test_rising_cvd_with_green_bar_is_positive_pressure():
    eng = PressureIndexEngine(z_window=5, cvd_lookback=3, ema_len=3, snr_window=5)
    # Steadily rising CVD (buy-side accumulation) with up-closing bars → +pressure.
    rows = [(float(i * 10), 100.0, 101.0, False) for i in range(1, 30)]
    st = _feed(eng, rows)
    assert st.smpi is not None and st.smpi > 0


def test_falling_cvd_with_red_bar_is_negative_pressure():
    eng = PressureIndexEngine(z_window=5, cvd_lookback=3, ema_len=3, snr_window=5)
    rows = [(float(-i * 10), 101.0, 100.0, False) for i in range(1, 30)]
    st = _feed(eng, rows)
    assert st.smpi is not None and st.smpi < 0


def test_smpi_clamped_to_three():
    eng = PressureIndexEngine(z_window=5, cvd_lookback=3, ema_len=3, snr_window=5)
    # Explosive CVD acceleration + absorption + green bars → saturate the clamp.
    rows = [(float(i * i * 100), 100.0, 110.0, True) for i in range(1, 40)]
    st = _feed(eng, rows)
    assert st.smpi is not None and st.smpi <= 3.0 + 1e-9


def test_absorption_kicker_sign_follows_flow():
    # With a positive flow slope, absorption should push pressure MORE positive than
    # the identical sequence without absorption.
    base_rows = [(float(i * 10), 100.0, 101.0, False) for i in range(1, 30)]
    with_abs = [(cvd, o, c, True) for (cvd, o, c, _ab) in base_rows]

    eng_no = PressureIndexEngine(z_window=5, cvd_lookback=3, ema_len=3, snr_window=5)
    eng_ab = PressureIndexEngine(z_window=5, cvd_lookback=3, ema_len=3, snr_window=5)
    st_no = _feed(eng_no, base_rows)
    st_ab = _feed(eng_ab, with_abs)
    assert st_ab.smpi is not None and st_no.smpi is not None
    assert st_ab.smpi >= st_no.smpi


def test_snr_non_negative_and_finite():
    eng = PressureIndexEngine(z_window=5, cvd_lookback=3, ema_len=3, snr_window=5)
    rows = [(float(i * 7), 100.0, 101.0 if i % 2 else 99.0, False) for i in range(1, 40)]
    st = _feed(eng, rows)
    assert st.snr is not None and st.snr >= 0.0 and math.isfinite(st.snr)


def test_slope_matches_cvd_lookback():
    eng = PressureIndexEngine(z_window=50, cvd_lookback=3, ema_len=3, snr_window=5)
    # Feed a known CVD sequence; slope on bar n = cvd[n] - cvd[n-3].
    cvds = [0.0, 1.0, 2.0, 3.0, 10.0]  # bar 4 slope should be 10 - 1 = 9
    st = None
    for i, cvd in enumerate(cvds):
        st = eng.update(cvd, 100.0, 101.0, False)
    assert abs(st.slope - (10.0 - 1.0)) < 1e-9


def test_to_dict_shape():
    eng = PressureIndexEngine(z_window=5, cvd_lookback=3, ema_len=3, snr_window=5)
    _feed(eng, [(float(i * 10), 100.0, 101.0, False) for i in range(1, 30)])
    d = eng.to_dict()
    assert "pressure_index" in d
    for k in ("smpi", "raw", "slopeZ", "slope", "snr", "absorption"):
        assert k in d["pressure_index"]
