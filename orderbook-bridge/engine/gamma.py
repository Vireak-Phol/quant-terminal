"""Options Gamma Exposure (GEX) Engine for XAU / Gold.

Fetches real-time institutional options data from Cboe (GLD options chain),
computes Black-Scholes dollar gamma per strike, and maps the strikes to spot Gold (XAU)
using the live basis multiplier (XAUUSDT / GLD spot).

Calculates:
  1. Call Wall: Strike with peak positive call gamma (Major institutional resistance magnet)
  2. Put Wall: Strike with peak negative put gamma (Major institutional support floor)
  3. Gamma Flip: Zero-gamma inflection level (+GEX sticky vs -GEX explosive expansion)
  4. Total Market Net GEX ($M) and Regime
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
from datetime import datetime
from typing import Dict, Optional, Tuple

import requests

log = logging.getLogger("engine.gamma")

CBOE_GLD_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/GLD.json"


def _bs_gamma(S: float, K: float, T: float, r: float = 0.045, sigma: float = 0.16) -> float:
    """Standard Black-Scholes gamma: N'(d1) / (S * sigma * sqrt(T))."""
    if T <= 0.001 or sigma <= 0 or S <= 0 or K <= 0:
        return 0.0
    try:
        d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * math.sqrt(T))
        pdf = math.exp(-0.5 * d1**2) / math.sqrt(2 * math.pi)
        return pdf / (S * sigma * math.sqrt(T))
    except Exception:
        return 0.0


