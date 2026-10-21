"""
Resting Liquidity Zones Analytics Engine (Bookmap-Inspired).
Identifies, clusters, and tracks the lifecycle of significant resting limit orders.
Supports:
- Multi-criteria thresholding (absolute quantity, notional value, relative multiple of mean).
- Adjacent level aggregation into contiguous zones.
- Stable zone tracking across updates.
- Full lifecycle state machine: active, reduced, removed, replenished, uncertain.
"""

from dataclasses import dataclass, field
from decimal import Decimal
import logging
import time
from typing import Dict, List, Optional, Tuple, Any

logger = logging.getLogger("LiquidityZones")


@dataclass
class ZoneLevelPoint:
    timestamp: int
    quantity: float


@dataclass
class LiquidityZone:
    id: str
    symbol: str
    side: str  # "bid" | "ask"
    price_low: float
    price_high: float
    center_price: float
    displayed_quantity: float
    peak_displayed_quantity: float
    notional_value: float
    first_seen_timestamp: int
    last_updated_timestamp: int
    persistence_duration_ms: int
    status: str  # "active" | "reduced" | "removed" | "replenished" | "uncertain"
    multiple_of_mean: float
    level_count: int
    history: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": "liquidity_zone",
            "id": self.id,
            "symbol": self.symbol,
            "side": self.side,
            "priceLow": str(round(self.price_low, 2)),
            "priceHigh": str(round(self.price_high, 2)),
            "centerPrice": round(self.center_price, 2),
            "displayedQuantity": str(round(self.displayed_quantity, 3)),
            "peakDisplayedQuantity": str(round(self.peak_displayed_quantity, 3)),
            "notionalValue": round(self.notional_value, 2),
            "firstSeenTimestamp": self.first_seen_timestamp,
            "lastUpdatedTimestamp": self.last_updated_timestamp,
            "persistenceDuration": self.persistence_duration_ms,
            "status": self.status,
            "multipleOfMean": round(self.multiple_of_mean, 1),
            "levelCount": self.level_count,
        }


