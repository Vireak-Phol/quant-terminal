"""Live order-book evidence (T7) and macro provider interface.

Order-flow terms are *tags*, not probability inputs: the displayed probability always comes
from the ledger. Each tag is recorded on the signal so calibration can later measure whether
"A+ with wall support" really outperforms "A+ without" — until then the UI marks the tag as
``unmeasured``. The heuristic log-odds deltas are exposed only to rank concurrent setups.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Protocol, Sequence, Tuple


@dataclass
class OrderflowSnapshot:
    mid: float
    imbalance: float = 0.0  # -1..1 top-5 depth imbalance
    walls: Sequence[Dict] = ()  # {side, price, size, multiple}
    absorptions: Sequence[Dict] = ()  # AbsorptionCandidate.to_dict()
    spread: float = 0.0
    timestamp_ms: int = 0


@dataclass
class OrderflowEvidence:
    tags: List[str] = field(default_factory=list)
    log_odds: float = 0.0
    details: List[Dict] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return asdict(self)


WALL_MIN_MULTIPLE = 2.5
WALL_REACH_ATR = 0.5
IMBALANCE_MIN = 0.15
ABSORPTION_MIN_CONF = 0.6
ABSORPTION_MAX_AGE_MS = 5 * 60 * 1000


def orderflow_evidence(direction: str, snap: Optional[OrderflowSnapshot], atr: Optional[float]) -> OrderflowEvidence:
    ev = OrderflowEvidence()
    if snap is None or snap.mid <= 0 or not atr:
        return ev
    is_long = direction == "LONG"
    reach = WALL_REACH_ATR * atr
    support_side = "bid" if is_long else "ask"
    oppose_side = "ask" if is_long else "bid"
    for w in snap.walls:
        if w.get("multiple", 0) < WALL_MIN_MULTIPLE:
            continue
        d = (snap.mid - w["price"]) if is_long else (w["price"] - snap.mid)
        if w["side"] == support_side and 0 <= d <= reach:
            ev.tags.append("of_wall_support")
            ev.log_odds += 0.35
            ev.details.append({"tag": "of_wall_support", "price": w["price"], "size": w.get("size"), "multiple": w.get("multiple")})
            break
    for w in snap.walls:
        if w.get("multiple", 0) < WALL_MIN_MULTIPLE:
            continue
        d = (w["price"] - snap.mid) if is_long else (snap.mid - w["price"])
        if w["side"] == oppose_side and 0 <= d <= reach:
            ev.tags.append("of_wall_against")
            ev.log_odds -= 0.35
            ev.details.append({"tag": "of_wall_against", "price": w["price"], "size": w.get("size"), "multiple": w.get("multiple")})
            break
    # Absorption: sellers absorbed at bids (aggressive sells, price held) supports longs.
    want = "sell" if is_long else "buy"
    for a in snap.absorptions:
        age = snap.timestamp_ms - int(a.get("timestamp", 0)) if snap.timestamp_ms else 0
        if a.get("side") == want and float(a.get("confidence", 0)) >= ABSORPTION_MIN_CONF and age <= ABSORPTION_MAX_AGE_MS:
            ev.tags.append("of_absorption")
            ev.log_odds += 0.40
            ev.details.append({"tag": "of_absorption", "price": a.get("price"), "confidence": a.get("confidence")})
            break
    imb = snap.imbalance if is_long else -snap.imbalance
    if imb >= IMBALANCE_MIN:
        ev.tags.append("of_imbalance_with")
        ev.log_odds += 0.20
    elif imb <= -IMBALANCE_MIN:
        ev.tags.append("of_imbalance_against")
        ev.log_odds -= 0.20
    return ev


class MacroProvider(Protocol):
    """Supplies cross-asset closes aligned to a chart bar open time."""

    name: str

    def dxy(self, t: int) -> Optional[float]: ...

    def vix(self, t: int) -> Optional[float]: ...


class NeutralMacro:
    """Default provider: no macro data. OSC then applies w_dxy = w_vix = 0 and no risk-off
    threshold shift — exactly the Pine behaviour with those inputs unavailable."""

    name = "neutral"

    def dxy(self, t: int) -> Optional[float]:
        return None

    def vix(self, t: int) -> Optional[float]:
        return None
