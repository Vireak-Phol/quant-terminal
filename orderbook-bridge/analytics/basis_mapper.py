"""
Cross-Venue Basis Mapper — COMEX GC ↔ Binance XAUUSDT.

Institutional gold levels are often discovered on CME COMEX Gold Futures (GC),
but this terminal charts Binance XAUUSDT perpetual. The two trade at a
cost-of-carry / EFP basis that drifts intraday. This mapper maintains a
real-time EMA of the basis spread (GC − XAUUSDT) so a GC price level can be
translated onto XAUUSDT chart coordinates, and exposes a z-score of the
instantaneous spread versus its EMA as a lead-lag / arbitrage-stretch signal.

Net-new capability: no cross-venue basis logic exists elsewhere in the repo.
Follows repo conventions: pure-Python, deterministic, :meth:`to_dict` for the
bridge, prices emitted as rounded strings.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any, Dict, Optional

import logging

logger = logging.getLogger("CrossVenueBasisMapper")


@dataclass
class CrossVenueBasisMapper:
    """Track the EMA cost-of-carry basis between COMEX GC and Binance XAUUSDT.

    Call :meth:`update_quotes` with fresh mid prices from both venues, then use
    :meth:`map_gc_level_to_xauusdt` to project a GC level onto XAUUSDT and
    :meth:`get_basis_zscore` for the lead-lag stretch indicator.
    """

    ema_alpha: float = 0.05

    def __post_init__(self) -> None:
        if not (0.0 < self.ema_alpha <= 1.0):
            raise ValueError(f"ema_alpha must be in (0, 1], got {self.ema_alpha}")
        self.ema_basis: Optional[float] = None
        self.ema_var: float = 0.0
        self.latest_gc_mid: float = 0.0
        self.latest_xauusdt_mid: float = 0.0

    def update_quotes(self, gc_mid: float, xauusdt_mid: float) -> float:
        """Ingest fresh mids; return the updated EMA basis (GC − XAUUSDT)."""
        self.latest_gc_mid = gc_mid
        self.latest_xauusdt_mid = xauusdt_mid
        raw_basis = gc_mid - xauusdt_mid

        if self.ema_basis is None:
            self.ema_basis = raw_basis
            self.ema_var = 0.0
        else:
            diff = raw_basis - self.ema_basis
            self.ema_basis += self.ema_alpha * diff
            # EWMA of variance (West's incremental form) for the z-score.
            self.ema_var = (1.0 - self.ema_alpha) * (self.ema_var + self.ema_alpha * diff * diff)
        return self.ema_basis

    def map_gc_level_to_xauusdt(self, gc_price: float) -> float:
        """Translate a COMEX GC price level onto Binance XAUUSDT coordinates."""
        if self.ema_basis is None:
            return round(gc_price, 2)
        return round(gc_price - self.ema_basis, 2)

    def map_xauusdt_level_to_gc(self, xauusdt_price: float) -> float:
        """Translate a Binance XAUUSDT level onto COMEX GC coordinates."""
        if self.ema_basis is None:
            return round(xauusdt_price, 2)
        return round(xauusdt_price + self.ema_basis, 2)

    def get_basis_zscore(self) -> float:
        """How many std-devs the instantaneous spread has stretched from its EMA."""
        if self.ema_basis is None or self.ema_var <= 1e-8:
            return 0.0
        raw_basis = self.latest_gc_mid - self.latest_xauusdt_mid
        return (raw_basis - self.ema_basis) / math.sqrt(self.ema_var)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": "cross_venue_basis",
            "gcMid": str(round(self.latest_gc_mid, 2)),
            "xauusdtMid": str(round(self.latest_xauusdt_mid, 2)),
            "emaBasis": None if self.ema_basis is None else round(self.ema_basis, 2),
            "basisZScore": round(self.get_basis_zscore(), 3),
        }