class GammaEngine:
    def __init__(self, cache_ttl_sec: int = 1800):
        self.cache_ttl = cache_ttl_sec
        self._last_fetch_time = 0.0
        self._cached_gld_data: Optional[Dict] = None
        self._lock = threading.Lock()
        self._cached_result: Optional[Dict] = None

    def fetch_gld_options_chain(self) -> Optional[Dict]:
        """Fetch raw options chain from Cboe."""
        headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
        try:
            resp = requests.get(CBOE_GLD_URL, headers=headers, timeout=10)
            if resp.status_code == 200:
                payload = resp.json()
                if "data" in payload and "options" in payload["data"]:
                    return payload["data"]
            log.warning("Cboe GLD fetch returned status %d", resp.status_code)
        except Exception as e:
            log.warning("Failed to fetch Cboe GLD options: %s", e)
        return None

    def compute_gamma_levels(self, xau_price: float) -> Dict:
        """Compute Call Wall, Put Wall, Gamma Flip, and Net GEX mapped to XAU."""
        now_ts = time.time()

        with self._lock:
            # Check cache validity
            if (
                self._cached_result
                and (now_ts - self._last_fetch_time) < self.cache_ttl
                and self._cached_gld_data
            ):
                # Update strikes dynamically with the latest XAU price basis
                gld_spot = float(self._cached_gld_data.get("current_price") or 360.0)
                ratio = xau_price / gld_spot if gld_spot > 0 else 10.9
                res = dict(self._cached_result)
                res["call_wall"] = round(res["call_wall_gld"] * ratio, 2)
                res["put_wall"] = round(res["put_wall_gld"] * ratio, 2)
                res["gamma_flip"] = round(res["gamma_flip_gld"] * ratio, 2)
                return res

        # Need fresh data
        data = self.fetch_gld_options_chain()
        if not data:
            if self._cached_result:
                return self._cached_result
            # Fallback to empirical nearest round psychological gold strikes
            step = 50.0
            anchor = round(xau_price / step) * step
            return {
                "call_wall": round(anchor + 50.0, 2),
                "put_wall": round(anchor - 50.0, 2),
                "gamma_flip": round(anchor, 2),
                "call_wall_gld": (anchor + 50.0) / 10.9,
                "put_wall_gld": (anchor - 50.0) / 10.9,
                "gamma_flip_gld": anchor / 10.9,
                "net_gex_usd": 0.0,
                "regime": "NEUTRAL",
                "net_gex_label": "0.0M",
            }

        gld_spot = float(data.get("current_price") or 360.0)
        ratio = xau_price / gld_spot if gld_spot > 0 else 10.9
        now = datetime.now()

        strikes: Dict[float, Dict[str, float]] = {}
        for opt in data.get("options", []):
            name = opt.get("option", "")
            m = re.match(r"GLD(\d{2})(\d{2})(\d{2})([CP])(\d{8})", name)
            if not m:
                continue
            yy, mm, dd, cp, k_raw = m.groups()
            try:
                exp = datetime(2000 + int(yy), int(mm), int(dd), 16, 0)
                dte = (exp - now).total_seconds() / 86400.0
                # Focus on active institutional trading horizon: front expirations (<= 60 DTE) and within 12% of spot
                if dte <= 0 or dte > 60:
                    continue
                T = dte / 365.0
                K = int(k_raw) / 1000.0
                if abs(K - gld_spot) / gld_spot > 0.12:
                    continue
                oi = float(opt.get("open_interest") or 0.0)
                if oi <= 0:
                    continue
                iv = float(opt.get("iv") or 0.0)
                if iv <= 0.01 or iv > 1.5:
                    iv = 0.16

                g = _bs_gamma(gld_spot, K, T, 0.045, iv)
                dollar_gamma = g * (gld_spot**2) * 0.01 * 100 * oi

                if K not in strikes:
                    strikes[K] = {"call_gex": 0.0, "put_gex": 0.0}
                if cp == "C":
                    strikes[K]["call_gex"] += dollar_gamma
                else:
                    strikes[K]["put_gex"] += dollar_gamma
            except Exception:
                continue

        if not strikes:
            step = 50.0
            anchor = round(xau_price / step) * step
            return {
                "call_wall": round(anchor + 50.0, 2),
                "put_wall": round(anchor - 50.0, 2),
                "gamma_flip": round(anchor, 2),
                "call_wall_gld": (anchor + 50.0) / 10.9,
                "put_wall_gld": (anchor - 50.0) / 10.9,
                "gamma_flip_gld": anchor / 10.9,
                "net_gex_usd": 0.0,
                "regime": "NEUTRAL",
                "net_gex_label": "0.0M",
            }

        call_wall_gld = max(strikes.keys(), key=lambda k: strikes[k]["call_gex"])
        put_wall_gld = max(strikes.keys(), key=lambda k: strikes[k]["put_gex"])

        sorted_k = sorted(strikes.keys())
        net_by_k = [(k, strikes[k]["call_gex"] - strikes[k]["put_gex"]) for k in sorted_k]
        total_net = sum(x[1] for x in net_by_k)

        flip_k = None
        cum = 0.0
        for k, net in net_by_k:
            cum += net
            if cum >= 0 and flip_k is None:
                flip_k = k

        flip_k = flip_k or gld_spot
        regime = "POSITIVE_GEX" if total_net > 0 else "NEGATIVE_GEX"
        label = f"{total_net/1e6:+.1f}M"

        result = {
            "call_wall": round(call_wall_gld * ratio, 2),
            "put_wall": round(put_wall_gld * ratio, 2),
            "gamma_flip": round(flip_k * ratio, 2),
            "call_wall_gld": call_wall_gld,
            "put_wall_gld": put_wall_gld,
            "gamma_flip_gld": flip_k,
            "net_gex_usd": round(total_net, 2),
            "regime": regime,
            "net_gex_label": label,
        }

        with self._lock:
            self._cached_gld_data = data
            self._cached_result = result
            self._last_fetch_time = now_ts

        log.info(
            "GEX updated: Call Wall=%.2f, Put Wall=%.2f, Flip=%.2f, Net GEX=%s (%s)",
            result["call_wall"],
            result["put_wall"],
            result["gamma_flip"],
            label,
            regime,
        )
        return result


# Singleton instance
_GLOBAL_GAMMA_ENGINE: Optional[GammaEngine] = None


def get_gamma_engine() -> GammaEngine:
    global _GLOBAL_GAMMA_ENGINE
    if _GLOBAL_GAMMA_ENGINE is None:
        _GLOBAL_GAMMA_ENGINE = GammaEngine()
    return _GLOBAL_GAMMA_ENGINE
