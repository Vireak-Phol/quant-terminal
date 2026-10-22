"""
Microstructure Absorption Engine (DeepChart-Inspired).
Distinguishes aggressive executed trade volume from actual price response.
Analyzes:
- Trade flow volume and aggressor side.
- Rolling volatility and expected price impact.
- Actual price displacement vs. expected displacement.
- Resting liquidity wall proximity and replenishment evidence.
- Multi-factor Bayesian confidence scoring (0.0 to 1.0).
"""

from collections import deque
from dataclasses import dataclass, field
from decimal import Decimal
import logging
import math
import time
from typing import Dict, List, Optional, Tuple, Any

from .liquidity_zones import LiquidityZone

logger = logging.getLogger("AbsorptionEngine")


@dataclass
class AbsorptionCandidate:
    id: str
    symbol: str
    side: str  # "buy" | "sell" (aggressor side absorbed)
    price: float
    executed_quantity: float
    trade_count: int
    price_response: float  # actual price movement during absorption window
    expected_price_response: float
    volatility_at_time: float
    confidence: float  # 0.0 to 1.0
    status: str  # "candidate" | "confirmed"
    timestamp: int
    reason: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": "absorption_candidate",
            "id": self.id,
            "symbol": self.symbol,
            "side": self.side,
            "price": str(round(self.price, 2)),
            "executedQuantity": str(round(self.executed_quantity, 3)),
            "tradeCount": self.trade_count,
            "priceResponse": round(self.price_response, 3),
            "expectedPriceResponse": round(self.expected_price_response, 3),
            "confidence": round(self.confidence, 2),
            "status": self.status,
            "timestamp": self.timestamp,
            "reason": self.reason,
        }


