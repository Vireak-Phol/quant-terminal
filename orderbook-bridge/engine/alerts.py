"""Signal alerts (T14): Telegram push for new A+ signals.

Opt-in: only active when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set (environment or
the git-ignored repo-root ``.env``). Sends only signal details — no account data, no
order-book dumps. Delivery runs on a background thread with retry/backoff, one message per
signal id, and a global minimum spacing so a burst cannot spam the chat. The token is
never logged.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
import urllib.parse
import urllib.request
from typing import Callable, Dict, Optional, Set

log = logging.getLogger("engine.alerts")

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".env")


def read_env_file(path: str = ENV_PATH) -> Dict[str, str]:
    out: Dict[str, str] = {}
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def format_signal(sig) -> str:
    d = sig if isinstance(sig, dict) else sig.to_dict()
    p = d.get("plan", {})
    prob = d.get("probability", {}) or {}
    st = prob.get("stat") or {}
    arrow = "🟢 LONG" if d["direction"] == "LONG" else "🔴 SHORT"
    tier = {"A_PLUS": "A+", "STRUCTURAL": "Structural", "TRAP": "Trap"}.get(d["tier"], d["tier"])
    if prob.get("status") == "measured" and st:
        pr = (f"Measured win rate {st['win_rate']:.1f}% (95% CI {st['ci_lo']:.0f}–{st['ci_hi']:.0f}%, n={st['n']}, "
              f"{prob.get('source')}) · E[R] {st['expectancy_r']:+.2f}")
    else:
        n = st.get("n", 0) if st else 0
        pr = f"Win rate: warm-up (n={n}/{prob.get('min_samples', 15)}) — not yet measured"
    lines = [
        f"{arrow} · {tier} · XAUUSDT {d['tf']}",
        f"Setup: {d['setup']}",
        f"Entry {p.get('entry')} · SL {p.get('stop')} · TP1 {p.get('tp1')} · TP2 {p.get('tp2')}",
        f"Size {p.get('qty')} oz · risk ${p.get('risk_usd')} · R:R {p.get('rr_tp1')}",
        pr,
    ]
    if p.get("flags"):
        lines.append("⚠ " + ", ".join(p["flags"]))
    lines.append("Signal only — not financial advice.")
    return "\n".join(lines)


class AlertDispatcher:
    def __init__(self, token: Optional[str] = None, chat_id: Optional[str] = None, tiers=("A_PLUS",),
                 min_spacing_s: float = 3.0, sender: Optional[Callable[[str], None]] = None):
        self.token = token
        self.chat_id = chat_id
        self.tiers = set(tiers)
        self.min_spacing_s = min_spacing_s
        self.sent_ids: Set[str] = set()
        self._q: "queue.Queue[str]" = queue.Queue(maxsize=100)
        self._sender = sender or self._send_telegram
        self._last_send = 0.0
        self._thread: Optional[threading.Thread] = None
        self.enabled = bool(sender) or bool(token and chat_id)
        if self.enabled:
            self._thread = threading.Thread(target=self._worker, name="alerts", daemon=True)
            self._thread.start()

    @classmethod
    def from_env(cls) -> "AlertDispatcher":
        f = read_env_file()
        tok = os.environ.get("TELEGRAM_BOT_TOKEN") or f.get("TELEGRAM_BOT_TOKEN")
        chat = os.environ.get("TELEGRAM_CHAT_ID") or f.get("TELEGRAM_CHAT_ID")
        tiers = (os.environ.get("ALERT_TIERS") or f.get("ALERT_TIERS") or "A_PLUS").split(",")
        d = cls(tok, chat, tiers=[t.strip() for t in tiers if t.strip()])
        log.info("Telegram alerts %s", "enabled" if d.enabled else "disabled (no TELEGRAM_BOT_TOKEN/CHAT_ID)")
        return d

    def on_signal(self, sig) -> bool:
        """Queue an alert. Returns True if queued."""
        d = sig if isinstance(sig, dict) else sig.to_dict()
        if not self.enabled or d.get("tier") not in self.tiers or d["id"] in self.sent_ids:
            return False
        self.sent_ids.add(d["id"])
        if len(self.sent_ids) > 5000:
            self.sent_ids = set(list(self.sent_ids)[-2000:])
        try:
            self._q.put_nowait(format_signal(d))
            return True
        except queue.Full:
            log.warning("alert queue full; dropping alert %s", d["id"])
            return False

    def _worker(self) -> None:
        while True:
            text = self._q.get()
            wait = self.min_spacing_s - (time.time() - self._last_send)
            if wait > 0:
                time.sleep(wait)
            delay = 1.0
            for attempt in range(4):
                try:
                    self._sender(text)
                    break
                except Exception as e:
                    # never include the URL (it contains the token)
                    log.warning("alert send failed (attempt %d): %s", attempt + 1, type(e).__name__)
                    time.sleep(delay)
                    delay *= 2
            self._last_send = time.time()
            self._q.task_done()

    def _send_telegram(self, text: str) -> None:
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        body = urllib.parse.urlencode({"chat_id": self.chat_id, "text": text, "disable_web_page_preview": "true"}).encode()
        req = urllib.request.Request(url, data=body, method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.loads(r.read().decode())
            if not resp.get("ok"):
                raise RuntimeError("telegram rejected message")

    def flush(self, timeout: float = 5.0) -> None:
        end = time.time() + timeout
        while self._q.unfinished_tasks and time.time() < end:
            time.sleep(0.02)
