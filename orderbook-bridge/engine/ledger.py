"""Signal ledger (T9): every closed-bar signal becomes a measurable trade record.

Outcome rule (conservative, documented in the UI):
  * Evaluated from the bar *after* entry (entry = signal bar close).
  * SL touched -> loss at -1R (stop trigger includes no slippage; costs are added separately).
  * TP1 touched (and SL not touched on the same bar) -> win at +rr_tp1 R.
  * SL and TP1 both touched inside one bar -> counted as a LOSS (intrabar order unknown).
  * Neither within ``horizon`` bars -> closed at that bar's close; win iff net R > 0.
  * Net R = gross R - round-trip cost in R.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Dict, Iterable, List, Optional

DEFAULT_DB = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "ledger.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,            -- backtest | live
    symbol TEXT NOT NULL,
    tf TEXT NOT NULL,
    setup TEXT NOT NULL,             -- e.g. FVG_Bull, LIQ_Bear, TRAP_Bull
    direction TEXT NOT NULL,         -- LONG | SHORT
    tier TEXT NOT NULL,              -- A_PLUS | STRUCTURAL | TRAP
    score REAL NOT NULL,             -- OSC model score (heuristic, internal)
    score_bin INTEGER NOT NULL,      -- floor(score/5)*5
    tags TEXT NOT NULL,              -- JSON list of confluence/order-flow tags
    entry_time INTEGER NOT NULL,
    entry REAL NOT NULL,
    stop REAL NOT NULL,
    tp1 REAL NOT NULL,
    tp2 REAL NOT NULL,
    risk REAL NOT NULL,
    cost_r REAL NOT NULL,
    horizon INTEGER NOT NULL,
    bars INTEGER NOT NULL DEFAULT 0,
    mfe_r REAL NOT NULL DEFAULT 0,
    mae_r REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',  -- open | closed
    outcome TEXT,                    -- tp1 | sl | sl_same_bar | timeout
    win INTEGER,
    exit_time INTEGER,
    exit_price REAL,
    r_gross REAL,
    r_net REAL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bucket ON signals (source, tf, setup, tier, score_bin, status);
CREATE INDEX IF NOT EXISTS ix_time ON signals (entry_time);
"""