class AbsorptionEngine:
    def __init__(
        self,
        symbol: str = "XAUUSDT",
        window_duration_ms: int = 4000,  # 4-second observation window
        min_confidence: float = 0.50,
        retention_ms: int = 60_000,
        # Regime-normalised thresholds: when a live session baseline is fed via
        # update_session_baseline(), the absolute volume gates below scale by
        # (session_median / global_median). This keeps sensitivity constant across
        # the Asia-thin / NY-open-fat regime switch (audit F4).
        base_min_cluster_vol: float = 10.0,
        base_min_side_vol: float = 12.0,
    ):
        self.symbol = symbol
        self.window_duration_ms = window_duration_ms
        self.min_confidence = min_confidence
        self.retention_ms = retention_ms
        self.base_min_cluster_vol = base_min_cluster_vol
        self.base_min_side_vol = base_min_side_vol

        # Session baseline: rolling distribution of 4-second cluster volume, used to
        # z-normalise the absolute gates. None until enough history has accumulated.
        self._cluster_vol_history: deque = deque(maxlen=500)
        # Timestamp of the last cluster-volume sample recorded into the history
        # above. The history must be sampled at most once per observation window,
        # not on every trade, or a 50 tps burst saturates the 500-slot deque with
        # near-identical overlapping slices and corrupts _global_median(). (Audit #4)
        self._last_cluster_record_ms: int = 0
        self._vol_scale = 1.0   # multiplicative scale on volume gates
        self._window_scale = 1.0  # multiplicative scale on observation window

        # Rolling trades buffer (timestamp_ms, price, qty, aggressor_side)
        self.trades_buffer: deque = deque(maxlen=2000)
        # Price history for local volatility calculation
        self.price_history: deque = deque(maxlen=300)
        # Active absorption candidates
        self.active_candidates: Dict[str, AbsorptionCandidate] = {}

    # ── Regime normalisation (audit F4) ─────────────────────────────────────
    def update_session_baseline(self, median_cluster_vol: float, typical_window_ms: Optional[float] = None):
        """Feed a live estimate of the session's typical 4-second cluster volume.

        The gates scale in inverse proportion to how *thin* the current session is
        relative to the long-run median: a quiet Asia session lowers the absolute
        volume gates so absorption is still detectable, and a hot NY session raises
        them so noise clusters stop firing. ``typical_window_ms`` widens/narrows the
        observation window the same way (thinner tape needs a longer look).
        """
        if median_cluster_vol <= 0:
            return
        global_med = self._global_median()
        if global_med <= 0:
            # First observation: adopt it as the initial global anchor.
            self._cluster_vol_history.append(median_cluster_vol)
            return
        ratio = median_cluster_vol / global_med
        # Clamp so a single dead or manic print cannot whipsaw the gates.
        ratio = max(0.5, min(2.0, ratio))
        # Scale gates WITH the session: thin session (ratio<1) lowers the absolute
        # volume gates so absorption is still detectable on thin tape; a fat NY
        # session raises them so noise clusters stop firing.
        self._vol_scale = ratio
        if typical_window_ms and typical_window_ms > 0:
            w_ratio = typical_window_ms / 4000.0
            self._window_scale = max(0.75, min(1.5, w_ratio))
        self._cluster_vol_history.append(median_cluster_vol)

    def _global_median(self) -> float:
        if not self._cluster_vol_history:
            return 0.0
        s = sorted(self._cluster_vol_history)
        n = len(s)
        return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])

    @property
    def effective_window_ms(self) -> int:
        return int(self.window_duration_ms * self._window_scale)

    @property
    def effective_min_cluster_vol(self) -> float:
        return self.base_min_cluster_vol * self._vol_scale

    @property
    def effective_min_side_vol(self) -> float:
        return self.base_min_side_vol * self._vol_scale

    def ingest_price(self, price: float, timestamp_ms: int):
        """Records price tick for volatility estimation."""
        self.price_history.append((timestamp_ms, price))

    def ingest_trade(
        self,
        price: float,
        qty: float,
        aggressor_side: str,  # "buy" or "sell"
        timestamp_ms: int,
        resting_zones: Optional[List[LiquidityZone]] = None,
    ) -> Optional[AbsorptionCandidate]:
        """
        Ingests an executed trade, updates the observation window,
        and evaluates candidate absorption.
        """
        self.trades_buffer.append({
            "t": timestamp_ms,
            "p": price,
            "q": qty,
            "side": aggressor_side,
        })
        self.ingest_price(price, timestamp_ms)

        # Evaluate window
        candidate = self._evaluate_window(timestamp_ms, resting_zones or [])
        if candidate and candidate.confidence >= self.min_confidence:
            self.active_candidates[candidate.id] = candidate
            return candidate
        return None

    def get_recent_candidates(self, now_ms: Optional[int] = None) -> List[AbsorptionCandidate]:
        """Returns non-expired absorption candidates."""
        if now_ms is None:
            now_ms = int(time.time() * 1000)

        # Prune older than retention_ms
        for cid, cand in list(self.active_candidates.items()):
            if now_ms - cand.timestamp > self.retention_ms:
                del self.active_candidates[cid]

        candidates = list(self.active_candidates.values())
        candidates.sort(key=lambda c: c.timestamp, reverse=True)
        return candidates

    def _calculate_local_volatility(self) -> float:
        """Computes rolling price standard deviation or tick range over recent history."""
        if len(self.price_history) < 10:
            return 0.15  # baseline gold 0.15 USD spread/volatility

        prices = [p for _, p in self.price_history]
        mean = sum(prices) / len(prices)
        variance = sum((p - mean) ** 2 for p in prices) / len(prices)
        return max(math.sqrt(variance), 0.05)

    def _evaluate_window(
        self,
        current_time_ms: int,
        resting_zones: List[LiquidityZone],
    ) -> Optional[AbsorptionCandidate]:
        """
        Evaluates whether executed trades in the window qualify as absorption:
        1. Substantial volume aggregated in window.
        2. Dominant aggressor direction (e.g. >= 70% buys or sells).
        3. Stalled price movement relative to expected impact.
        4. Supporting evidence from resting liquidity walls.
        """
        window_start = current_time_ms - self.effective_window_ms
        window_trades = [t for t in self.trades_buffer if t["t"] >= window_start]

        if len(window_trades) < 4:
            return None

        total_vol = sum(t["q"] for t in window_trades)
        buy_vol = sum(t["q"] for t in window_trades if t["side"] == "buy")
        sell_vol = sum(t["q"] for t in window_trades if t["side"] == "sell")

        # Regime-scaled cluster gate (replaces fixed 10 oz; audit F4).
        if total_vol < self.effective_min_cluster_vol:
            return None

        # Record the observed cluster volume so the session baseline can adapt —
        # but at most once per (non-overlapping) observation window. Recording on
        # every qualifying trade would wipe the multi-hour anchor within seconds
        # under a high-frequency burst. (Audit #4)
        if current_time_ms - self._last_cluster_record_ms >= self.effective_window_ms:
            self._cluster_vol_history.append(total_vol)
            self._last_cluster_record_ms = current_time_ms

        # Check for directional dominance
        buy_ratio = buy_vol / total_vol
        sell_ratio = sell_vol / total_vol

        prices = [t["p"] for t in window_trades]
        start_p = prices[0]
        end_p = prices[-1]
        price_delta = end_p - start_p
        price_range = max(prices) - min(prices)
        avg_price = sum(prices) / len(prices)

        local_vol = self._calculate_local_volatility()
        # Expected price displacement without absorption scales with sqrt(volume) * volatility
        expected_displacement = math.sqrt(max(total_vol, 1.0)) * (local_vol * 0.10)

        # 1. Buy Absorption: Aggressive buyers executing heavily, but price does NOT advance
        if buy_ratio >= 0.70 and buy_vol >= self.effective_min_side_vol:
            # Price stalled: price_delta is significantly less than expected
            stall_factor = max(0.0, 1.0 - (max(price_delta, 0.0) / max(expected_displacement, 0.01)))

            # Check if execution occurred at or near a resting ASK zone
            near_ask_zone = False
            zone_multiple = 1.0
            for z in resting_zones:
                if z.side == "ask" and abs(z.center_price - avg_price) <= 0.35:
                    near_ask_zone = True
                    zone_multiple = max(zone_multiple, z.multiple_of_mean)

            # Confidence scoring
            vol_score = min(buy_vol / 40.0, 1.0)
            ratio_score = (buy_ratio - 0.70) / 0.30
            zone_score = min(zone_multiple / 3.0, 1.0) if near_ask_zone else 0.2

            confidence = (vol_score * 0.35) + (stall_factor * 0.40) + (zone_score * 0.25)
            confidence = max(0.0, min(1.0, confidence))

            if confidence >= self.min_confidence:
                cid = f"abs-buy-{int(avg_price * 100)}-{current_time_ms // 2000}"
                return AbsorptionCandidate(
                    id=cid,
                    symbol=self.symbol,
                    side="buy",
                    price=avg_price,
                    executed_quantity=buy_vol,
                    trade_count=len([t for t in window_trades if t["side"] == "buy"]),
                    price_response=round(price_delta, 3),
                    expected_price_response=round(expected_displacement, 3),
                    volatility_at_time=round(local_vol, 3),
                    confidence=confidence,
                    status="confirmed" if confidence >= 0.75 else "candidate",
                    timestamp=current_time_ms,
                    reason=f"{buy_vol:.1f} oz aggressive buy volume absorbed at ask with {price_delta:+.2f} USD response",
                )

        # 2. Sell Absorption: Aggressive sellers executing heavily, but price does NOT decline
        elif sell_ratio >= 0.70 and sell_vol >= self.effective_min_side_vol:
            stall_factor = max(0.0, 1.0 - (max(-price_delta, 0.0) / max(expected_displacement, 0.01)))

            near_bid_zone = False
            zone_multiple = 1.0
            for z in resting_zones:
                if z.side == "bid" and abs(z.center_price - avg_price) <= 0.35:
                    near_bid_zone = True
                    zone_multiple = max(zone_multiple, z.multiple_of_mean)

            vol_score = min(sell_vol / 40.0, 1.0)
            ratio_score = (sell_ratio - 0.70) / 0.30
            zone_score = min(zone_multiple / 3.0, 1.0) if near_bid_zone else 0.2

            confidence = (vol_score * 0.35) + (stall_factor * 0.40) + (zone_score * 0.25)
            confidence = max(0.0, min(1.0, confidence))

            if confidence >= self.min_confidence:
                cid = f"abs-sell-{int(avg_price * 100)}-{current_time_ms // 2000}"
                return AbsorptionCandidate(
                    id=cid,
                    symbol=self.symbol,
                    side="sell",
                    price=avg_price,
                    executed_quantity=sell_vol,
                    trade_count=len([t for t in window_trades if t["side"] == "sell"]),
                    price_response=round(price_delta, 3),
                    expected_price_response=round(expected_displacement, 3),
                    volatility_at_time=round(local_vol, 3),
                    confidence=confidence,
                    status="confirmed" if confidence >= 0.75 else "candidate",
                    timestamp=current_time_ms,
                    reason=f"{sell_vol:.1f} oz aggressive sell volume absorbed at bid with {price_delta:+.2f} USD response",
                )

        return None
