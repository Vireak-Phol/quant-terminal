"""Empirical calibration (T9): the ONLY source of the probability shown to the trader.

For a candidate signal we look up closed ledger records of the same kind and report:
  * win rate, Beta(2,2)-smoothed:  (wins + 2) / (n + 4)
  * Wilson 95% interval on the raw rate
  * expectancy in net R (after costs) and profit factor
  * warm-up flag until n >= ``min_samples`` (default 15)

Bucket fallback, most specific first: setup x tier x score_bin -> setup x tier -> tier.
Backtest and live records are calibrated separately; the displayed number prefers live
once it has enough samples, otherwise backtest, otherwise warm-up.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .ledger import Ledger, SignalRecord, score_bin
from .pine import wilson_interval


@dataclass
class Stat:
    n: int
    wins: int
    win_rate: float  # smoothed, percent
    raw_rate: float  # percent
    ci_lo: float
    ci_hi: float
    expectancy_r: float
    profit_factor: Optional[float]
    avg_win_r: float
    avg_loss_r: float
    gross_expectancy_r: float = 0.0  # before fees/slippage — shows edge vs friction
    gross_win_rate: float = 0.0
    avg_cost_r: float = 0.0

    def to_dict(self) -> Dict:
        return asdict(self)


def compute_stat(recs: Sequence[SignalRecord]) -> Stat:
    n = len(recs)
    wins = sum(1 for r in recs if r.win)
    rs = [r.r_net or 0.0 for r in recs]
    gp = sum(x for x in rs if x > 0)
    gl = -sum(x for x in rs if x < 0)
    lo, hi = wilson_interval(wins, n)
    w = [x for x in rs if x > 0]
    ls = [x for x in rs if x <= 0]
    return Stat(
        n=n, wins=wins,
        win_rate=round(((wins + 2.0) / (n + 4.0)) * 100.0, 2) if n else 50.0,
        raw_rate=round(wins / n * 100.0, 2) if n else 0.0,
        ci_lo=round(lo, 2), ci_hi=round(hi, 2),
        expectancy_r=round(sum(rs) / n, 4) if n else 0.0,
        profit_factor=round(gp / gl, 3) if gl > 0 else (None if gp == 0 else float("inf")),
        avg_win_r=round(sum(w) / len(w), 3) if w else 0.0,
        avg_loss_r=round(sum(ls) / len(ls), 3) if ls else 0.0,
        gross_expectancy_r=round(sum(r.r_gross or 0.0 for r in recs) / n, 4) if n else 0.0,
        gross_win_rate=round(sum(1 for r in recs if (r.r_gross or 0) > 0) / n * 100.0, 2) if n else 0.0,
        avg_cost_r=round(sum(r.cost_r for r in recs) / n, 4) if n else 0.0,
    )


@dataclass
class Estimate:
    status: str  # measured | warmup
    source: Optional[str]  # live | backtest
    bucket: str  # e.g. "FVG_Bull|A_PLUS|65"
    level: str  # setup_tier_bin | setup_tier | tier | none
    stat: Optional[Stat]
    backtest: Optional[Stat]
    live: Optional[Stat]
    min_samples: int

    def to_dict(self) -> Dict:
        return {
            "status": self.status, "source": self.source, "bucket": self.bucket, "level": self.level,
            "min_samples": self.min_samples,
            "stat": self.stat.to_dict() if self.stat else None,
            "backtest": self.backtest.to_dict() if self.backtest else None,
            "live": self.live.to_dict() if self.live else None,
        }


Key = Tuple[str, ...]


class Calibrator:
    """In-memory index over closed ledger records; rebuilt on demand, updated incrementally."""

    def __init__(self, ledger: Optional[Ledger] = None, min_samples: int = 15,
                 window_live: int = 300, window_backtest: int = 5000):
        self.ledger = ledger
        self.min_samples = min_samples
        self.windows = {"live": window_live, "backtest": window_backtest}
        self.idx: Dict[str, Dict[Key, List[SignalRecord]]] = {"live": defaultdict(list), "backtest": defaultdict(list)}
        if ledger is not None:
            self.rebuild()

    @staticmethod
    def keys(tf: str, setup: str, tier: str, sbin: int) -> List[Tuple[str, Key]]:
        return [
            ("setup_tier_bin", (tf, setup, tier, str(sbin))),
            ("setup_tier", (tf, setup, tier)),
            ("tier", (tf, tier)),
        ]

    def rebuild(self) -> None:
        self.idx = {"live": defaultdict(list), "backtest": defaultdict(list)}
        if self.ledger is None:
            return
        for rec in self.ledger.closed():
            self.add(rec)

    def add(self, rec: SignalRecord) -> None:
        if rec.status != "closed" or rec.source not in self.idx:
            return
        for _, k in self.keys(rec.tf, rec.setup, rec.tier, score_bin(rec.score)):
            lst = self.idx[rec.source][k]
            lst.append(rec)
            if len(lst) > self.windows[rec.source]:
                del lst[0]

    def _stat(self, source: str, key: Key) -> Optional[Stat]:
        recs = self.idx[source].get(key)
        return compute_stat(recs) if recs else None

    def estimate(self, tf: str, setup: str, tier: str, score: float) -> Estimate:
        sbin = score_bin(score)
        best_partial: Optional[Tuple[str, Key, Optional[Stat], Optional[Stat]]] = None
        for level, key in self.keys(tf, setup, tier, sbin):
            live = self._stat("live", key)
            bt = self._stat("backtest", key)
            if live and live.n >= self.min_samples:
                return Estimate("measured", "live", "|".join(key[1:]), level, live, bt, live, self.min_samples)
            if bt and bt.n >= self.min_samples:
                return Estimate("measured", "backtest", "|".join(key[1:]), level, bt, bt, live, self.min_samples)
            if best_partial is None and (live or bt):
                best_partial = (level, key, bt, live)
        if best_partial:
            level, key, bt, live = best_partial
            stat = max((s for s in (live, bt) if s), key=lambda s: s.n)
            return Estimate("warmup", None, "|".join(key[1:]), level, stat, bt, live, self.min_samples)
        return Estimate("warmup", None, f"{setup}|{tier}", "none", None, None, None, self.min_samples)

    def summary(self, source: str, tf: Optional[str] = None) -> List[Dict]:
        """Per setup x tier table for the Ledger view."""
        rows = []
        for key, recs in self.idx[source].items():
            if len(key) != 3 or (tf and key[0] != tf):
                continue
            s = compute_stat(recs)
            rows.append({"tf": key[0], "setup": key[1], "tier": key[2], **s.to_dict(), "warmup": s.n < self.min_samples})
        rows.sort(key=lambda r: (r["tf"], r["tier"], -r["n"]))
        return rows

    def reliability(self, source: str, tf: str) -> List[Dict]:
        """Model score bin vs measured win rate — shows whether the heuristic is calibrated."""
        by_bin: Dict[int, List[SignalRecord]] = defaultdict(list)
        for key, recs in self.idx[source].items():
            if len(key) == 2 and key[0] == tf:
                for r in recs:
                    by_bin[score_bin(r.score)].append(r)
        out = []
        for b in sorted(by_bin):
            s = compute_stat(by_bin[b])
            out.append({"score_bin": b, **s.to_dict()})
        return out
