"""Live engine hub (T11): warm-up from history, then evaluate every newly closed bar.

Closed bars are taken from the venue REST API shortly after each boundary (poll every
2 s, only fetching when a boundary has passed). ``engine.data`` routes by symbol:
Binance (XAUUSDT) or OANDA (XAU_USD). REST is used instead of an extra stream so the
provider's depth/trade stream stays untouched.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Callable, Dict, List, Optional

from .calibration import Calibrator
from .data import TF_SECONDS, Kline, fetch_recent, load_history
from .ledger import Ledger
from .orderflow import OrderflowSnapshot
from .risk import RiskConfig
from .runtime import EngineSignal, TimeframeEngine, guardrails, group_intrabars

log = logging.getLogger("engine.live")

WARMUP_DAYS = 30


class LiveHub:
    def __init__(self, symbol: str = "XAUUSDT", tfs=("5m", "15m"), ledger: Optional[Ledger] = None,
                 snapshot_fn: Optional[Callable[[], Optional[OrderflowSnapshot]]] = None,
                 on_signal: Optional[Callable[[EngineSignal], None]] = None,
                 risk_section: str = "risk", risk_defaults: Optional[Dict] = None):
        self.symbol = symbol
        self.tfs = list(tfs)
        self.ledger = ledger or Ledger()
        self.cal = Calibrator(self.ledger)
        self.risk_section = risk_section
        self.risk_defaults = dict(risk_defaults or {})
        self.risk = RiskConfig.load(section=risk_section, defaults=self.risk_defaults)
        self.snapshot_fn = snapshot_fn
        self.on_signal = on_signal
        self.engines: Dict[str, TimeframeEngine] = {
            tf: TimeframeEngine(tf, symbol, self.ledger, self.cal, self.risk, source="live") for tf in self.tfs}
        self.one_min: Dict[int, Kline] = {}
        self.last_4h: Optional[int] = None
        self.status = "warming_up"
        self.error: Optional[str] = None
        self.version = 0  # bumps whenever a frame changes
        # Engine state is mutated in executor threads; UI reads take the lock non-blocking.
        self.lock = threading.RLock()

    # ── warm-up ─────────────────────────────────────────────────────────────
    def warmup(self) -> None:
        start = int(time.time()) - WARMUP_DAYS * 86400
        h4 = load_history(self.symbol, "4h", start=start - 60 * 86400)
        one = load_history(self.symbol, "1m", start=start)
        for b in one[-3000:]:
            self.one_min[b.t] = b
        for tf, eng in self.engines.items():
            chart = load_history(self.symbol, tf, start=start)
            ib = group_intrabars(chart, TF_SECONDS[tf], one)
            with self.lock:
                self._replay(eng, chart, ib, h4)
            log.info("warm-up %s: %d bars, last=%s", tf, len(chart), chart[-1].t if chart else None)
        for k in h4:
            self.last_4h = k.t
        self.status = "live"
        self.version += 1

    @staticmethod
    def _replay(eng: TimeframeEngine, chart, ib, h4) -> None:
        j = 0
        for k in chart:
            while j < len(h4) and h4[j].t + 14400 <= k.t:
                eng.add_htf_bar(h4[j])
                j += 1
            eng.on_bar(k, ib.get(k.t), record=False)  # never record during warm-up
        # signals from warm-up are history, not live alerts
        for s in eng.signals:
            s.status = "history"

    # ── live step ───────────────────────────────────────────────────────────
    def step(self) -> List[EngineSignal]:
        new_1m = fetch_recent(self.symbol, "1m", 30)
        new_4h = fetch_recent(self.symbol, "4h", 3)
        chart_new = {tf: fetch_recent(self.symbol, tf, 5) for tf in self.engines}
        with self.lock:
            return self._apply(new_1m, new_4h, chart_new)

    def _apply(self, new_1m, new_4h, chart_new) -> List[EngineSignal]:
        for b in new_1m:
            self.one_min[b.t] = b
        if len(self.one_min) > 4000:
            for t in sorted(self.one_min)[:-3000]:
                del self.one_min[t]
        for k in new_4h:
            if self.last_4h is None or k.t > self.last_4h:
                for eng in self.engines.values():
                    eng.add_htf_bar(k)
                self.last_4h = k.t
        emitted: List[EngineSignal] = []
        snap = self.snapshot_fn() if self.snapshot_fn else None
        for tf, eng in self.engines.items():
            secs = TF_SECONDS[tf]
            for k in chart_new[tf]:
                if eng.last_t is not None and k.t <= eng.last_t:
                    continue
                intr = [self.one_min[t] for t in range(k.t, k.t + secs, 60) if t in self.one_min]
                sigs = eng.on_bar(k, intr or None, orderflow=snap, record=True)
                log.info("closed bar %s %s c=%.2f signals=%d", tf, time.strftime('%H:%M', time.gmtime(k.t)), k.c, len(sigs))
                for s in sigs:
                    emitted.append(s)
                    if self.on_signal:
                        try:
                            self.on_signal(s)
                        except Exception:  # alerts must never break the engine
                            log.exception("on_signal callback failed")
                self.version += 1
        return emitted

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, self.warmup)
        except Exception as e:
            self.status, self.error = "error", f"warm-up failed: {e}"
            log.exception("warm-up failed")
            return
        last_boundary = 0
        while True:
            try:
                now = int(time.time())
                boundary = now - (now % 60)
                if boundary > last_boundary and now - boundary >= 2:
                    log.debug("live step @%s", boundary)
                    await asyncio.wait_for(loop.run_in_executor(None, self.step), timeout=45)
                    last_boundary = boundary
                    self.status, self.error = "live", None
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.status, self.error = "degraded", str(e)
                log.warning("live step failed: %s", e)
            await asyncio.sleep(2.0)

    # ── config & frames ─────────────────────────────────────────────────────
    def set_risk(self, raw: Dict) -> RiskConfig:
        cfg = RiskConfig.from_dict({**self.risk.__dict__, **raw})
        with self.lock:
            cfg.save(section=self.risk_section)
            self.risk = cfg
            for eng in self.engines.values():
                eng.risk = cfg
            self.version += 1
        return cfg

    def frame(self, mid: Optional[float] = None) -> Optional[Dict]:
        if not self.lock.acquire(blocking=False):
            return None  # engine busy; caller keeps the previous frame
        try:
            return self._frame(mid)
        finally:
            self.lock.release()

    def _frame(self, mid: Optional[float]) -> Dict:
        return {
            "status": self.status,
            "error": self.error,
            "version": self.version,
            "symbol": self.symbol,
            "frames": {tf: eng.frame(mid) for tf, eng in self.engines.items()},
            "guardrails": guardrails(self.ledger, self.risk),
            "risk": self.risk.__dict__,
            "macro": "neutral",
            "probability_basis": "empirical",
        }

    def ledger_view(self, tf: Optional[str] = None, limit: int = 100) -> Dict:
        with self.lock:
            return self._ledger_view(tf, limit)

    def _ledger_view(self, tf: Optional[str], limit: int) -> Dict:
        return {
            "type": "ledger",
            "summary": {"backtest": self.cal.summary("backtest", tf), "live": self.cal.summary("live", tf)},
            "reliability": {t: self.cal.reliability("backtest", t) for t in self.tfs},
            "recent": [r.to_dict() for r in self.ledger.recent(limit, source="live", tf=tf)],
            "counts": {"backtest": self.ledger.count("backtest"), "live": self.ledger.count("live")},
            "min_samples": self.cal.min_samples,
        }
