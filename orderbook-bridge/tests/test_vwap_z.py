"""Unit tests for the VWAP Z-Score engine (Cornish-Fisher adjusted)."""

import math

from analytics.vwap_z import VwapZEngine


_MIN = 60_000  # one-minute bars


def _feed(engine, bars):
    """bars: list of (high, low, close, volume). t auto-increments by 1 minute."""
    t = 1_700_000_000_000
    st = None
    for i, (h, l, c, v) in enumerate(bars):
        st = engine.update(t + i * _MIN, h, l, c, v)
    return st


def test_vwap_equals_price_when_flat():
    eng = VwapZEngine(z_window=5, atr_len=3, cf_window=5)
    # Perfectly flat price → VWAP == price, residual 0.
    st = _feed(eng, [(100.0, 100.0, 100.0, 10.0)] * 8)
    assert st.vwap is not None
    assert abs(st.vwap - 100.0) < 1e-9


def test_vwap_is_volume_weighted():
    eng = VwapZEngine(z_window=50, atr_len=3, cf_window=50)
    # Two bars, second has 3x the volume at a higher price → VWAP pulled toward it.
    t = 1_700_000_000_000
    eng.update(t, 100.0, 100.0, 100.0, 1.0)       # hlc3 = 100, v = 1
    st = eng.update(t + _MIN, 110.0, 110.0, 110.0, 3.0)  # hlc3 = 110, v = 3
    # VWAP = (100*1 + 110*3) / (1+3) = 107.5
    assert abs(st.vwap - 107.5) < 1e-9


def test_z_none_until_window_full():
    eng = VwapZEngine(z_window=10, atr_len=3, cf_window=10)
    st = _feed(eng, [(100.0 + i, 99.0 + i, 100.0 + i, 5.0) for i in range(5)])
    # Fewer bars than z_window → VWAP valid, z not yet.
    assert st.vwap is not None
    assert st.z is None


def test_z_sign_tracks_price_above_below_vwap():
    eng = VwapZEngine(z_window=10, atr_len=3, cf_window=10, use_cf=False)
    # Build a stable VWAP band around ~100, then push a bar well above it.
    bars = [(100.0, 100.0, 100.0, 10.0)] * 15
    _feed(eng, bars)
    t = 1_700_000_000_000 + 100 * _MIN
    st = eng.update(t, 130.0, 130.0, 130.0, 10.0)
    # Price above VWAP → positive z.
    assert st.z is not None and st.z > 0


def test_z_is_clamped_to_five():
    # OSC f_clampZ clamps every z to ±5.0 (parity with OSC-vip-v7-4-lite.pine:256).
    # The clamp *constant* is the parity-critical fact; assert it directly plus the
    # ceiling invariant over an extreme input (VWAP chases price, so z rarely
    # saturates through the public API — the hard bound is what matters).
    from analytics.vwap_z import _Z_CLAMP
    assert _Z_CLAMP == 5.0
    eng = VwapZEngine(z_window=10, atr_len=3, cf_window=10, use_cf=False)
    _feed(eng, [(100.0, 100.0, 100.0, 10.0)] * 15)
    t = 1_700_000_000_000 + 100 * _MIN
    st = eng.update(t, 100_000.0, 100_000.0, 100_000.0, 10.0)
    assert st.z is not None and -5.0 - 1e-9 <= st.z <= 5.0 + 1e-9


def test_sigma_floored_by_atr():
    # Flat residual → raw stdev ~0, but ATR>0 so sigma must be floored, not zero.
    eng = VwapZEngine(z_window=5, atr_len=3, cf_window=5, sigma_floor_atr=0.20)
    # Non-flat OHLC gives ATR>0 while keeping hlc3 moving smoothly.
    bars = [(101.0 + i, 99.0 + i, 100.0 + i, 10.0) for i in range(10)]
    st = _feed(eng, bars)
    assert st.sigma is not None and st.sigma > 0.0


