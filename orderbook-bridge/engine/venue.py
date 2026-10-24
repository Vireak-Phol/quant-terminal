"""Venue (market-data provider) registry.

One place that answers "which provider is active, and what does that imply":
symbol, ledger file, risk-config section + cost defaults, and the data
*capabilities* the UI must respect.

Selection precedence: ``MARKET_PROVIDER`` env  >  ``data/config.json`` "provider"  >  binance.

Ledgers are separate per venue on purpose: the calibrator does not filter by symbol,
and Binance perp outcomes (taker fees, real tape) must never be mixed with OANDA CFD
outcomes (spread cost, tick volume) when computing measured win rates.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .alerts import read_env_file

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(ROOT, "data")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")


@dataclass(frozen=True)
class Venue:
    name: str                 # binance | oanda
    label: str                # human label for the UI
    symbol: str               # venue-native instrument id
    display_symbol: str       # header label
    contract: str             # PERP | CFD
    ledger_path: str
    risk_section: str         # key inside data/config.json
    risk_defaults: Dict = field(default_factory=dict)
    # What the feed really contains. The UI greys out layers whose data is absent.
    capabilities: Dict = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            "name": self.name, "label": self.label, "symbol": self.symbol,
            "display_symbol": self.display_symbol, "contract": self.contract,
            "capabilities": dict(self.capabilities),
        }


VENUES: Dict[str, Venue] = {
    "binance": Venue(
        name="binance",
        label="Binance USDⓈ-M Futures",
        symbol="XAUUSDT",
        display_symbol="XAUUSDT",
        contract="PERP",
        ledger_path=os.path.join(DATA_DIR, "ledger.db"),
        risk_section="risk",
        risk_defaults={},
        capabilities={
            "l2_depth": True, "trades": True, "liquidations": True, "open_interest": True,
            "funding": True, "volume": "exchange", "delta": "exchange",
        },
    ),
    "oanda": Venue(
        name="oanda",
        label="OANDA v20",
        symbol="XAU_USD",
        display_symbol="XAU/USD",
        contract="CFD",
        ledger_path=os.path.join(DATA_DIR, "ledger_oanda.db"),
        risk_section="risk_oanda",
        # OANDA standard pricing: no commission, cost = spread. ~0.35 USD typical
        # XAU_USD spread => 35 ticks of 0.01 per round trip. Units are 1 oz.
        risk_defaults={
            "taker_fee_rate": 0.0, "slippage_ticks": 35, "tick_size": 0.01,
            "qty_step": 1.0, "min_qty": 1.0,
        },
        capabilities={
            "l2_depth": False, "trades": False, "liquidations": False, "open_interest": False,
            "funding": False, "volume": "tick", "delta": "tick_rule",
        },
    ),
}


def _read_config(path: str = CONFIG_PATH) -> Dict:
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def resolve_provider_name(config_path: str = CONFIG_PATH) -> str:
    """First *valid* value wins: env, then config file, then binance."""
    for raw in (os.environ.get("MARKET_PROVIDER"), _read_config(config_path).get("provider")):
        name = str(raw or "").strip().lower()
        if name in VENUES:
            return name
    return "binance"


def save_provider_name(name: str, config_path: str = CONFIG_PATH) -> None:
    if name not in VENUES:
        raise ValueError(f"unknown provider {name!r}")
    data = _read_config(config_path)
    data["provider"] = name
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    tmp = config_path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, config_path)


def active_venue() -> Venue:
    return VENUES[resolve_provider_name()]


def venue_for_symbol(symbol: str) -> Venue:
    for v in VENUES.values():
        if v.symbol == symbol:
            return v
    # OANDA instrument ids always contain "_" (XAU_USD, EUR_USD); Binance never does.
    return VENUES["oanda"] if "_" in symbol else VENUES["binance"]


def oanda_config():
    """OANDA credentials from env or the git-ignored repo-root .env, or None."""
    from market_data.oanda import OandaConfig  # lazy: keeps engine importable standalone

    f = read_env_file()
    token = os.environ.get("OANDA_API_TOKEN") or f.get("OANDA_API_TOKEN")
    account = os.environ.get("OANDA_ACCOUNT_ID") or f.get("OANDA_ACCOUNT_ID")
    env = (os.environ.get("OANDA_ENV") or f.get("OANDA_ENV") or "practice").strip().lower()
    if not token or not account:
        return None
    return OandaConfig(token=token, account_id=account, env=env if env in ("practice", "live") else "practice")


def providers_view() -> List[Dict]:
    """For the UI provider switcher: every venue + whether it can be selected."""
    out = []
    for v in VENUES.values():
        d = v.to_dict()
        if v.name == "oanda":
            ok = oanda_config() is not None
            d["available"] = ok
            d["reason"] = None if ok else "Set OANDA_API_TOKEN and OANDA_ACCOUNT_ID in .env"
        else:
            d["available"] = True
            d["reason"] = None
        out.append(d)
    return out