class LiquidityZoneDetector:
    def __init__(
        self,
        symbol: str = "XAUUSDT",
        min_absolute_qty: float = 15.0,  # 15 oz gold (~$60k)
        min_notional_usd: float = 50_000.0,
        min_relative_multiple: float = 2.0,  # 2.0x mean depth
        tick_tolerance: float = 0.05,  # cluster levels within 5 cents
        max_active_zones: int = 20,
        removal_timeout_ms: int = 120_000,  # retain removed zones for 2 minutes
    ):
        self.symbol = symbol
        self.min_absolute_qty = min_absolute_qty
        self.min_notional_usd = min_notional_usd
        self.min_relative_multiple = min_relative_multiple
        self.tick_tolerance = tick_tolerance
        self.max_active_zones = max_active_zones
        self.removal_timeout_ms = removal_timeout_ms

        # Active tracked zones keyed by stable id
        self.tracked_zones: Dict[str, LiquidityZone] = {}

    def _generate_zone_id(self, side: str, price_center: float) -> str:
        # Round center price to tick tolerance bucket to keep ID stable
        bucket = round(round(price_center / (self.tick_tolerance * 2)) * (self.tick_tolerance * 2), 2)
        return f"zone-{side}-{bucket:.2f}"

    def update(
        self,
        bids: Dict[Decimal, Decimal],
        asks: Dict[Decimal, Decimal],
        now_ms: Optional[int] = None,
    ) -> List[LiquidityZone]:
        """
        Analyzes the synchronized order book, detects significant liquidity zones,
        and transitions the lifecycle of existing zones.
        """
        if now_ms is None:
            now_ms = int(time.time() * 1000)

        # 1. Compute statistical baseline of displayed liquidity
        all_sizes = [float(q) for q in bids.values()] + [float(q) for q in asks.values()]
        mean_size = sum(all_sizes) / max(len(all_sizes), 1)

        # 2. Extract significant levels
        sig_bids = self._filter_levels(bids, mean_size, "bid")
        sig_asks = self._filter_levels(asks, mean_size, "ask")

        # 3. Cluster adjacent levels into zones
        candidate_zones: List[LiquidityZone] = []
        candidate_zones.extend(self._cluster_levels(sig_bids, "bid", mean_size, now_ms))
        candidate_zones.extend(self._cluster_levels(sig_asks, "ask", mean_size, now_ms))

        # 4. Lifecycle state machine reconciliation
        active_ids = set()

        for cand in candidate_zones:
            active_ids.add(cand.id)
            if cand.id in self.tracked_zones:
                existing = self.tracked_zones[cand.id]
                prev_qty = existing.displayed_quantity
                curr_qty = cand.displayed_quantity

                existing.last_updated_timestamp = now_ms
                existing.persistence_duration_ms = now_ms - existing.first_seen_timestamp
                existing.displayed_quantity = curr_qty
                existing.peak_displayed_quantity = max(existing.peak_displayed_quantity, curr_qty)
                existing.notional_value = cand.notional_value
                existing.multiple_of_mean = cand.multiple_of_mean
                existing.price_low = cand.price_low
                existing.price_high = cand.price_high
                existing.center_price = cand.center_price
                existing.level_count = cand.level_count

                # Lifecycle state transition
                if existing.status == "removed":
                    existing.status = "replenished"
                elif curr_qty > prev_qty * 1.15:
                    existing.status = "replenished" if existing.status == "reduced" else "active"
                elif curr_qty < prev_qty * 0.85:
                    existing.status = "reduced"
                else:
                    existing.status = "active"

                existing.history.append({"t": now_ms, "q": curr_qty})
                if len(existing.history) > 30:
                    existing.history.pop(0)
            else:
                cand.status = "active"
                cand.history.append({"t": now_ms, "q": cand.displayed_quantity})
                self.tracked_zones[cand.id] = cand

        # 5. Handle disappearing / removed zones
        for zid, zone in list(self.tracked_zones.items()):
            if zid not in active_ids:
                if zone.status != "removed":
                    zone.status = "removed"
                    zone.last_updated_timestamp = now_ms
                    zone.displayed_quantity = 0.0

                # Prune old removed zones beyond timeout
                if now_ms - zone.last_updated_timestamp > self.removal_timeout_ms:
                    del self.tracked_zones[zid]

        # Return sorted active and recently reduced/removed zones
        out = list(self.tracked_zones.values())
        out.sort(key=lambda z: z.displayed_quantity, reverse=True)
        return out[: self.max_active_zones]

    def _filter_levels(
        self, levels: Dict[Decimal, Decimal], mean_size: float, side: str
    ) -> List[Tuple[float, float]]:
        """Filters levels meeting multi-dimensional significance criteria."""
        results = []
        for p_dec, q_dec in levels.items():
            p = float(p_dec)
            q = float(q_dec)
            notional = p * q
            relative_mult = q / max(mean_size, 0.001)

            # Meets at least 2 of 3 criteria or overwhelmingly meets relative multiple
            cond1 = q >= self.min_absolute_qty
            cond2 = notional >= self.min_notional_usd
            cond3 = relative_mult >= self.min_relative_multiple

            if (cond1 and cond2) or cond3 or (cond1 and cond3):
                results.append((p, q))

        # Sort: bids descending, asks ascending
        results.sort(key=lambda x: x[0], reverse=(side == "bid"))
        return results

    def _cluster_levels(
        self,
        filtered_levels: List[Tuple[float, float]],
        side: str,
        mean_size: float,
        now_ms: int,
    ) -> List[LiquidityZone]:
        """Clusters adjacent price levels into contiguous zones."""
        if not filtered_levels:
            return []

        clusters: List[List[Tuple[float, float]]] = []
        current_cluster: List[Tuple[float, float]] = [filtered_levels[0]]

        for i in range(1, len(filtered_levels)):
            prev_p = current_cluster[-1][0]
            curr_p = filtered_levels[i][0]

            if abs(curr_p - prev_p) <= self.tick_tolerance * 1.5:
                current_cluster.append(filtered_levels[i])
            else:
                clusters.append(current_cluster)
                current_cluster = [filtered_levels[i]]
        clusters.append(current_cluster)

        zones: List[LiquidityZone] = []
        for clust in clusters:
            prices = [item[0] for item in clust]
            total_qty = sum(item[1] for item in clust)
            p_low = min(prices)
            p_high = max(prices)
            # Weighted average center price
            center_p = sum(p * q for p, q in clust) / max(total_qty, 0.0001)
            notional = center_p * total_qty
            multiple = total_qty / max(mean_size, 0.001)
            zone_id = self._generate_zone_id(side, center_p)

            zones.append(
                LiquidityZone(
                    id=zone_id,
                    symbol=self.symbol,
                    side=side,
                    price_low=p_low,
                    price_high=p_high,
                    center_price=center_p,
                    displayed_quantity=total_qty,
                    peak_displayed_quantity=total_qty,
                    notional_value=notional,
                    first_seen_timestamp=now_ms,
                    last_updated_timestamp=now_ms,
                    persistence_duration_ms=0,
                    status="active",
                    multiple_of_mean=multiple,
                    level_count=len(clust),
                )
            )

        return zones
