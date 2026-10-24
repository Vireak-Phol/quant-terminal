"""Risk engine (T8): turn a directional signal into an executable, sized trade plan.

Defaults (approved): 100 USDT equity, 1% risk, Binance XAUUSDT perp, taker 0.05% per side
plus 1 tick slippage, 10x leverage cap, session-sigma stops (OSC §6 multipliers) moved
behind a resting order-book wall when one sits within 0.5 ATR of the stop.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Sequence

CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "config.json")


@dataclass
class RiskConfig:
    account_equity: float = 100.0
    risk_pct: float = 1.0
    taker_fee_rate: float = 0.0005  # per side
    slippage_ticks: int = 1  # per round trip
    tick_size: float = 0.01
    qty_step: float = 0.001
    min_qty: float = 0.001
    leverage_cap: float = 10.0
    sl_mult: float = 1.5  # x session sigma
    tp1_mult: float = 2.0
    tp2_mult: float = 3.5
    min_risk_atr: float = 0.5  # 1R floor in ATR
    wall_anchor_atr: float = 0.5
    wall_buffer_ticks: int = 5
    horizon_bars: int = 20
    max_trades_per_day: int = 5
    daily_loss_limit_r: float = 3.0
    max_consecutive_losses: int = 3
    cost_heavy_r: float = 0.30  # flag plans whose round-trip cost exceeds this share of 1R

    @classmethod
    def load(cls, path: str = CONFIG_PATH, section: str = "risk", defaults: Optional[Dict] = None) -> "RiskConfig":
        """Load ``section`` from config.json on top of venue ``defaults`` (e.g. OANDA's
        zero-commission / spread-cost model). Saved values always win."""
        try:
            with open(path) as fh:
                raw = json.load(fh).get(section, {})
        except (OSError, ValueError):
            raw = {}
        return cls.from_dict({**(defaults or {}), **raw})

    @classmethod
    def from_dict(cls, raw: Dict) -> "RiskConfig":
        base = cls()
        known = {k: v for k, v in raw.items() if k in base.__dataclass_fields__}
        cfg = cls(**{**asdict(base), **known})
        cfg.validate()
        return cfg

    def validate(self) -> None:
        if not (0 < self.risk_pct <= 10):
            raise ValueError("risk_pct must be in (0, 10]")
        if self.account_equity <= 0:
            raise ValueError("account_equity must be > 0")
        if self.leverage_cap <= 0:
            raise ValueError("leverage_cap must be > 0")
        for k in ("sl_mult", "tp1_mult", "tp2_mult"):
            if getattr(self, k) <= 0:
                raise ValueError(f"{k} must be > 0")
        if self.horizon_bars < 1:
            raise ValueError("horizon_bars must be >= 1")

    def save(self, path: str = CONFIG_PATH, section: str = "risk") -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data: Dict = {}
        try:
            with open(path) as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            pass
        data[section] = asdict(self)
        tmp = path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, path)

    def round_trip_cost(self, price: float) -> float:
        """Per-unit (per oz) round-trip friction in price terms."""
        return price * self.taker_fee_rate * 2.0 + self.slippage_ticks * self.tick_size


@dataclass
class TradePlan:
    direction: str  # LONG | SHORT
    entry: float
    stop: float
    tp1: float
    tp2: float
    risk_per_unit: float
    cost_per_unit: float
    cost_r: float
    rr_tp1: float
    rr_tp2: float
    qty: float
    notional: float
    leverage: float
    risk_usd: float
    stop_basis: str  # session_sigma | atr | wall
    wall_price: Optional[float] = None
    flags: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return asdict(self)


def _floor_step(x: float, step: float) -> float:
    return math.floor(x / step + 1e-9) * step


def build_plan(
    direction: str,
    entry: float,
    session_vol: Optional[float],
    atr: Optional[float],
    cfg: RiskConfig,
    walls: Sequence[Dict] = (),
) -> Optional[TradePlan]:
    """Build a trade plan. ``walls`` are bridge resting walls: {side: bid|ask, price, size, multiple}."""
    if entry <= 0 or (session_vol is None and atr is None):
        return None
    is_long = direction == "LONG"
    unit = session_vol if (session_vol is not None and session_vol > 0) else atr
    basis = "session_sigma" if unit is session_vol else "atr"
    floor_r = (atr or unit) * cfg.min_risk_atr
    risk = max(cfg.sl_mult * unit, floor_r, cfg.tick_size * 10)
    stop = entry - risk if is_long else entry + risk
    wall_price = None
    flags: List[str] = []

    # Wall anchoring: a protective-side wall near the stop absorbs the stop run; put the
    # stop just beyond it instead of in front of it.
    if walls and atr:
        side = "bid" if is_long else "ask"
        reach = cfg.wall_anchor_atr * atr
        cands = [w for w in walls if w.get("side") == side and (
            (is_long and stop - reach <= w["price"] < entry) or ((not is_long) and entry < w["price"] <= stop + reach))]
        if cands:
            w = max(cands, key=lambda x: x.get("size", 0))
            buf = cfg.wall_buffer_ticks * cfg.tick_size
            new_stop = w["price"] - buf if is_long else w["price"] + buf
            new_risk = abs(entry - new_stop)
            if floor_r <= new_risk <= risk * 1.5:
                stop, risk, basis, wall_price = new_stop, new_risk, "wall", w["price"]

    tp1 = entry + cfg.tp1_mult * unit if is_long else entry - cfg.tp1_mult * unit
    tp2 = entry + cfg.tp2_mult * unit if is_long else entry - cfg.tp2_mult * unit
    cost = cfg.round_trip_cost(entry)
    budget = cfg.account_equity * cfg.risk_pct / 100.0
    qty = _floor_step(budget / (risk + cost), cfg.qty_step)
    max_qty = _floor_step(cfg.account_equity * cfg.leverage_cap / entry, cfg.qty_step)
    if qty > max_qty:
        qty = max_qty
        flags.append("leverage_capped")
    if qty < cfg.min_qty:
        qty = cfg.min_qty
        if qty * (risk + cost) > budget * 1.0001:
            flags.append("oversize")
    if cost / risk > cfg.cost_heavy_r:
        flags.append("cost_heavy")  # fees+slippage eat a large share of 1R
    risk_usd = qty * (risk + cost)
    r = lambda d: round(d, 2)  # noqa: E731
    return TradePlan(
        direction=direction, entry=r(entry), stop=r(stop), tp1=r(tp1), tp2=r(tp2),
        risk_per_unit=round(risk, 4), cost_per_unit=round(cost, 4), cost_r=round(cost / risk, 4),
        rr_tp1=round(abs(tp1 - entry) / risk, 2), rr_tp2=round(abs(tp2 - entry) / risk, 2),
        qty=round(qty, 3), notional=round(qty * entry, 2), leverage=round(qty * entry / cfg.account_equity, 2),
        risk_usd=round(risk_usd, 2), stop_basis=basis, wall_price=wall_price, flags=flags,
    )
