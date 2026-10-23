"""Binance USDⓈ-M kline access with an on-disk cache and offline fixture fallback (T2 BarStore backfill)."""

from __future__ import annotations

import csv
import json
import logging
import os
import time
import urllib.request
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional

logger = logging.getLogger("engine.data")

REST = "https://fapi.binance.com/fapi/v1/klines"
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "cache")
FIXTURES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "fixtures")
TF_SECONDS = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400}


@dataclass
class Kline:
    t: int  # open time, epoch seconds
    o: float
    h: float
    l: float
    c: float
    v: float
    taker_buy: float

    @property
    def delta(self) -> float:
        """Exchange-true signed volume: taker buys minus taker sells."""
        return 2.0 * self.taker_buy - self.v

    def to_list(self) -> List[float]:
        return [self.t, self.o, self.h, self.l, self.c, self.v, self.taker_buy]

    @classmethod
    def from_list(cls, x: List[float]) -> "Kline":
        return cls(int(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[5]), float(x[6]))

    @classmethod
    def from_binance(cls, k: List) -> "Kline":
        return cls(int(k[0]) // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5]), float(k[9]))


def _get(url: str, retries: int = 2) -> List:
    delay = 0.5
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "institution-terminal/1.0"})
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # network / rate limit
            if attempt == retries - 1:
                raise
            logger.warning("kline fetch failed (%s), retry in %.1fs", e, delay)
            time.sleep(delay)
            delay *= 2
    return []


def fetch_range(symbol: str, interval: str, start: int, end: Optional[int] = None, limit: int = 1500) -> List[Kline]:
    """Fetch closed klines with open time in [start, end) (epoch seconds)."""
    out: List[Kline] = []
    step = TF_SECONDS[interval]
    now = int(time.time())
    end = end or now
    cur = start
    while cur < end:
        url = f"{REST}?symbol={symbol}&interval={interval}&startTime={cur * 1000}&limit={limit}"
        raw = _get(url)
        if not raw:
            break
        batch = [Kline.from_binance(k) for k in raw]
        for k in batch:
            if k.t < end and k.t + step <= now:  # closed bars only
                out.append(k)
        nxt = batch[-1].t + step
        if nxt <= cur:
            break
        cur = nxt
        if len(raw) < limit:
            break
        time.sleep(0.12)  # stay well under Binance weight limits
    return out


def _load_fixture_bars(interval: str) -> List[Kline]:
    """Fallback loader using bundled TradingView XAUUSD fixtures when cache is empty or offline."""
    mapping = {"1m": "tv_xauusd_1m.csv", "5m": "tv_xauusd_5m.csv", "4h": "tv_xauusd_4h.csv"}
    if interval in mapping:
        csv_path = os.path.join(FIXTURES_DIR, mapping[interval])
        if not os.path.exists(csv_path):
            return []
        rows: List[Kline] = []
        with open(csv_path) as fh:
            for r in csv.DictReader(fh):
                t = int(float(r["time"]))
                o, h, l, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
                v = float(r["volume"] or 0.0)
                # Keep taker_buy=0.0 on TV fixtures so runtime uses exact pine_ltf_flows
                rows.append(Kline(t, o, h, l, c, v, 0.0))
        if interval == "5m" and len(rows) > 1:
            rows = rows[:-1]  # drop forming last bar
        return rows
    if interval == "15m":
        five = _load_fixture_bars("5m")
        buckets: Dict[int, List[float]] = {}
        for k in five:
            b = k.t - (k.t % 900)
            if b not in buckets:
                buckets[b] = [k.o, k.h, k.l, k.c, k.v, k.taker_buy]
            else:
                st = buckets[b]
                st[1] = max(st[1], k.h)
                st[2] = min(st[2], k.l)
                st[3] = k.c
                st[4] += k.v
                st[5] += k.taker_buy
        return [Kline(b, *buckets[b]) for b in sorted(buckets)]
    return []


def load_history(symbol: str, interval: str, start: Optional[int] = None, refresh: bool = True,
                 cache_dir: str = CACHE_DIR) -> List[Kline]:
    """Full closed-bar history from ``start`` (default: listing), cached as JSONL per interval."""
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"{symbol}_{interval}.jsonl")
    bars: Dict[int, Kline] = {}
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                try:
                    k = Kline.from_list(json.loads(line))
                    bars[k.t] = k
                except ValueError:
                    continue
    if refresh:
        step = TF_SECONDS[interval]
        full_marker = path + ".full"
        new: List[Kline] = []
        try:
            if bars:
                lo = min(bars)
                want_from = start if start is not None else (None if os.path.exists(full_marker) else 0)
                if want_from is not None and want_from < lo - step:
                    new += fetch_range(symbol, interval, want_from, lo)
            since = (max(bars) + step) if bars else (start or 0)
            new += fetch_range(symbol, interval, since)
            if start is None:
                open(full_marker, "w").close()
        except Exception as e:
            logger.warning("offline or fetch error for %s %s (%s); using cached/fixture history", symbol, interval, e)
        if new:
            with open(path, "a") as fh:
                for k in new:
                    if k.t not in bars:
                        fh.write(json.dumps(k.to_list()) + "\n")
                    bars[k.t] = k
    if not bars:
        fixture_bars = _load_fixture_bars(interval)
        if fixture_bars:
            with open(path, "w") as fh:
                for k in fixture_bars:
                    fh.write(json.dumps(k.to_list()) + "\n")
                    bars[k.t] = k
    out = [bars[t] for t in sorted(bars)]
    if start:
        out = [k for k in out if k.t >= start]
    return out


def fetch_recent(symbol: str, interval: str, limit: int = 1500) -> List[Kline]:
    raw = _get(f"{REST}?symbol={symbol}&interval={interval}&limit={limit}")
    step = TF_SECONDS[interval]
    now = int(time.time())
    return [k for k in (Kline.from_binance(x) for x in raw) if k.t + step <= now]
