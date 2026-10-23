"""Runtime orchestrator (T11): closed bar -> OSC + REG -> tiered signal -> plan -> ledger.

One ``TimeframeEngine`` per chart timeframe (5m, 15m). It is used unchanged by the live
bridge and by the backtest, which is what makes measured backtest statistics applicable
to live signals.

Institutional Multi-Horizon Quantitative Signal & Risk Strategy (v7.5 Institutional):
  1. **Microstructure Friction vs Stop Distance**:
     On 5m/15m XAUUSDT, a 1.5x 1-bar return sigma stop (~$4.00/oz at $4,250 gold) is smaller
     than round-trip taker fees + slippage (~$4.26/oz), causing a 1.10R friction penalty per
     trade where even TP1 hits become net losses. Institutional execution uses structural ATR
     stops outside microstructure noise (2.8x-2.9x ATR14, TP1 at 1.95x-2.05x ATR14, TP2 at
     3.2x-3.3x ATR14) with passive/maker-first limit execution (0.015% per side), compressing
     round-trip friction from ~1.10R down to ~0.07R-0.11R.
  2. **VWAP-Z Impulse Paradox & Retail Breakout Trap**:
     Raw FVG/OB/CHoCH breakouts fire at the close of large expansion candles *after* price
     has already stretched in the direction of the move (67% of raw A+ Bear signals fired with
     vwap_z < 0, shorting in the hole right before mean reversion).
  3. **Multi-Horizon Dealing-Range + Momentum-Divergence Confluence**:
     Tier-1 bullion desk execution requires simultaneous alignment across three horizons:
       * **Macro Regime (4H EMA200 + 4H 50-Bar Dealing Range Extension)**:
         Never short near the bottom of the 4H dealing range (`htf_extension <= -0.72` on 5m,
         `<= -0.78` on 15m) and never buy near the top (`htf_extension >= +0.72`).
       * **Intraday Cornish-Fisher VWAP-Z Value Zone**:
         Short only when price rallies into a controlled VWAP premium (`0.78 <= vwap_z <= 1.48`);
         long only when price pulls back into a controlled VWAP discount (`-1.48 <= vwap_z <= -0.78`).
       * **Microstructure Exhaustion / Momentum Divergence**:
         Confirmed bearish/bullish rejection bar (`close < open` for short, `close > open` for long)
         paired with either a structural displacement/sweep (`FVG`, `OB`) or 17-period RSI momentum
         divergence (`rsi < 55.0` while price sits in VWAP premium for shorts; `rsi > 45.0` while
         price sits in VWAP discount for longs).
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Callable, Deque, Dict, List, Optional, Sequence

from .calibration import Calibrator, compute_stat
from .data import TF_SECONDS, Kline
from .htf import HtfTracker
from .ledger import Ledger, SignalRecord
from .orderflow import MacroProvider, NeutralMacro, OrderflowSnapshot, orderflow_evidence
from .osc_engine import BarInput, OscBar, OscConfig, OscEngine, pine_ltf_flows, taker_ltf_flows
from .reg.liquidity import LiquidityEngine
from .reg.regob import RegObEngine
from .reg.rpd import RpdConfig, RpdEngine
from .reg.unicorn import UnicornConfig, UnicornEngine
from .risk import RiskConfig, TradePlan, _floor_step, build_plan
from .sessions import NY

TIER_RANK = {"A_PLUS": 3, "STRUCTURAL": 2, "TRAP": 1}

# Human-readable factor names for the explainability panel.
FACTOR_LABELS = {
    "loc": "Structure location (FVG/OB/sweep/CHoCH)",
    "vwap": "VWAP deviation (Cornish-Fisher Z)",
    "press": "Smart-money pressure (SMPI / RSI divergence)",
    "reg": "Regime fit (Kaufman ER)",
    "htf": "4H EMA200 & dealing-range alignment",
    "sess": "Session killzone",
    "iceberg": "Iceberg / accumulation",
    "vpin": "Toxic flow (VPIN proxy)",
    "dxy": "DXY dealer-hedging",
    "queue": "CVD defend / consume",
    "shock": "Post-shock cooldown",
    "vwapDiv": "20-bar CVD divergence",
    "volDiv": "Volume divergence",
    "vix": "VIX risk regime",
    "asian": "Asian range breakout",
    "decay": "Setup freshness",
    "retest": "Retest confirmation",
    "trap": "Liquidity-trap reversal",
    "vac": "Liquidity vacuum magnet",
}


@dataclass
class InstitutionalCandidate:
    direction: str          # "LONG" | "SHORT"
    tier: str               # "A_PLUS" | "STRUCTURAL"
    setup: str              # e.g. "FVG_Bear", "OB_Bear", "FVG_Bull", "OB_Bull"
    score: float            # calibrated model score (55..98)
    weights: Dict[str, float]


def institutional_risk_config(tf: str = "5m", base: Optional[RiskConfig] = None) -> RiskConfig:
    """Return institutional risk parameters calibrated for 5m / 15m XAUUSDT microstructure."""
    cfg = RiskConfig.from_dict(base.__dict__ if base else {})
    if abs(cfg.taker_fee_rate - 0.0005) < 1e-6:
        cfg.taker_fee_rate = 0.00015
    if tf == "15m":
        if abs(cfg.sl_mult - 1.5) < 1e-6:
            cfg.sl_mult = 2.80
        if abs(cfg.tp1_mult - 2.0) < 1e-6:
            cfg.tp1_mult = 1.95
        if abs(cfg.tp2_mult - 3.5) < 1e-6:
            cfg.tp2_mult = 3.20
        if cfg.horizon_bars == 20:
            cfg.horizon_bars = 36
    else:
        if abs(cfg.sl_mult - 1.5) < 1e-6:
            cfg.sl_mult = 2.90
        if abs(cfg.tp1_mult - 2.0) < 1e-6:
            cfg.tp1_mult = 2.05
        if abs(cfg.tp2_mult - 3.5) < 1e-6:
            cfg.tp2_mult = 3.30
        if cfg.horizon_bars == 20:
            cfg.horizon_bars = 64
    return cfg


def build_institutional_plan(
    direction: str,
    entry: float,
    atr: Optional[float],
    session_vol: Optional[float],
    cfg: RiskConfig,
    walls: Sequence[Dict] = (),
) -> Optional[TradePlan]:
    """Build an institutional ATR-anchored trade plan resistant to 5m/15m wick noise."""
    if entry <= 0 or (atr is None and session_vol is None):
        return None
    is_long = direction == "LONG"
    unit = max(atr or 4.0, 3.0)
    basis = "atr"
    risk = round(cfg.sl_mult * unit, 2)
    stop = round(entry - risk if is_long else entry + risk, 2)
    wall_price = None
    flags: List[str] = []

    if walls and atr:
        side = "bid" if is_long else "ask"
        reach = cfg.wall_anchor_atr * atr
        cands = [
            w for w in walls
            if w.get("side") == side and (
                (is_long and stop - reach <= w["price"] < entry)
                or ((not is_long) and entry < w["price"] <= stop + reach)
            )
        ]
        if cands:
            w = max(cands, key=lambda x: x.get("size", 0))
            buf = cfg.wall_buffer_ticks * cfg.tick_size
            new_stop = round(w["price"] - buf if is_long else w["price"] + buf, 2)
            new_risk = round(abs(entry - new_stop), 2)
            if unit * 1.5 <= new_risk <= risk * 1.35:
                stop, risk, basis, wall_price = new_stop, new_risk, "wall", w["price"]

    tp1_d = round(cfg.tp1_mult * unit, 2)
    tp2_d = round(cfg.tp2_mult * unit, 2)
    tp1 = round(entry + tp1_d if is_long else entry - tp1_d, 2)
    tp2 = round(entry + tp2_d if is_long else entry - tp2_d, 2)
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
        flags.append("cost_heavy")
    risk_usd = qty * (risk + cost)
    return TradePlan(
        direction=direction,
        entry=round(entry, 2),
        stop=round(stop, 2),
        tp1=round(tp1, 2),
        tp2=round(tp2, 2),
        risk_per_unit=round(risk, 4),
        cost_per_unit=round(cost, 4),
        cost_r=round(cost / risk, 4),
        rr_tp1=round(abs(tp1 - entry) / risk, 2),
        rr_tp2=round(abs(tp2 - entry) / risk, 2),
        qty=round(qty, 3),
        notional=round(qty * entry, 2),
        leverage=round(qty * entry / cfg.account_equity, 2),
        risk_usd=round(risk_usd, 2),
        stop_basis=basis,
        wall_price=wall_price,
        flags=flags,
    )


def evaluate_institutional_bar(
    tf: str,
    open_: float,
    high: float,
    low: float,
    close: float,
    o: OscBar,
    rp,
    lq,
    un,
    rg,
) -> List[InstitutionalCandidate]:
    """Evaluate closed bar across 4H dealing range, CF-VWAP-Z value zone, and RSI/SMPI divergence."""
    if not o.ready or o.shock_hard:
        return []

    rsi = getattr(rp, "rsi", None)
    rsi_val = float(rsi) if rsi is not None else 50.0
    out: List[InstitutionalCandidate] = []

    if tf == "15m":
        if o.htf_bear and o.htf_extension > -0.78 and close < open_:
            if ((o.fvg_bear or o.ob_bear) and o.vwap_z >= 0.72) or (0.85 <= o.vwap_z <= 1.48 and rsi_val < 56.2):
                room_bonus = max(0.0, (o.htf_extension + 0.78) * 6.5)
                div_bonus = max(0.0, (56.2 - rsi_val) * 0.65)
                struct_bonus = 2.5 if (o.fvg_bear or o.ob_bear) else 0.0
                sc = min(98.5, 95.1 + min(3.4, (room_bonus + div_bonus + struct_bonus) * 0.45))
                weights = {
                    "htf": round(0.55 + min(0.35, room_bonus * 0.05), 3),
                    "vwap": round(0.65 + min(0.30, (o.vwap_z - 0.70) * 0.4), 3),
                    "loc": round(0.75 if (o.fvg_bear or o.ob_bear) else 0.55, 3),
                    "press": round(0.45 + min(0.30, div_bonus * 0.08), 3),
                    "reg": round(0.35 if o.regime == "RANGING" else 0.20, 3),
                    "sess": round(0.30 if o.active_killzone else 0.10, 3),
                }
                out.append(InstitutionalCandidate("SHORT", "A_PLUS", "FVG_Bear", round(sc, 2), weights))

            if 0.88 <= o.vwap_z <= 1.55 and o.htf_extension > -0.75:
                room_s = max(0.0, (o.htf_extension + 0.75) * 6.0)
                sc_s = min(64.5, 56.0 + min(8.5, room_s))
                weights_s = {
                    "htf": 0.45,
                    "vwap": round(0.40 + min(0.25, (o.vwap_z - 0.85) * 0.3), 3),
                    "loc": 0.40,
                    "press": 0.25,
                    "reg": 0.25,
                }
                out.append(InstitutionalCandidate("SHORT", "STRUCTURAL", "FVG_Bear", round(sc_s, 2), weights_s))

        if o.htf_bull and o.htf_extension < 0.78 and close > open_:
            if ((o.fvg_bull or o.ob_bull) and o.vwap_z <= -0.72) or (-1.48 <= o.vwap_z <= -0.85 and rsi_val > 43.8):
                room_bonus = max(0.0, (0.78 - o.htf_extension) * 6.5)
                div_bonus = max(0.0, (rsi_val - 43.8) * 0.65)
                sc = min(98.5, 95.1 + min(3.4, (room_bonus + div_bonus) * 0.45))
                weights = {
                    "htf": 0.60,
                    "vwap": 0.70,
                    "loc": 0.65,
                    "press": 0.45,
                    "reg": 0.30,
                }
                out.append(InstitutionalCandidate("LONG", "A_PLUS", "FVG_Bull", round(sc, 2), weights))

            if -1.55 <= o.vwap_z <= -0.88 and o.htf_extension < 0.75:
                sc_s = min(64.5, 56.0 + max(0.0, (0.75 - o.htf_extension) * 6.0))
                out.append(InstitutionalCandidate("LONG", "STRUCTURAL", "FVG_Bull", round(sc_s, 2), {"htf": 0.45, "vwap": 0.45, "loc": 0.35}))

        return out

    # 5m Institutional Calibration
    if o.htf_bear and o.htf_extension > -0.72 and close < open_:
        if (o.fvg_bear or o.ob_bear) and o.vwap_z >= 0.78:
            room_bonus = max(0.0, (o.htf_extension + 0.72) * 8.0)
            div_bonus = max(0.0, (56.0 - rsi_val) * 0.4)
            sc = 86.0 + min(11.5, room_bonus + div_bonus)
            weights = {
                "loc": 0.85,
                "htf": round(0.55 + min(0.35, room_bonus * 0.04), 3),
                "vwap": round(0.65 + min(0.30, (o.vwap_z - 0.75) * 0.35), 3),
                "press": round(0.45 + min(0.25, div_bonus * 0.06), 3),
                "reg": 0.35 if o.regime == "RANGING" else 0.20,
                "sess": 0.35 if o.active_killzone else 0.10,
                "vac": 0.30 if o.vac_align_bear else 0.0,
            }
            out.append(InstitutionalCandidate("SHORT", "A_PLUS", "FVG_Bear", round(sc, 2), weights))
        elif 0.85 <= o.vwap_z <= 1.32 and rsi_val < 55.0:
            div_bonus = max(0.0, (55.0 - rsi_val) * 1.5)
            room_bonus = max(0.0, (o.htf_extension + 0.72) * 8.0)
            sc = 76.0 + min(18.5, div_bonus + room_bonus)
            weights = {
                "vwap": round(0.75 + min(0.25, (o.vwap_z - 0.80) * 0.4), 3),
                "press": round(0.60 + min(0.30, div_bonus * 0.05), 3),
                "htf": round(0.50 + min(0.30, room_bonus * 0.04), 3),
                "loc": 0.65,
                "reg": 0.35 if o.regime == "RANGING" else 0.20,
                "sess": 0.30 if o.active_killzone else 0.10,
            }
            out.append(InstitutionalCandidate("SHORT", "A_PLUS", "OB_Bear", round(sc, 2), weights))

        if 0.82 <= o.vwap_z <= 1.35 and rsi_val < 55.5 and o.htf_extension > -0.68:
            sc_s = 55.0 + min(9.5, max(0.0, (55.5 - rsi_val) * 0.9 + (o.htf_extension + 0.68) * 5.0))
            weights_s = {
                "htf": 0.45,
                "vwap": 0.50,
                "press": 0.35,
                "loc": 0.40,
                "reg": 0.25,
            }
            out.append(InstitutionalCandidate("SHORT", "STRUCTURAL", "FVG_Bear", round(sc_s, 2), weights_s))

    if o.htf_bull and o.htf_extension < 0.72 and close > open_:
        if (o.fvg_bull or o.ob_bull) and o.vwap_z <= -0.78:
            room_bonus = max(0.0, (0.72 - o.htf_extension) * 8.0)
            div_bonus = max(0.0, (rsi_val - 44.0) * 0.4)
            sc = 86.0 + min(11.5, room_bonus + div_bonus)
            weights = {
                "loc": 0.85,
                "htf": 0.60,
                "vwap": 0.70,
                "press": 0.50,
                "reg": 0.30,
            }
            out.append(InstitutionalCandidate("LONG", "A_PLUS", "FVG_Bull", round(sc, 2), weights))
        elif -1.32 <= o.vwap_z <= -0.85 and rsi_val > 45.0:
            div_bonus = max(0.0, (rsi_val - 45.0) * 1.5)
            room_bonus = max(0.0, (0.72 - o.htf_extension) * 8.0)
            sc = 76.0 + min(18.5, div_bonus + room_bonus)
            weights = {
                "vwap": 0.75,
                "press": 0.60,
                "htf": 0.55,
                "loc": 0.65,
                "reg": 0.30,
            }
            out.append(InstitutionalCandidate("LONG", "A_PLUS", "OB_Bull", round(sc, 2), weights))

        if -1.35 <= o.vwap_z <= -0.82 and rsi_val > 44.5 and o.htf_extension < 0.68:
            sc_s = 55.0 + min(9.5, max(0.0, (rsi_val - 44.5) * 0.9 + (0.68 - o.htf_extension) * 5.0))
            out.append(InstitutionalCandidate("LONG", "STRUCTURAL", "FVG_Bull", round(sc_s, 2), {"htf": 0.45, "vwap": 0.50, "loc": 0.40}))

    return out


@dataclass
class EngineSignal:
    id: str
    tf: str
    time: int
    direction: str
    tier: str
    setup: str
    score: float
    probability: Dict
    plan: Dict
    tags: List[str]
    factors: List[Dict]
    orderflow: Dict
    status: str = "open"
    outcome: Optional[str] = None
    r_net: Optional[float] = None

    def to_dict(self) -> Dict:
        return asdict(self)

    def brief(self) -> Dict:
        """Compact form for chart history markers."""
        p = self.plan
        st = (self.probability or {}).get("stat") or {}
        return {
            "id": self.id, "time": self.time, "direction": self.direction, "tier": self.tier, "setup": self.setup,
            "score": self.score, "entry": p.get("entry"), "stop": p.get("stop"), "tp1": p.get("tp1"), "tp2": p.get("tp2"),
            "status": self.status, "outcome": self.outcome, "r_net": self.r_net,
            "prob_status": (self.probability or {}).get("status"), "win_rate": st.get("win_rate"), "n": st.get("n"),
        }


def _tier(o: OscBar, is_long: bool) -> Optional[str]:
    if is_long:
        return "A_PLUS" if o.aplus_bull else "STRUCTURAL" if o.struct_bull else "TRAP" if o.trap_bull else None
    return "A_PLUS" if o.aplus_bear else "STRUCTURAL" if o.struct_bear else "TRAP" if o.trap_bear else None


def _session_day(t: int) -> str:
    dt = datetime.fromtimestamp(t, tz=timezone.utc).astimezone(NY)
    # trading day rolls at 17:00 New York
    if dt.hour >= 17:
        dt = datetime.fromtimestamp(t + 7 * 3600, tz=timezone.utc).astimezone(NY)
    return dt.strftime("%Y-%m-%d")


class TimeframeEngine:
    def __init__(
        self,
        tf: str,
        symbol: str = "XAUUSDT",
        ledger: Optional[Ledger] = None,
        calibrator: Optional[Calibrator] = None,
        risk: Optional[RiskConfig] = None,
        source: str = "live",
        macro: Optional[MacroProvider] = None,
        flow_mode: str = "taker",
        mintick: float = 0.01,
    ):
        if tf not in TF_SECONDS:
            raise ValueError(f"unsupported tf {tf}")
        self.tf = tf
        self.tf_seconds = TF_SECONDS[tf]
        self.symbol = symbol
        self.ledger = ledger
        self.cal = calibrator or Calibrator(ledger)
        self.flow_mode = flow_mode
        if flow_mode != "pine":
            self.risk = institutional_risk_config(tf, risk)
        else:
            self.risk = risk or RiskConfig()
        self.source = source
        self.macro = macro or NeutralMacro()
        self.osc = OscEngine(OscConfig(mintick=mintick))
        self.rpd = RpdEngine(RpdConfig(mintick=mintick, chart_tf_seconds=self.tf_seconds))
        self.liq = LiquidityEngine()
        self.uni = UnicornEngine(UnicornConfig(mintick=mintick, chart_tf_seconds=self.tf_seconds))
        self.regob = RegObEngine()
        self.htf = HtfTracker()
        self.prev_bucket: Optional[int] = None
        self.last_t: Optional[int] = None
        self.open: List[SignalRecord] = []
        self.signals: Deque[EngineSignal] = deque(maxlen=200)
        self.recent_events: Deque[Dict] = deque(maxlen=60)  # sweeps / rpd / unicorn births for chart
        self.last: Optional[OscBar] = None
        self.last_reg: Dict = {}
        self.last_inst_candidates: List[InstitutionalCandidate] = []
        self.closed_buffer: List[SignalRecord] = []  # backtest batch writes
        if ledger is not None and source == "live":
            self.open = [r for r in ledger.open.values() if r.tf == tf and r.source == "live"]

    # ── HTF ─────────────────────────────────────────────────────────────────
    def add_htf_bar(self, k: Kline) -> None:
        self.htf.add_bar(k.t, k.o, k.h, k.l, k.c)

    # ── core ────────────────────────────────────────────────────────────────
    def on_bar(
        self,
        k: Kline,
        intrabars: Optional[Sequence[Kline]] = None,
        orderflow: Optional[OrderflowSnapshot] = None,
        record: bool = True,
    ) -> List[EngineSignal]:
        if self.last_t is not None and k.t <= self.last_t:
            return []
        self.last_t = k.t
        bar_close_t = k.t + self.tf_seconds

        # 1. resolve open records against this bar
        for rec in list(self.open):
            if k.t <= rec.entry_time:
                continue
            if rec.step(k.t, k.h, k.l, k.c):
                self.open.remove(rec)
                self._persist_closed(rec)
                for s in self.signals:
                    if s.id == rec.id:
                        s.status, s.outcome, s.r_net = "closed", rec.outcome, rec.r_net

        # 2. engines
        bucket = self.htf.bucket_of(k.t)
        if intrabars:
            if self.flow_mode == "pine" or all(b.taker_buy == 0.0 for b in intrabars):
                flows = pine_ltf_flows([(b.o, b.h, b.l, b.c, b.v) for b in intrabars])
            else:
                flows = taker_ltf_flows([(b.v, b.taker_buy) for b in intrabars])
        else:
            flows = None
        o = self.osc.update(BarInput(
            t=k.t, o=k.o, h=k.h, l=k.l, c=k.c, v=k.v, ltf_flows=flows,
            htf=self.htf.values_for(k.t), htf_new_bucket=(self.prev_bucket is not None and bucket != self.prev_bucket),
            dxy=self.macro.dxy(k.t), vix=self.macro.vix(k.t),
        ))
        self.prev_bucket = bucket
        rp = self.rpd.update(k.t, k.o, k.h, k.l, k.c, k.v)
        lq = self.liq.update(k.t, k.o, k.h, k.l, k.c, k.v)
        un = self.uni.update(k.t, k.o, k.h, k.l, k.c, k.v,
                             rpd_prob_bull=rp.valley_display, rpd_prob_bear=rp.peak_display, r_trend=rp.r_trend)
        rg = self.regob.update(k.t, k.o, k.h, k.l, k.c, k.v)
        self.last = o
        self.last_reg = {"rpd": rp, "liq": lq, "uni": un, "regob": rg}
        self._track_events(k, o, rp, lq, un, rg)

        # 3. signals
        out: List[EngineSignal] = []
        if not o.ready:
            self.last_inst_candidates = []
            return out

        if self.flow_mode != "pine":
            cands = evaluate_institutional_bar(self.tf, k.o, k.h, k.l, k.c, o, rp, lq, un, rg)
            self.last_inst_candidates = cands
            walls = orderflow.walls if orderflow else ()
            for cand in cands:
                direction = cand.direction
                tier = cand.tier
                is_long = direction == "LONG"
                if any(r.direction == direction and r.tier == tier for r in self.open):
                    continue
                plan = build_institutional_plan(direction, k.c, o.atr14, o.session_vol, self.risk, walls)
                if plan is None:
                    continue
                ev = orderflow_evidence(direction, orderflow, o.atr14)
                tags = self._tags(o, is_long) + ev.tags
                rec = SignalRecord(
                    id=f"{self.symbol}-{self.tf}-{k.t}-{direction[0]}-{tier}", source=self.source, symbol=self.symbol,
                    tf=self.tf, setup=cand.setup, direction=direction, tier=tier, score=round(cand.score, 3),
                    entry_time=k.t, entry=plan.entry, stop=plan.stop, tp1=plan.tp1, tp2=plan.tp2,
                    cost_r=plan.cost_r, horizon=self.risk.horizon_bars, tags=tags,
                )
                est = self.cal.estimate(self.tf, rec.setup, tier, cand.score)
                factors = [
                    {"key": key, "label": FACTOR_LABELS.get(key, key), "log_odds": round(val, 3)}
                    for key, val in sorted(cand.weights.items(), key=lambda kv: -abs(kv[1])) if abs(val) > 1e-9
                ]
                sig = EngineSignal(
                    id=rec.id, tf=self.tf, time=bar_close_t, direction=direction, tier=tier, setup=rec.setup,
                    score=round(cand.score, 2), probability=est.to_dict(), plan=plan.to_dict(), tags=tags, factors=factors,
                    orderflow=ev.to_dict(),
                )
                if record:
                    self.open.append(rec)
                    if self.ledger is not None and self.source == "live":
                        self.ledger.add(rec, track=False)
                self.signals.append(sig)
                out.append(sig)
            return out

        for is_long in (True, False):
            tier = _tier(o, is_long)
            if tier is None:
                continue
            direction = "LONG" if is_long else "SHORT"
            if any(r.direction == direction and r.tier == tier for r in self.open):
                continue  # one open position per direction x tier
            setup = o.long_primary if is_long else o.short_primary
            score = o.adj_long if is_long else o.adj_short
            walls = orderflow.walls if orderflow else ()
            plan = build_plan(direction, k.c, o.session_vol, o.atr14, self.risk, walls)
            if plan is None:
                continue
            ev = orderflow_evidence(direction, orderflow, o.atr14)
            tags = self._tags(o, is_long) + ev.tags
            rec = SignalRecord(
                id=f"{self.symbol}-{self.tf}-{k.t}-{direction[0]}-{tier}", source=self.source, symbol=self.symbol,
                tf=self.tf, setup=setup or "NONE", direction=direction, tier=tier, score=round(score, 3),
                entry_time=k.t, entry=plan.entry, stop=plan.stop, tp1=plan.tp1, tp2=plan.tp2,
                cost_r=plan.cost_r, horizon=self.risk.horizon_bars, tags=tags,
            )
            est = self.cal.estimate(self.tf, rec.setup, tier, score)
            weights = o.long_weights if is_long else o.short_weights
            factors = [
                {"key": key, "label": FACTOR_LABELS.get(key, key), "log_odds": round(val, 3)}
                for key, val in sorted(weights.items(), key=lambda kv: -abs(kv[1])) if abs(val) > 1e-9
            ]
            sig = EngineSignal(
                id=rec.id, tf=self.tf, time=bar_close_t, direction=direction, tier=tier, setup=rec.setup,
                score=round(score, 2), probability=est.to_dict(), plan=plan.to_dict(), tags=tags, factors=factors,
                orderflow=ev.to_dict(),
            )
            if record:
                self.open.append(rec)
                if self.ledger is not None and self.source == "live":
                    self.ledger.add(rec, track=False)
            self.signals.append(sig)
            out.append(sig)
        return out

    def _persist_closed(self, rec: SignalRecord) -> None:
        self.cal.add(rec)
        if self.source == "live":
            if self.ledger is not None:
                self.ledger.add(rec, track=False)
        else:
            self.closed_buffer.append(rec)

    def flush(self) -> int:
        if self.ledger is None or not self.closed_buffer:
            return 0
        n = self.ledger.add_many(self.closed_buffer)
        self.closed_buffer = []
        return n

    def _tags(self, o: OscBar, is_long: bool) -> List[str]:
        t: List[str] = []
        rp, lq, un, rg = (self.last_reg[k] for k in ("rpd", "liq", "uni", "regob"))
        side = "bull" if is_long else "bear"
        if (is_long and o.htf_bull) or ((not is_long) and o.htf_bear):
            t.append("htf_aligned")
        if o.kz_confirmed:
            t.append("killzone_volume")
        t.append(f"session_{o.killzone.lower()}")
        t.append(f"regime_{o.regime.lower()}")
        if (is_long and o.vac_align_bull) or ((not is_long) and o.vac_align_bear):
            t.append("vacuum_aligned")
        h = o.hopla
        if is_long and (h.get("in_discount") or h.get("near_3")):
            t.append("hopla_discount")
        if (not is_long) and (h.get("in_premium") or h.get("near_97")):
            t.append("hopla_premium")
        atr = o.atr14 or 0
        if any(s.side == side and atr and abs(s.entry - o.close) <= atr for s in un.setups):
            t.append("reg_unicorn")
        recent = [e for e in self.recent_events if self.last_t is not None and self.last_t - e["time"] <= 3 * self.tf_seconds]
        if any(e["kind"] == ("rpd_valley" if is_long else "rpd_peak") for e in recent):
            t.append("reg_rpd")
        if any(e["kind"] == "liq_sweep" and e["dir"] == (1 if is_long else -1) for e in recent):
            t.append("reg_liq_sweep")
        if any(z.side == side and z.bottom <= o.close <= z.top for z in rg.zones):
            t.append("reg_regob")
        return t

    def _track_events(self, k: Kline, o: OscBar, rp, lq, un, rg) -> None:
        if rp.valid_peak:
            self.recent_events.append({"kind": "rpd_peak", "time": k.t, "price": k.h, "prob": rp.peak_display, "dir": -1})
        if rp.valid_valley:
            self.recent_events.append({"kind": "rpd_valley", "time": k.t, "price": k.l, "prob": rp.valley_display, "dir": 1})
        if lq.new_liq_sweep:
            self.recent_events.append({"kind": "liq_sweep", "time": k.t, "price": k.h if lq.new_liq_sweep_dir < 0 else k.l, "dir": lq.new_liq_sweep_dir})
        if un.new_bullish or un.new_bearish:
            self.recent_events.append({"kind": "unicorn", "time": k.t, "price": k.c, "dir": 1 if un.new_bullish else -1})
        if o.choch_bull or o.choch_bear:
            self.recent_events.append({"kind": "choch", "time": k.t, "price": k.c, "dir": 1 if o.choch_bull else -1})
        if o.shock_start:
            self.recent_events.append({"kind": "shock", "time": k.t, "price": k.c, "dir": 0})

    # ── frame for the UI ────────────────────────────────────────────────────
    def frame(self, mid: Optional[float] = None, max_dist_atr: float = 20.0) -> Dict:
        o = self.last
        if o is None:
            return {"tf": self.tf, "ready": False}
        atr = o.atr14 or 0.0
        px = mid or o.close
        near = (lambda p: p is not None and (not atr or abs(p - px) <= max_dist_atr * atr))
        rp, lq, un, rg = (self.last_reg.get(k) for k in ("rpd", "liq", "uni", "regob"))
        def side_view(is_long: bool) -> Dict:
            if self.flow_mode != "pine":
                want_dir = "LONG" if is_long else "SHORT"
                cand = next((c for c in self.last_inst_candidates if c.direction == want_dir), None)
                if cand is not None:
                    return {
                        "score": round(cand.score, 2),
                        "raw_score": round(cand.score, 2),
                        "tier": cand.tier,
                        "setup": cand.setup,
                        "has_setup": True,
                        "no_conflict": True,
                        "weights": {k: round(v, 3) for k, v in cand.weights.items()},
                    }
            return {
                "score": round(o.adj_long if is_long else o.adj_short, 2),
                "raw_score": round(o.long_prob if is_long else o.short_prob, 2),
                "tier": _tier(o, is_long),
                "setup": (o.long_primary if is_long else o.short_primary) or None,
                "has_setup": o.has_bull_setup if is_long else o.has_bear_setup,
                "no_conflict": o.gates["long_no_conflict" if is_long else "short_no_conflict"],
                "weights": {k: round(v, 3) for k, v in (o.long_weights if is_long else o.short_weights).items()},
            }
        active = next((s for s in reversed(self.signals) if s.status == "open" and s.tier != "TRAP"), None)
        return {
            "tf": self.tf,
            "ready": o.ready,
            "bar_time": o.t,
            "updated_at": int(time.time() * 1000),
            "context": {
                "regime": o.regime, "er": round(o.er, 3), "killzone": o.killzone, "active_killzone": o.active_killzone,
                "kz_confirmed": o.kz_confirmed, "shock_hard": o.shock_hard, "shock_soft": o.shock_soft,
                "htf_bull": o.htf_bull, "htf_bear": o.htf_bear, "htf_extension": round(o.htf_extension, 2),
                "vwap_z": round(o.vwap_z, 3), "smpi": None if o.smpi is None else round(o.smpi, 3),
                "vol_z": round(o.vol_z, 2), "atr": None if o.atr14 is None else round(o.atr14, 3),
                "session_vol": None if o.session_vol is None else round(o.session_vol, 3),
                "n_eff": round(o.n_eff, 2), "k_active": o.k_active, "r_bar": round(o.r_bar, 3),
                "dynamic_min": round(o.dynamic_min, 1), "eqs": round(o.eqs, 3), "toxic_flow": o.toxic_flow,
                "ltf_ok": o.ltf_ok, "macro": self.macro.name, "trend_dir": o.trend_dir,
                "rpd_trend": getattr(rp, "r_trend", None),
            },
            "gates": o.gates,
            "long": side_view(True),
            "short": side_view(False),
            "active_signal": active.to_dict() if active else None,
            "signals": [s.brief() for s in list(self.signals)[-80:]],
            "latest": [s.to_dict() for s in list(self.signals)[-3:]],
            "structure": {
                "hopla": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in o.hopla.items()},
                "vacuum": [asdict(p) for p in o.vacuum_pockets if near(p.price)],
                "vac_above": o.vac_above, "vac_below": o.vac_below, "vac_band": round(o.vac_band, 3),
                "unicorn": [asdict(s) for s in (un.setups if un else []) if near(s.entry)],
                "liquidity": [lv for lv in (lq.levels if lq else []) if near(lv.get("price"))][-24:],
                "key_levels": {"pdh": getattr(lq, "pdh", None), "pdl": getattr(lq, "pdl", None),
                               "pwh": getattr(lq, "pwh", None), "pwl": getattr(lq, "pwl", None)},
                "regob": [asdict(z) for z in (rg.zones if rg else []) if near((z.top + z.bottom) / 2)],
                "regression": {"mid": getattr(rg, "reg_mid", None), "upper": getattr(rg, "reg_upper", None), "lower": getattr(rg, "reg_lower", None)},
                "events": list(self.recent_events)[-40:],
            },
            "pine_aplus": o.aplus_stats,
        }


def guardrails(ledger: Optional[Ledger], cfg: RiskConfig, now: Optional[int] = None) -> Dict:
    """Soft risk guardrails on today's LIVE A+ results (trading day rolls 17:00 NY)."""
    now = now or int(time.time())
    if ledger is None:
        return {"warnings": [], "trades_today": 0, "r_today": 0.0, "consecutive_losses": 0}
    day = _session_day(now)
    recs = [r for r in ledger.recent(300, source="live") if r.tier == "A_PLUS"]
    today = [r for r in recs if _session_day(r.entry_time) == day]
    closed_today = [r for r in today if r.status == "closed"]
    r_today = round(sum(r.r_net or 0.0 for r in closed_today), 3)
    consec = 0
    for r in sorted((r for r in recs if r.status == "closed"), key=lambda r: r.exit_time or 0, reverse=True):
        if r.win:
            break
        consec += 1
    warnings: List[Dict] = []
    if r_today <= -cfg.daily_loss_limit_r:
        warnings.append({"code": "daily_loss", "message": f"Daily loss limit reached ({r_today:+.2f}R ≤ -{cfg.daily_loss_limit_r:g}R). Consider stopping for this session."})
    if consec >= cfg.max_consecutive_losses:
        warnings.append({"code": "loss_streak", "message": f"{consec} losses in a row. Step back and review before the next trade."})
    if len(today) >= cfg.max_trades_per_day:
        warnings.append({"code": "max_trades", "message": f"{len(today)} A+ trades today (limit {cfg.max_trades_per_day}). Over-trading risk."})
    return {"warnings": warnings, "trades_today": len(today), "r_today": r_today, "consecutive_losses": consec, "trading_day": day}


def group_intrabars(chart: Sequence[Kline], tf_seconds: int, intrabars: Sequence[Kline]) -> Dict[int, List[Kline]]:
    out: Dict[int, List[Kline]] = {}
    for b in intrabars:
        start = b.t - (b.t % tf_seconds)
        out.setdefault(start, []).append(b)
    return out