def score_bin(score: float) -> int:
    return int(max(0, min(95, (score // 5) * 5)))


@dataclass
class SignalRecord:
    id: str
    source: str
    symbol: str
    tf: str
    setup: str
    direction: str
    tier: str
    score: float
    entry_time: int
    entry: float
    stop: float
    tp1: float
    tp2: float
    cost_r: float
    horizon: int
    tags: List[str] = field(default_factory=list)
    bars: int = 0
    mfe_r: float = 0.0
    mae_r: float = 0.0
    status: str = "open"
    outcome: Optional[str] = None
    win: Optional[bool] = None
    exit_time: Optional[int] = None
    exit_price: Optional[float] = None
    r_gross: Optional[float] = None
    r_net: Optional[float] = None

    @property
    def risk(self) -> float:
        return abs(self.entry - self.stop)

    @property
    def is_long(self) -> bool:
        return self.direction == "LONG"

    def step(self, t: int, h: float, l: float, c: float) -> bool:
        """Advance one bar. Returns True if the record closed on this bar."""
        if self.status != "open":
            return False
        self.bars += 1
        r = self.risk
        if r <= 0:
            self._close(t, c, "timeout", 0.0)
            return True
        fav = (h - self.entry) / r if self.is_long else (self.entry - l) / r
        adv = (self.entry - l) / r if self.is_long else (h - self.entry) / r
        self.mfe_r = max(self.mfe_r, fav)
        self.mae_r = max(self.mae_r, adv)
        sl_hit = l <= self.stop if self.is_long else h >= self.stop
        tp_hit = h >= self.tp1 if self.is_long else l <= self.tp1
        if sl_hit:
            self._close(t, self.stop, "sl_same_bar" if tp_hit else "sl", -1.0)
            return True
        if tp_hit:
            self._close(t, self.tp1, "tp1", abs(self.tp1 - self.entry) / r)
            return True
        if self.bars >= self.horizon:
            g = (c - self.entry) / r if self.is_long else (self.entry - c) / r
            self._close(t, c, "timeout", g)
            return True
        return False

    def _close(self, t: int, px: float, outcome: str, r_gross: float) -> None:
        self.status = "closed"
        self.exit_time = t
        self.exit_price = px
        self.outcome = outcome
        self.r_gross = round(r_gross, 4)
        self.r_net = round(r_gross - self.cost_r, 4)
        self.win = self.r_net > 0 and outcome in ("tp1", "timeout")

    def to_dict(self) -> Dict:
        d = asdict(self)
        d["risk"] = self.risk
        d["score_bin"] = score_bin(self.score)
        return d


class Ledger:
    """SQLite-backed ledger. Open records are mirrored in memory for per-bar resolution."""

    def __init__(self, path: str = DEFAULT_DB):
        self.path = path
        self._mirror_path: Optional[str] = None
        if path != ":memory:":
            os.makedirs(os.path.dirname(path), exist_ok=True)
        self._lock = threading.RLock()
        try:
            self.db = sqlite3.connect(path, check_same_thread=False)
            self.db.row_factory = sqlite3.Row
            self.db.executescript(SCHEMA)
            self.db.execute("PRAGMA user_version = 1")
            self.db.commit()
        except sqlite3.OperationalError:
            try:
                self.db.close()
            except Exception:
                pass
            # Fallback for FUSE / virtual mounts without POSIX advisory locks:
            h = hashlib.md5(os.path.abspath(path).encode()).hexdigest()[:12]
            self._mirror_path = os.path.join(tempfile.gettempdir(), f"ledger_{h}.db")
            if os.path.exists(path) and os.path.getsize(path) > 0:
                shutil.copy2(path, self._mirror_path)
            self.db = sqlite3.connect(self._mirror_path, check_same_thread=False)
            self.db.row_factory = sqlite3.Row
            self.db.executescript(SCHEMA)
            self._sync_mirror()
        self.open: Dict[str, SignalRecord] = {}
        for row in self.db.execute("SELECT * FROM signals WHERE status='open' AND source='live'"):
            rec = self._from_row(row)
            self.open[rec.id] = rec

    def _sync_mirror(self) -> None:
        if self._mirror_path and self.path != ":memory:":
            self.db.commit()
            shutil.copy2(self._mirror_path, self.path)

    # ── writes ──────────────────────────────────────────────────────────────
    def add(self, rec: SignalRecord, track: bool = True) -> None:
        with self._lock:
            self._upsert(rec)
            self.db.commit()
            self._sync_mirror()
            if track and rec.status == "open":
                self.open[rec.id] = rec

    def add_many(self, recs: Iterable[SignalRecord]) -> int:
        n = 0
        with self._lock:
            for rec in recs:
                self._upsert(rec)
                n += 1
            self.db.commit()
            self._sync_mirror()
        return n

    def on_bar(self, tf: str, t: int, h: float, l: float, c: float) -> List[SignalRecord]:
        """Resolve open records of timeframe ``tf`` against a newly closed bar."""
        closed: List[SignalRecord] = []
        with self._lock:
            for rid in list(self.open):
                rec = self.open[rid]
                if rec.tf != tf or t <= rec.entry_time:
                    continue
                done = rec.step(t, h, l, c)
                self._upsert(rec)
                if done:
                    closed.append(rec)
                    del self.open[rid]
            self.db.commit()
            self._sync_mirror()
        return closed

    def clear_source(self, source: str, tf: Optional[str] = None) -> None:
        with self._lock:
            if tf:
                self.db.execute("DELETE FROM signals WHERE source=? AND tf=?", (source, tf))
            else:
                self.db.execute("DELETE FROM signals WHERE source=?", (source,))
            self.db.commit()
            self._sync_mirror()

    def _upsert(self, rec: SignalRecord) -> None:
        self.db.execute(
            """INSERT OR REPLACE INTO signals (id, source, symbol, tf, setup, direction, tier, score, score_bin, tags,
               entry_time, entry, stop, tp1, tp2, risk, cost_r, horizon, bars, mfe_r, mae_r, status, outcome, win,
               exit_time, exit_price, r_gross, r_net, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (rec.id, rec.source, rec.symbol, rec.tf, rec.setup, rec.direction, rec.tier, rec.score, score_bin(rec.score),
             json.dumps(rec.tags), rec.entry_time, rec.entry, rec.stop, rec.tp1, rec.tp2, rec.risk, rec.cost_r,
             rec.horizon, rec.bars, rec.mfe_r, rec.mae_r, rec.status, rec.outcome,
             None if rec.win is None else int(rec.win), rec.exit_time, rec.exit_price, rec.r_gross, rec.r_net,
             int(time.time())),
        )

    @staticmethod
    def _from_row(row: sqlite3.Row) -> SignalRecord:
        return SignalRecord(
            id=row["id"], source=row["source"], symbol=row["symbol"], tf=row["tf"], setup=row["setup"],
            direction=row["direction"], tier=row["tier"], score=row["score"], entry_time=row["entry_time"],
            entry=row["entry"], stop=row["stop"], tp1=row["tp1"], tp2=row["tp2"], cost_r=row["cost_r"],
            horizon=row["horizon"], tags=json.loads(row["tags"]), bars=row["bars"], mfe_r=row["mfe_r"],
            mae_r=row["mae_r"], status=row["status"], outcome=row["outcome"],
            win=None if row["win"] is None else bool(row["win"]), exit_time=row["exit_time"],
            exit_price=row["exit_price"], r_gross=row["r_gross"], r_net=row["r_net"],
        )

    # ── reads ───────────────────────────────────────────────────────────────
    def closed(self, source: Optional[str] = None, tf: Optional[str] = None, since: Optional[int] = None) -> List[SignalRecord]:
        q = "SELECT * FROM signals WHERE status='closed'"
        args: List = []
        if source:
            q += " AND source=?"
            args.append(source)
        if tf:
            q += " AND tf=?"
            args.append(tf)
        if since is not None:
            q += " AND entry_time>=?"
            args.append(since)
        q += " ORDER BY entry_time"
        with self._lock:
            return [self._from_row(r) for r in self.db.execute(q, args)]

    def recent(self, limit: int = 50, source: Optional[str] = None, tf: Optional[str] = None) -> List[SignalRecord]:
        q = "SELECT * FROM signals WHERE 1=1"
        args: List = []
        if source:
            q += " AND source=?"
            args.append(source)
        if tf:
            q += " AND tf=?"
            args.append(tf)
        q += " ORDER BY entry_time DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            return [self._from_row(r) for r in self.db.execute(q, args)]

    def count(self, source: Optional[str] = None) -> int:
        with self._lock:
            if source:
                return self.db.execute("SELECT COUNT(*) FROM signals WHERE source=?", (source,)).fetchone()[0]
            return self.db.execute("SELECT COUNT(*) FROM signals").fetchone()[0]