def test_bands_straddle_vwap():
    eng = VwapZEngine(z_window=10, atr_len=3, cf_window=10)
    bars = [(101.0 + i, 99.0 + i, 100.0 + i, 10.0) for i in range(15)]
    st = _feed(eng, bars)
    assert st.upper1 is not None and st.lower1 is not None
    assert st.lower1 < st.vwap < st.upper1
    # Fib zone edges widen outward: inner (1.618σ) inside outer (2.618σ).
    assert st.fib_lower2 <= st.fib_lower1 < st.vwap < st.fib_upper1 <= st.fib_upper2


def test_vwap_reanchors_on_new_session():
    eng = VwapZEngine(z_window=50, atr_len=3, cf_window=50)
    day0 = 1_700_000_000_000
    day1 = (day0 // 86_400_000) * 86_400_000 + 86_400_000
    eng.update(day0, 200.0, 200.0, 200.0, 100.0)  # heavy volume at 200
    st = eng.update(day1, 300.0, 300.0, 300.0, 1.0)  # new session, light volume
    # After re-anchor the VWAP must reflect only the new session's single bar (300),
    # not a blend with yesterday's 200.
    assert abs(st.vwap - 300.0) < 1e-9


def test_to_dict_shape():
    eng = VwapZEngine(z_window=10, atr_len=3, cf_window=10)
    _feed(eng, [(101.0 + i, 99.0 + i, 100.0 + i, 10.0) for i in range(15)])
    d = eng.to_dict()
    assert "vwap_z" in d
    for k in ("vwap", "z", "rawZ", "sigma", "sigmaAdj", "cfValid", "upper1", "lower1", "fibUpper1", "fibUpper2", "fibLower1", "fibLower2"):
        assert k in d["vwap_z"]


def test_cf_valid_flag_is_bool_and_values_finite():
    eng = VwapZEngine(z_window=20, atr_len=3, cf_window=20, use_cf=True)
    # Asymmetric moves to create skew/kurtosis in the residual.
    bars = []
    for i in range(40):
        jump = 5.0 if i % 7 == 0 else 0.5
        base = 100.0 + i * 0.2
        bars.append((base + jump, base - 0.2, base + jump * 0.5, 10.0))
    st = _feed(eng, bars)
    assert isinstance(st.cf_valid, bool)
    assert st.z is not None and math.isfinite(st.z)
    assert st.sigma_adj is not None and math.isfinite(st.sigma_adj)


def test_cf_band_scale_falls_back_to_raw_not_crushed():
    # Adversarial HIGH regression: when the CF expansion at z_p=1.0 goes
    # non-positive (high-kurtosis flash regime), the band multiplier must fall
    # back to RAW sigma (1.0), NOT crush the bands to a 0.1 floor.
    # kurt high + skew 0 → scale = 1 + 0 + (1-3)*(kurt-3)/24 - 0 → negative for kurt≳15.
    scale = VwapZEngine._cf_quantile_scale(skew=0.0, kurt=30.0)
    assert scale == 1.0, f"expected raw-sigma fallback 1.0, got {scale}"
    # A benign (near-Gaussian) regime still scales normally (not forced to 1.0).
    mild = VwapZEngine._cf_quantile_scale(skew=0.1, kurt=3.2)
    assert mild > 0.0


def test_cf_band_scale_positive_regime_preserved():
    # A positive CF scale must pass through unchanged (no spurious flooring).
    scale = VwapZEngine._cf_quantile_scale(skew=0.3, kurt=4.0)
    expected = VwapZEngine._cf_poly(1.0, 0.3, 4.0)
    assert expected > 0.0
    assert abs(scale - expected) < 1e-12


def test_to_dict_drops_non_finite():
    # Hardened r(): a stray inf/NaN must serialize as None, never reach the frame.
    from analytics.vwap_z import VwapZState
    st = VwapZState(
        vwap=float("inf"), z=float("nan"), raw_z=1.0, sigma=2.0, sigma_adj=3.0,
        cf_valid=True, upper1=float("-inf"), lower1=10.0,
        fib_upper1=11.0, fib_upper2=12.0, fib_lower1=9.0, fib_lower2=8.0,
    )
    d = st.to_dict()
    assert d["vwap"] is None and d["z"] is None and d["upper1"] is None
    assert d["rawZ"] == 1.0 and d["lower1"] == 10.0
