"""Backtest CLI (T10): replay Binance XAUUSDT history bar-by-bar through the live engine.

    cd orderbook-bridge && ../.venv/bin/python -m engine.backtest --tf 5m --tf 15m

* Uses exactly ``TimeframeEngine`` (same code path as live), closed bars only, no lookahead.
* Order-book evidence is unavailable historically, so order-flow tags are absent here and
  are measured going forward by the live ledger.
* Replaces previous ``source=backtest`` records for the timeframe, then prints a report:
  per setup x tier win rate (Beta-smoothed + Wilson CI), net expectancy, drawdown and a
  reliability table (model score bin vs measured win rate).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from typing import Dict, List, Optional

from .calibration import Calibrator, compute_stat
from .data import TF_SECONDS, Kline, load_history
from .ledger import DEFAULT_DB, Ledger, SignalRecord
from .risk import RiskConfig
from .runtime import TimeframeEngine, group_intrabars
from .venue import VENUES, active_venue

log = logging.getLogger("engine.backtest")


def run_backtest(
    tf: str,
    chart: List[Kline],
    one_min: List[Kline],
    four_h: List[Kline],
    ledger: Optional[Ledger] = None,
    risk: Optional[RiskConfig] = None,
    flow_mode: str = "taker",
    symbol: str = "XAUUSDT",
) -> Dict:
    eng = TimeframeEngine(tf, symbol=symbol, ledger=ledger, calibrator=Calibrator(None), risk=risk or RiskConfig(),
                          source="backtest", flow_mode=flow_mode)
    eng.cal.ledger = ledger
    secs = TF_SECONDS[tf]
    ib = group_intrabars(chart, secs, one_min)
    h4 = sorted(four_h, key=lambda k: k.t)
    j = 0
    all_closed: List[SignalRecord] = []
    n_signals = 0
    for k in chart:
        # feed every 4H bar that has CLOSED by this chart bar's open
        while j < len(h4) and h4[j].t + 14400 <= k.t:
            eng.add_htf_bar(h4[j])
            j += 1
        sigs = eng.on_bar(k, ib.get(k.t))
        n_signals += len(sigs)
        if eng.closed_buffer:
            all_closed.extend(eng.closed_buffer)
            if ledger is not None:
                eng.flush()
            else:
                eng.closed_buffer = []
    return {"engine": eng, "closed": all_closed, "signals": n_signals, "bars": len(chart)}


def max_drawdown_r(recs: List[SignalRecord]) -> float:
    eq = peak = dd = 0.0
    for r in sorted(recs, key=lambda r: r.exit_time or r.entry_time):
        eq += r.r_net or 0.0
        peak = max(peak, eq)
        dd = min(dd, eq - peak)
    return round(dd, 3)


def report(tf: str, closed: List[SignalRecord], min_samples: int = 15) -> Dict:
    cal = Calibrator(None, min_samples=min_samples)
    for r in closed:
        cal.add(r)
    by_tier = {}
    for tier in ("A_PLUS", "STRUCTURAL", "TRAP"):
        recs = [r for r in closed if r.tier == tier]
        if recs:
            s = compute_stat(recs).to_dict()
            s["max_dd_r"] = max_drawdown_r(recs)
            by_tier[tier] = s
    return {
        "tf": tf,
        "closed": len(closed),
        "span": [min((r.entry_time for r in closed), default=None), max((r.entry_time for r in closed), default=None)],
        "by_tier": by_tier,
        "by_setup": cal.summary("backtest", tf),
        "reliability": cal.reliability("backtest", tf),
    }


def _fmt_report(rep: Dict) -> str:
    lines = [f"\n══ Backtest {rep['tf']} — {rep['closed']} closed signals ══"]
    lines.append(f"{'tier':<11}{'n':>6}{'win%':>8}{'CI95':>15}{'E[R]':>9}{'PF':>7}{'maxDD R':>9}{'grossE':>9}{'costR':>8}")
    for tier, s in rep["by_tier"].items():
        pf = "∞" if s["profit_factor"] == float("inf") else ("-" if s["profit_factor"] is None else f"{s['profit_factor']:.2f}")
        lines.append(f"{tier:<11}{s['n']:>6}{s['win_rate']:>8.1f}{s['ci_lo']:>8.1f}-{s['ci_hi']:<6.1f}{s['expectancy_r']:>9.3f}{pf:>7}{s['max_dd_r']:>9.2f}{s['gross_expectancy_r']:>9.3f}{s['avg_cost_r']:>8.2f}")
    lines.append("\nper setup x tier (n>=15 measured, else warm-up):")
    for r in rep["by_setup"]:
        flag = " (warmup)" if r["warmup"] else ""
        lines.append(f"  {r['setup']:<10}{r['tier']:<11} n={r['n']:<5} win={r['win_rate']:5.1f}% [{r['ci_lo']:.1f}-{r['ci_hi']:.1f}] E={r['expectancy_r']:+.3f}R{flag}")
    lines.append("\nreliability (model score bin -> measured win%):")
    for r in rep["reliability"]:
        lines.append(f"  score {r['score_bin']:>3}-{r['score_bin'] + 5:<3} n={r['n']:<5} measured={r['win_rate']:5.1f}%  E={r['expectancy_r']:+.3f}R")
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="v7.4 engine backtest on venue XAU history (Binance XAUUSDT or OANDA XAU_USD)")
    ap.add_argument("--tf", action="append", choices=["5m", "15m"], help="chart timeframe(s); default 5m and 15m")
    ap.add_argument("--provider", choices=sorted(VENUES), default=None,
                    help="venue: sets symbol, ledger DB and risk cost model (default: active provider)")
    ap.add_argument("--symbol", default=None, help="override the venue symbol")
    ap.add_argument("--db", default=None, help="override the venue ledger DB")
    ap.add_argument("--no-refresh", action="store_true", help="use cached klines only")
    ap.add_argument("--flow", choices=["taker", "pine"], default="taker", help="intrabar flow model")
    ap.add_argument("--json", help="write the report JSON to this path")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    venue = VENUES[args.provider] if args.provider else active_venue()
    args.symbol = args.symbol or venue.symbol
    args.db = args.db or venue.ledger_path
    tfs = args.tf or ["5m", "15m"]
    refresh = not args.no_refresh
    t0 = time.time()
    log.info("venue %s (%s) · loading 1m / 4h history (cached under data/cache)…", venue.name, args.symbol)
    one = load_history(args.symbol, "1m", refresh=refresh)
    h4 = load_history(args.symbol, "4h", refresh=refresh)
    ledger = Ledger(args.db)
    risk = RiskConfig.load(section=venue.risk_section, defaults=venue.risk_defaults)
    reports = []
    for tf in tfs:
        chart = load_history(args.symbol, tf, refresh=refresh)
        log.info("%s: %d bars, %d 1m intrabars, %d 4h bars", tf, len(chart), len(one), len(h4))
        ledger.clear_source("backtest", tf)
        res = run_backtest(tf, chart, one, h4, ledger, risk, args.flow, symbol=args.symbol)
        rep = report(tf, res["closed"])
        rep["bars"] = res["bars"]
        reports.append(rep)
        print(_fmt_report(rep))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(reports, fh, indent=2, default=str)
    log.info("done in %.1fs; ledger now has %d backtest records", time.time() - t0, ledger.count("backtest"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
