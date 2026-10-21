"""Bar-for-bar parity of the Python OSC engine against TradingView OSC-VIP v7.4.

Fixture: 6,251 OANDA:XAUUSD 5m bars exported from TradingView Desktop with the OSC/REG
plot values, plus the 1m intrabars, 4H bars, TVC:DXY and TVC:VIX used by the script.

Lower-TF dependent values (SMPI, OFP, signals) can only be compared where our 1m export
covers the chart (``ltf_covered_from``); TradingView had deeper intrabar history than the
export. A 150-bar warm-up after that point lets rolling windows fill with identical data.
The final bar is excluded because it was the still-forming realtime bar at export time.
"""

import pytest

from parity import run_osc_parity


def _f(x):
    return float(x) if x not in ("", None) else None


@pytest.fixture(scope="module")
def run():
    return run_osc_parity()


def _window(run, ltf: bool):
    lo = (run.ltf_covered_from + 150) if ltf else 150
    return list(zip(run.rows, run.out))[lo:-1]


def _max_err(pairs, col, get):
    errs = []
    for r, o in pairs:
        a, b = _f(r[col]), get(o)
        if a is None or b is None:
            continue
        errs.append(abs(a - b))
    assert len(errs) > 500, f"too few comparable bars for {col}"
    return max(errs)


def test_fixture_has_meaningful_ltf_overlap(run):
    assert len(run.rows) - run.ltf_covered_from > 1500


def test_vwap_z_exact_all_bars(run):
    # Pure OHLCV — must match everywhere after warm-up.
    assert _max_err(_window(run, False), "osc_vwapz", lambda o: o.vwap_z) < 1e-6


def test_smpi_exact_with_ltf(run):
    assert _max_err(_window(run, True), "osc_smpi", lambda o: o.smpi) < 1e-6


def test_vacuum_band_exact(run):
    assert _max_err(_window(run, False), "osc_vacband", lambda o: o.vac_band) < 1e-6


FLAG_COLS = [
    ("osc_kz", lambda o: o.active_killzone),
    ("osc_shock_start", lambda o: o.shock_start),
    ("osc_aplus_long", lambda o: o.aplus_bull),
    ("osc_aplus_short", lambda o: o.aplus_bear),
    ("osc_struct_long", lambda o: o.struct_bull),
    ("osc_struct_short", lambda o: o.struct_bear),
    ("osc_trap", lambda o: o.trap_bull or o.trap_bear),
    ("osc_vac_bull", lambda o: o.vac_align_bull),
    ("osc_vac_bear", lambda o: o.vac_align_bear),
    ("osc_toxic", lambda o: o.toxic_flow),
]


@pytest.mark.parametrize("col,get", FLAG_COLS, ids=[c for c, _ in FLAG_COLS])
def test_signal_flags_exact_with_ltf(run, col, get):
    pairs = _window(run, True)
    mismatches = [i for i, (r, o) in enumerate(pairs) if bool(_f(r[col]) or 0) != bool(get(o))]
    assert mismatches == [], f"{col}: {len(mismatches)} mismatching bars"


def test_signal_flags_have_real_events(run):
    pairs = _window(run, True)
    assert sum(1 for _, o in pairs if o.aplus_bull) >= 10
    assert sum(1 for _, o in pairs if o.aplus_bear) >= 10


@pytest.mark.parametrize("col,get", [("osc_kz", lambda o: o.active_killzone), ("osc_shock_start", lambda o: o.shock_start)])
def test_ohlcv_only_flags_exact_all_bars(run, col, get):
    pairs = _window(run, False)
    assert all(bool(_f(r[col]) or 0) == bool(get(o)) for r, o in pairs)
