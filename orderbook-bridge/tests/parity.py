"""Load TradingView parity fixtures and replay them through the Python engines."""

from __future__ import annotations

import csv
import os
from dataclasses import dataclass
from typing import Dict, List, Optional

from engine.htf import AlignedSeries, HtfTracker, group_intrabars
from engine.osc_engine import BarInput, OscBar, OscConfig, OscEngine, pine_ltf_flows

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _f(x: str) -> Optional[float]:
    return float(x) if x not in ("", None) else None


def load_bars(name: str) -> List[List[float]]:
    out = []
    with open(os.path.join(FIX, name)) as fh:
        for r in csv.DictReader(fh):
            out.append([int(float(r["time"])), float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), _f(r["volume"]) or 0.0])
    return out


def load_tv_5m() -> List[Dict]:
    with open(os.path.join(FIX, "tv_xauusd_5m.csv")) as fh:
        return list(csv.DictReader(fh))


@dataclass
class ParityRun:
    rows: List[Dict]
    out: List[OscBar]
    ltf_covered_from: int  # chart bar index where 1m intrabars become available


_CACHE: Dict[str, ParityRun] = {}


def run_osc_parity(cfg: Optional[OscConfig] = None, use_macro: bool = True) -> ParityRun:
    key = f"{id(cfg) if cfg else 'default'}-{use_macro}"
    if key in _CACHE:
        return _CACHE[key]
    rows = load_tv_5m()
    one_min = load_bars("tv_xauusd_1m.csv")
    four_h = load_bars("tv_xauusd_4h.csv")
    dxy = AlignedSeries([(b[0], b[4]) for b in load_bars("tv_dxy_5m.csv")])
    vix = AlignedSeries([(b[0], b[4]) for b in load_bars("tv_vix_5m.csv")])
    times = [int(float(r["time"])) for r in rows]
    ib = group_intrabars(times, 300, one_min)
    htf = HtfTracker()
    for b in four_h:
        htf.add_bar(b[0], b[1], b[2], b[3], b[4])
    eng = OscEngine(cfg or OscConfig(mintick=0.001))
    out: List[OscBar] = []
    prev_bucket = None
    covered = None
    for i, r in enumerate(rows):
        t = times[i]
        bucket = htf.bucket_of(t)
        intrabars = ib.get(t)
        if intrabars and covered is None:
            covered = i
        flows = pine_ltf_flows([x[1:6] for x in intrabars]) if intrabars else None
        bar = BarInput(
            t=t, o=float(r["open"]), h=float(r["high"]), l=float(r["low"]), c=float(r["close"]), v=float(r["volume"] or 0),
            ltf_flows=flows, htf=htf.values_for(t), htf_new_bucket=(prev_bucket is not None and bucket != prev_bucket),
            dxy=dxy.at(t) if use_macro else None, vix=vix.at(t) if use_macro else None,
        )
        prev_bucket = bucket
        out.append(eng.update(bar))
    run = ParityRun(rows, out, covered if covered is not None else len(rows))
    _CACHE[key] = run
    return run
