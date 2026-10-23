"""Chronological out-of-sample validation for the v7.5 Institutional strategy.

The v7.5 thresholds in ``evaluate_institutional_bar`` are hand-tuned. The existing
unit test asserts profitability on the SAME fixture the thresholds were fit to, which
only proves the fit reproduces — not that the edge generalizes. This harness does a
proper walk-forward: the engine warms up on the whole history (so the tail is not
penalized by a cold start), but trades are partitioned by entry time into an
IN-SAMPLE head (the region the parameters were effectively chosen on) and a strictly
LATER OUT-OF-SAMPLE tail that the thresholds never "saw" during tuning.

A real edge survives on the OOS tail. A curve-fit collapses there.

Run:
    cd orderbook-bridge && ../.venv/bin/python -m pytest tests/validate_oos.py -s -q
or standalone:
    cd orderbook-bridge && ../.venv/bin/python tests/validate_oos.py
"""

from __future__ import annotations

import os
import sys
from typing import List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.dirname(HERE)
for p in (BRIDGE, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

from engine.calibration import Stat, compute_stat
from engine.data import Kline
from engine.ledger import Ledger
from engine.backtest import run_backtest
from engine.ledger import SignalRecord
from parity import load_bars

OOS_FRACTION = 0.30  # last 30% of calendar time is held out


def _k(b) -> Kline:
    return Kline(int(b[0]), b[1], b[2], b[3], b[4], b[5] or 0.0, 0.0)


def _load():
    five = [_k(b) for b in load_bars("tv_xauusd_5m.csv")][:-1]
    one = [_k(b) for b in load_bars("tv_xauusd_1m.csv")]
    four = [_k(b) for b in load_bars("tv_xauusd_4h.csv")]
    return five, one, four


def _split_time(bars: List[Kline], frac: float) -> int:
    """Return the entry-time cutoff: trades with entry_time >= cutoff are OOS."""
    t0, t1 = bars[0].t, bars[-1].t
    return int(t0 + (1.0 - frac) * (t1 - t0))


def _fmt(label: str, s: Optional[Stat]) -> str:
    if s is None or s.n == 0:
        return f"  {label:<26} n=0   (no trades)"
    pf = "inf" if s.profit_factor == float("inf") else ("-" if s.profit_factor is None else f"{s.profit_factor:.2f}")
    return (
        f"  {label:<26} n={s.n:<4} raw_win={s.raw_rate:5.1f}%  "
        f"CI95=[{s.ci_lo:4.1f},{s.ci_hi:4.1f}]  E[R]={s.expectancy_r:+.3f}  "
        f"grossE[R]={s.gross_expectancy_r:+.3f}  PF={pf:>5}  costR={s.avg_cost_r:.3f}"
    )


def run(tf: str = "5m", frac: float = OOS_FRACTION) -> dict:
    five, one, four = _load()
    cutoff = _split_time(five, frac)
    led = Ledger(":memory:")
    res = run_backtest(tf, five, one, four, led, flow_mode="taker")
    closed: List[SignalRecord] = res["closed"]

    def part(tier: str, oos: bool) -> List[SignalRecord]:
        return [
            r for r in closed
            if r.tier == tier and ((r.entry_time >= cutoff) == oos)
        ]

    out = {"tf": tf, "cutoff": cutoff, "frac": frac, "total_closed": len(closed), "tiers": {}}
    print(f"\n{'='*92}")
    print(f"CHRONOLOGICAL OUT-OF-SAMPLE VALIDATION — {tf}  (held-out tail = last {frac:.0%} of time)")
    print(f"{'='*92}")
    print(f"total closed trades: {len(closed)}   split entry_time cutoff: {cutoff}")
    for tier in ("A_PLUS", "STRUCTURAL"):
        ins = compute_stat(part(tier, oos=False))
        oos = compute_stat(part(tier, oos=True))
        out["tiers"][tier] = {"in_sample": ins.to_dict(), "oos": oos.to_dict()}
        print(f"\n[{tier}]")
        print(_fmt("in-sample (head)", ins))
        print(_fmt("OUT-OF-SAMPLE (tail)", oos))
        if ins.n and oos.n:
            e_drop = oos.expectancy_r - ins.expectancy_r
            pf_in = ins.profit_factor if isinstance(ins.profit_factor, float) else float("nan")
            pf_oos = oos.profit_factor if isinstance(oos.profit_factor, float) else float("nan")
            verdict = (
                "HOLDS" if oos.expectancy_r > 0.05 and (oos.profit_factor or 0) > 1.2
                else "DEGRADED" if oos.expectancy_r > 0
                else "COLLAPSED (negative OOS expectancy)"
            )
            print(f"  -> OOS vs in-sample: dE[R]={e_drop:+.3f}  PF {pf_in:.2f}->{pf_oos:.2f}   VERDICT: {verdict}")
    print(f"{'='*92}\n")
    return out


# ── pytest entry points ───────────────────────────────────────────────────────

def test_oos_aplus_has_trades():
    """Sanity: the held-out tail must contain A_PLUS trades to evaluate at all."""
    out = run("5m")
    oos_n = out["tiers"]["A_PLUS"]["oos"]["n"]
    assert oos_n > 0, "no A_PLUS trades in the out-of-sample tail; cannot validate"


def test_oos_report_printed():
    """Informational: always passes; the value is the printed table (run with -s)."""
    run("5m")
    assert True


if __name__ == "__main__":
    run("5m")
