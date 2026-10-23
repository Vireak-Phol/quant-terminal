"""Parameter sensitivity sweep for the v7.5 Institutional strategy (5m).

Overfit detection, complementary to validate_oos.py. A genuine edge degrades
*gracefully* when its gates are nudged; a curve-fit collapses because the thresholds
sit on a knife-edge found by tuning against one dataset.

We perturb the four principal 5m A_PLUS gate thresholds by +/-10% and +/-15%:
    - htf_extension regime-room gate   (base 0.72)
    - vwap_z FVG/OB premium gate       (base 0.78)
    - vwap_z OB-band lower edge        (base 0.85)
    - rsi divergence gate              (base 55.0)

Because the production gates are inline literals in runtime.evaluate_institutional_bar,
we monkeypatch that symbol with a PARAMETERIZED CLONE of the 5m path. To guarantee the
clone is a faithful stand-in (and will catch drift if production changes), the test
``test_clone_matches_production_at_baseline`` asserts the clone reproduces the exact
production trade set when run at the baseline thresholds.

Run:
    cd orderbook-bridge && ../.venv/bin/python -m pytest tests/validate_sweep.py -s -q
or standalone:
    cd orderbook-bridge && ../.venv/bin/python tests/validate_sweep.py
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, replace
from typing import Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.dirname(HERE)
for p in (BRIDGE, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

import engine.runtime as runtime
from engine.calibration import Stat, compute_stat
from engine.data import Kline
from engine.ledger import Ledger, SignalRecord
from engine.backtest import run_backtest
from engine.runtime import InstitutionalCandidate, OscBar
from parity import load_bars


@dataclass(frozen=True)
class Thresholds:
    """The four principal 5m A_PLUS gate thresholds (baseline = production values)."""
    htf_room: float = 0.72       # |htf_extension| regime-room gate
    vwap_prem: float = 0.78      # vwap_z FVG/OB premium/discount gate
    ob_band_lo: float = 0.85     # vwap_z OB-band inner edge
    rsi_gate: float = 55.0       # rsi divergence gate (short side; long uses 45 = 100-55 symmetric)

    def scaled(self, factor: float) -> "Thresholds":
        """Scale every gate by `factor` (1.10 = +10%). RSI gate scaled around its 50 pivot."""
        return Thresholds(
            htf_room=round(self.htf_room * factor, 4),
            vwap_prem=round(self.vwap_prem * factor, 4),
            ob_band_lo=round(self.ob_band_lo * factor, 4),
            rsi_gate=round(50.0 + (self.rsi_gate - 50.0) * factor, 4),
        )


def make_eval(th: Thresholds):
    """Return a parameterized clone of the 5m path of evaluate_institutional_bar.

    This mirrors runtime.evaluate_institutional_bar EXACTLY for tf=='5m'; the four
    swept gates are read from `th` instead of being inline literals. The 15m path and
    the scoring/weight math are identical to production. For tf!='5m' we delegate to
    the real function unchanged.
    """
    real = runtime._ORIG_EVAL

    def _eval(tf, open_, high, low, close, o: OscBar, rp, lq, un, rg) -> List[InstitutionalCandidate]:
        if tf != "5m":
            return real(tf, open_, high, low, close, o, rp, lq, un, rg)
        if not o.ready or o.shock_hard:
            return []
        rsi = getattr(rp, "rsi", None)
        rsi_val = float(rsi) if rsi is not None else 50.0
        out: List[InstitutionalCandidate] = []
        # symmetric long-side rsi gate: 55 -> 45, scaled around 50
        rsi_long = 100.0 - th.rsi_gate

        # ── SHORT ──
        if o.htf_bear and o.htf_extension > -th.htf_room and close < open_:
            if (o.fvg_bear or o.ob_bear) and o.vwap_z >= th.vwap_prem:
                room_bonus = max(0.0, (o.htf_extension + th.htf_room) * 8.0)
                div_bonus = max(0.0, (56.0 - rsi_val) * 0.4)
                sc = 86.0 + min(11.5, room_bonus + div_bonus)
                weights = {
                    "loc": 0.85,
                    "htf": round(0.55 + min(0.35, room_bonus * 0.04), 3),
                    "vwap": round(0.65 + min(0.30, (o.vwap_z - 0.75) * 0.35), 3),
                    "press": round(0.45 + min(0.25, div_bonus * 0.06), 3),
                    "reg": 0.35 if o.regime == "RANGING" else 0.20,
                    "sess": 0.35 if o.active_killzone else 0.10,
                    "vac": 0.30 if o.vac_align_bear else 0.0,
                }
                out.append(InstitutionalCandidate("SHORT", "A_PLUS", "FVG_Bear", round(sc, 2), weights))
            elif th.ob_band_lo <= o.vwap_z <= 1.32 and rsi_val < th.rsi_gate:
                div_bonus = max(0.0, (th.rsi_gate - rsi_val) * 1.5)
                room_bonus = max(0.0, (o.htf_extension + th.htf_room) * 8.0)
                sc = 76.0 + min(18.5, div_bonus + room_bonus)
                weights = {
                    "vwap": round(0.75 + min(0.25, (o.vwap_z - 0.80) * 0.4), 3),
                    "press": round(0.60 + min(0.30, div_bonus * 0.05), 3),
                    "htf": round(0.50 + min(0.30, room_bonus * 0.04), 3),
                    "loc": 0.65,
                    "reg": 0.35 if o.regime == "RANGING" else 0.20,
                    "sess": 0.30 if o.active_killzone else 0.10,
                }
                out.append(InstitutionalCandidate("SHORT", "A_PLUS", "OB_Bear", round(sc, 2), weights))

            if 0.82 <= o.vwap_z <= 1.35 and rsi_val < 55.5 and o.htf_extension > -0.68:
                sc_s = 55.0 + min(9.5, max(0.0, (55.5 - rsi_val) * 0.9 + (o.htf_extension + 0.68) * 5.0))
                out.append(InstitutionalCandidate("SHORT", "STRUCTURAL", "FVG_Bear", round(sc_s, 2),
                                                   {"htf": 0.45, "vwap": 0.50, "press": 0.35, "loc": 0.40, "reg": 0.25}))

        # ── LONG ──
        if o.htf_bull and o.htf_extension < th.htf_room and close > open_:
            if (o.fvg_bull or o.ob_bull) and o.vwap_z <= -th.vwap_prem:
                room_bonus = max(0.0, (th.htf_room - o.htf_extension) * 8.0)
                div_bonus = max(0.0, (rsi_val - 44.0) * 0.4)
                sc = 86.0 + min(11.5, room_bonus + div_bonus)
                weights = {"loc": 0.85, "htf": 0.60, "vwap": 0.70, "press": 0.50, "reg": 0.30}
                out.append(InstitutionalCandidate("LONG", "A_PLUS", "FVG_Bull", round(sc, 2), weights))
            elif -1.32 <= o.vwap_z <= -th.ob_band_lo and rsi_val > rsi_long:
                div_bonus = max(0.0, (rsi_val - 45.0) * 1.5)
                room_bonus = max(0.0, (th.htf_room - o.htf_extension) * 8.0)
                sc = 76.0 + min(18.5, div_bonus + room_bonus)
                weights = {"vwap": 0.75, "press": 0.60, "htf": 0.55, "loc": 0.65, "reg": 0.30}
                out.append(InstitutionalCandidate("LONG", "A_PLUS", "OB_Bull", round(sc, 2), weights))

            if -1.35 <= o.vwap_z <= -0.82 and rsi_val > 44.5 and o.htf_extension < 0.68:
                sc_s = 55.0 + min(9.5, max(0.0, (rsi_val - 44.5) * 0.9 + (0.68 - o.htf_extension) * 5.0))
                out.append(InstitutionalCandidate("LONG", "STRUCTURAL", "FVG_Bull", round(sc_s, 2),
                                                   {"htf": 0.45, "vwap": 0.50, "loc": 0.40}))
        return out

    return _eval


# preserve the pristine production function once
if not hasattr(runtime, "_ORIG_EVAL"):
    runtime._ORIG_EVAL = runtime.evaluate_institutional_bar


def _k(b) -> Kline:
    return Kline(int(b[0]), b[1], b[2], b[3], b[4], b[5] or 0.0, 0.0)


def _load():
    five = [_k(b) for b in load_bars("tv_xauusd_5m.csv")][:-1]
    one = [_k(b) for b in load_bars("tv_xauusd_1m.csv")]
    four = [_k(b) for b in load_bars("tv_xauusd_4h.csv")]
    return five, one, four


def _run_with(th: Optional[Thresholds]) -> List[SignalRecord]:
    five, one, four = _load()
    patched = th is not None
    if patched:
        runtime.evaluate_institutional_bar = make_eval(th)
    try:
        res = run_backtest("5m", five, one, four, Ledger(":memory:"), flow_mode="taker")
        return res["closed"]
    finally:
        if patched:
            runtime.evaluate_institutional_bar = runtime._ORIG_EVAL


def _aplus(recs: List[SignalRecord]) -> Stat:
    return compute_stat([r for r in recs if r.tier == "A_PLUS"])


def run() -> dict:
    base = Thresholds()
    factors = [0.85, 0.90, 1.00, 1.10, 1.15]
    print(f"\n{'='*92}")
    print("PARAMETER SENSITIVITY SWEEP — 5m A_PLUS  (scale all 4 principal gates by factor)")
    print(f"{'='*92}")
    print("baseline gates: htf_room=0.72  vwap_prem=0.78  ob_band_lo=0.85  rsi_gate=55.0")
    print(f"\n{'factor':>7} {'gates':<34} {'n':>4} {'raw%':>6} {'E[R]':>8} {'PF':>7} {'grossE':>8}")
    print("-" * 78)
    rows = {}
    for f in factors:
        th = base.scaled(f) if f != 1.00 else base
        s = _aplus(_run_with(None if f == 1.00 else th))
        rows[f] = s.to_dict()
        pf = "inf" if s.profit_factor == float("inf") else ("-" if s.profit_factor is None else f"{s.profit_factor:.2f}")
        gates = f"h={th.htf_room} v={th.vwap_prem} ob={th.ob_band_lo} r={th.rsi_gate}"
        tag = "  <= BASELINE" if f == 1.00 else ""
        print(f"{f:>7.2f} {gates:<34} {s.n:>4} {s.raw_rate:>6.1f} {s.expectancy_r:>+8.3f} {pf:>7} {s.gross_expectancy_r:>+8.3f}{tag}")
    print(f"{'='*92}")

    # Interpretation
    e = {f: rows[f]["expectancy_r"] for f in factors}
    pf = {f: rows[f]["profit_factor"] for f in factors}
    base_e = e[1.00]
    worst_e = min(e.values())
    worst_pf = min(v for v in pf.values() if isinstance(v, float))
    all_profitable = all(v > 0 for v in e.values())
    all_pf_ok = all((isinstance(v, float) and v > 1.2) for v in pf.values())
    print(f"baseline E[R]={base_e:+.3f}  worst-perturbation E[R]={worst_e:+.3f}  worst PF={worst_pf:.2f}")
    if all_profitable and all_pf_ok:
        print("VERDICT: ROBUST — edge survives +/-15% gate perturbation (graceful degradation).")
    elif all_profitable:
        print("VERDICT: FRAGILE — stays positive but PF dips below 1.2 under perturbation.")
    else:
        print("VERDICT: OVERFIT — edge collapses (negative expectancy) under small gate perturbation.")
    print(f"{'='*92}\n")
    return {"rows": rows, "all_profitable": all_profitable, "all_pf_ok": all_pf_ok}


# ── pytest entry points ───────────────────────────────────────────────────────

def test_clone_matches_production_at_baseline():
    """GUARD: the parameterized clone must reproduce production trades at baseline.

    Without this, the sweep could be measuring a different strategy than production.
    """
    prod = _run_with(None)
    clone = _run_with(Thresholds())  # baseline thresholds via the clone
    key = lambda recs: sorted((r.id, r.tier, round(r.r_net or 0.0, 6)) for r in recs)
    assert key(prod) == key(clone), "clone diverged from production at baseline thresholds"


def test_sweep_report_printed():
    run()
    assert True


if __name__ == "__main__":
    run()
