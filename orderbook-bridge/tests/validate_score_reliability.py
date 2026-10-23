"""Does the hand-assigned institutional SCORE actually predict the outcome?

The v7.5 scores (86.0, 95.1, 76.0, ...) are hand-anchored, not learned. The calibrator
stratifies measured win-rate by ``score_bin`` (floor(score/5)*5) at its most-specific
level. That stratification is only honest if a HIGHER score corresponds to a HIGHER
measured win-rate. This harness checks:

  1. Spread  — how many score bins are actually populated (a fabricated constant score
               collapses everything into one bin, making the stratification meaningless).
  2. Monotonicity — rank correlation between score and realised net R / win.
  3. Bin reliability — measured win% per score bin, with sample counts.

If the score is NOT predictive, the most-specific calibrator level adds noise, and the
honest fix is to down-weight it. If it IS predictive, the current design is sound.

Run: cd orderbook-bridge && ../.venv/bin/python tests/validate_score_reliability.py
"""

from __future__ import annotations

import os
import sys
from collections import defaultdict
from typing import List

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.dirname(HERE)
for p in (BRIDGE, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

from engine.calibration import compute_stat
from engine.data import Kline
from engine.ledger import Ledger, SignalRecord, score_bin
from engine.backtest import run_backtest
from parity import load_bars


def _k(b) -> Kline:
    return Kline(int(b[0]), b[1], b[2], b[3], b[4], b[5] or 0.0, 0.0)


def _closed() -> List[SignalRecord]:
    five = [_k(b) for b in load_bars("tv_xauusd_5m.csv")][:-1]
    one = [_k(b) for b in load_bars("tv_xauusd_1m.csv")]
    four = [_k(b) for b in load_bars("tv_xauusd_4h.csv")]
    return run_backtest("5m", five, one, four, Ledger(":memory:"), flow_mode="taker")["closed"]


def _spearman(xs: List[float], ys: List[float]) -> float:
    """Rank correlation; robust to the score's arbitrary scale."""
    n = len(xs)
    if n < 3:
        return float("nan")

    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1.0
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    dx = sum((rx[i] - mx) ** 2 for i in range(n)) ** 0.5
    dy = sum((ry[i] - my) ** 2 for i in range(n)) ** 0.5
    return num / (dx * dy) if dx and dy else float("nan")


def run() -> dict:
    closed = _closed()
    aplus = [r for r in closed if r.tier == "A_PLUS"]
    print(f"\n{'='*84}")
    print("SCORE RELIABILITY — does a higher institutional score predict a better outcome?")
    print(f"{'='*84}")
    print(f"A_PLUS closed trades: {len(aplus)}")

    # 1. Spread of score bins
    bins = defaultdict(list)
    for r in aplus:
        bins[score_bin(r.score)].append(r)
    print(f"\npopulated score bins: {sorted(bins)}  ({len(bins)} distinct)")
    raw_scores = sorted({round(r.score, 1) for r in aplus})
    print(f"distinct raw scores:  {raw_scores}")

    # 2. Monotonicity (rank corr of score vs net R, and score vs win)
    scores = [r.score for r in aplus]
    rnet = [r.r_net or 0.0 for r in aplus]
    wins = [1.0 if r.win else 0.0 for r in aplus]
    rho_r = _spearman(scores, rnet)
    rho_w = _spearman(scores, wins)
    print(f"\nSpearman(score, net R) = {rho_r:+.3f}")
    print(f"Spearman(score, win)   = {rho_w:+.3f}")

    # 3. Per-bin reliability
    print(f"\n{'score bin':>10} {'n':>4} {'win%':>7} {'E[R]':>8}")
    print("-" * 34)
    for b in sorted(bins):
        s = compute_stat(bins[b])
        print(f"{b:>7}-{b+5:<2} {s.n:>4} {s.raw_rate:>7.1f} {s.expectancy_r:>+8.3f}")
    print(f"{'='*84}")

    n_bins = len(bins)
    predictive = (not (rho_r != rho_r)) and abs(rho_r) >= 0.15 and n_bins >= 2
    if n_bins < 2:
        verdict = ("SCORE IS NEARLY CONSTANT — score_bin stratification is meaningless; "
                   "the most-specific calibrator level collapses to setup_tier anyway.")
    elif predictive and rho_r > 0:
        verdict = "SCORE IS PREDICTIVE — higher score -> better outcome; stratification is honest."
    elif rho_r <= 0:
        verdict = ("SCORE IS NON-PREDICTIVE / INVERTED — higher score does NOT win more; "
                   "the score_bin level misleads and should be down-weighted.")
    else:
        verdict = "SCORE IS WEAKLY PREDICTIVE — low signal; treat bin-level numbers with caution."
    print(f"VERDICT: {verdict}")
    print(f"{'='*84}\n")
    return {"n_bins": n_bins, "rho_r": rho_r, "rho_w": rho_w, "bins": sorted(bins)}


if __name__ == "__main__":
    run()
