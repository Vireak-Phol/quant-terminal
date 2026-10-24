"""OANDA provider + venue routing (no network: HTTP is stubbed)."""

import asyncio
import json
from decimal import Decimal

import pytest

from market_data.base import OrderBookSyncState
from market_data.oanda import (
    OandaConfig,
    OandaProvider,
    TickRuleClassifier,
    parse_candles,
    parse_price_message,
    parse_time_ms,
)
from market_data.order_book import LocalOrderBook
from engine import data as data_mod
from engine import venue as venue_mod
from engine.risk import RiskConfig

CFG = OandaConfig(token="secret-token", account_id="101-001-1-001")


def test_config_repr_never_leaks_token():
    assert "secret-token" not in repr(CFG)
    assert CFG.headers()["Authorization"] == "Bearer secret-token"
    assert CFG.rest_base.endswith("fxpractice.oanda.com")
    assert OandaConfig("t", "a", env="live").rest_base == "https://api-fxtrade.oanda.com"


def test_parse_time_unix_and_rfc3339():
    assert parse_time_ms("1700000000.123456789") == 1700000000123
    assert parse_time_ms("2023-11-14T22:13:20.123456789Z") == 1700000000123
    assert parse_time_ms("2023-11-14T22:13:20Z") == 1700000000000


def test_parse_candles_skips_incomplete_and_sorts():
    payload = {"candles": [
        {"time": "1700000060.000000000", "complete": True, "volume": 12, "mid": {"o": "2001.1", "h": "2002", "l": "2000", "c": "2001.5"}},
        {"time": "1700000000.000000000", "complete": True, "volume": 7, "mid": {"o": "2000", "h": "2001.2", "l": "1999.5", "c": "2001.1"}},
        {"time": "1700000120.000000000", "complete": False, "volume": 3, "mid": {"o": "2001.5", "h": "2001.6", "l": "2001.4", "c": "2001.5"}},
        {"time": "1700000180.000000000", "complete": True},  # no price block -> skipped
    ]}
    rows = parse_candles(payload)
    assert [r["t"] for r in rows] == [1700000000, 1700000060]
    assert rows[0]["v"] == 7.0 and rows[1]["c"] == 2001.5
    assert len(parse_candles(payload, include_incomplete=True)) == 3


def test_parse_price_message_heartbeat_and_price():
    assert parse_price_message({"type": "HEARTBEAT", "time": "1700000000.0"}) is None
    msg = {
        "type": "PRICE", "time": "1700000000.500000000", "tradeable": True,
        "bids": [{"price": "2000.10", "liquidity": 250}, {"price": "2000.05", "liquidity": 1000}],
        "asks": [{"price": "2000.45", "liquidity": 250}],
    }
    ts, bids, asks, tradeable = parse_price_message(msg)
    assert ts == 1700000000500 and tradeable
    assert bids[0] == (Decimal("2000.10"), Decimal("250"))
    assert asks == [(Decimal("2000.45"), Decimal("250"))]
    assert parse_price_message({**msg, "asks": []}) is None


def test_tick_rule():
    tr = TickRuleClassifier()
    assert tr.classify(Decimal("10")) is None  # seed only
    assert tr.classify(Decimal("10.1")) == "buy"
    assert tr.classify(Decimal("10.1")) is None  # zero tick: no emission
    assert tr.classify(Decimal("10.0")) == "sell"


def test_replace_levels_full_snapshot_and_crossed_rejected():
    book = LocalOrderBook("XAU_USD")
    book.replace_levels([(Decimal("100"), Decimal("1"))], [(Decimal("101"), Decimal("2"))], exchange_timestamp=5)
    assert book.state == OrderBookSyncState.SYNCHRONIZED
    assert book.get_best_bid_ask() == (Decimal("100"), Decimal("101"))
    assert book.last_exchange_time == 5
    # A new snapshot replaces (not merges) the ladder.
    book.replace_levels([(Decimal("100.5"), Decimal("1"))], [(Decimal("100.9"), Decimal("1"))])
    assert list(book.bids) == [Decimal("100.5")] and list(book.asks) == [Decimal("100.9")]
    # Crossed quote: ignored, previous book kept.
    book.replace_levels([(Decimal("102"), Decimal("1"))], [(Decimal("101"), Decimal("1"))])
    assert book.get_best_bid_ask() == (Decimal("100.5"), Decimal("100.9"))


def test_provider_handle_message_emits_depth_and_tick_rule_trades():
    p = OandaProvider(CFG, symbol="XAU_USD")
    depth, trades = [], []

    async def on_depth(book):
        depth.append(float(book.get_mid_and_spread()[0]))

    async def on_trade(t):
        trades.append((t.aggressor_side, float(t.price), float(t.quantity)))

    p.register_depth_callback(on_depth)
    p.register_trade_callback(on_trade)
    p.register_liquidation_callback(lambda *_: None)  # parity no-op

    def px(b, a, t):
        return {"type": "PRICE", "time": f"{t}.0", "bids": [{"price": b, "liquidity": 1}], "asks": [{"price": a, "liquidity": 1}]}

    async def run():
        await p.handle_message({"type": "HEARTBEAT"})
        await p.handle_message(px("2000.0", "2000.4", 1700000000))
        await p.handle_message(px("2000.2", "2000.6", 1700000001))
        await p.handle_message(px("2000.2", "2000.6", 1700000002))
        await p.handle_message(px("1999.8", "2000.2", 1700000003))

    asyncio.run(run())
    assert depth == [2000.2, 2000.4, 2000.4, 2000.0]
    assert trades == [("buy", 2000.4, 1.0), ("sell", 2000.0, 1.0)]
    assert p.mark_price == 2000.0
    assert p.last_exchange_time == 1700000003000


def test_venue_resolution_and_persist(tmp_path, monkeypatch):
    cfg = tmp_path / "config.json"
    monkeypatch.delenv("MARKET_PROVIDER", raising=False)
    assert venue_mod.resolve_provider_name(str(cfg)) == "binance"
    venue_mod.save_provider_name("oanda", str(cfg))
    assert json.loads(cfg.read_text())["provider"] == "oanda"
    assert venue_mod.resolve_provider_name(str(cfg)) == "oanda"
    monkeypatch.setenv("MARKET_PROVIDER", "binance")
    assert venue_mod.resolve_provider_name(str(cfg)) == "binance"
    monkeypatch.setenv("MARKET_PROVIDER", "nonsense")
    assert venue_mod.resolve_provider_name(str(cfg)) == "oanda"  # falls through to config
    with pytest.raises(ValueError):
        venue_mod.save_provider_name("ftx", str(cfg))


def test_venues_are_isolated():
    b, o = venue_mod.VENUES["binance"], venue_mod.VENUES["oanda"]
    assert b.ledger_path != o.ledger_path
    assert b.risk_section != o.risk_section
    assert o.capabilities["l2_depth"] is False and o.capabilities["trades"] is False
    assert venue_mod.venue_for_symbol("XAU_USD") is o
    assert venue_mod.venue_for_symbol("XAUUSDT") is b


def test_risk_sections_and_venue_defaults(tmp_path):
    path = str(tmp_path / "config.json")
    o = venue_mod.VENUES["oanda"]
    cfg = RiskConfig.load(path, section=o.risk_section, defaults=o.risk_defaults)
    assert cfg.taker_fee_rate == 0.0 and cfg.slippage_ticks == 35 and cfg.qty_step == 1.0
    cfg.account_equity = 500
    cfg.save(path, section=o.risk_section)
    RiskConfig(account_equity=111).save(path)  # binance section untouched by oanda save
    assert RiskConfig.load(path, section=o.risk_section, defaults=o.risk_defaults).account_equity == 500
    assert RiskConfig.load(path).account_equity == 111


def test_data_routes_oanda_symbols(monkeypatch):
    calls = []

    def fake_fetch(cfg, symbol, interval, count=None, from_sec=None, include_incomplete=False):
        calls.append((symbol, interval, count, include_incomplete))
        return [
            {"t": 60, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 9, "complete": True},
            {"t": 4_000_000_000, "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 2, "complete": False},
        ]

    import market_data.oanda as oanda_mod

    monkeypatch.setattr(oanda_mod, "fetch_candles", fake_fetch)
    monkeypatch.setattr(data_mod, "_oanda_cfg", lambda: CFG)
    monkeypatch.setattr(data_mod, "_get", lambda *a, **k: pytest.fail("Binance REST must not be called for OANDA"))

    closed = data_mod.fetch_recent("XAU_USD", "1m", 5)
    assert [k.t for k in closed] == [60]  # forming bar dropped
    assert closed[0].taker_buy == 0.0  # no aggressor data -> Pine flow proxy path
    chart = data_mod.fetch_chart_candles("XAU_USD", "1m", 2)
    assert len(chart) == 2 and chart[0]["delta"] is None and chart[1]["time"] == 4_000_000_000
    assert calls[-1][3] is True


def test_data_binance_chart_candles_delta(monkeypatch):
    raw = [[60_000, "1", "2", "0.5", "1.5", "10", 119_999, "0", 5, "7", "0", "0"]]
    monkeypatch.setattr(data_mod, "_get", lambda url, *a, **k: raw)
    out = data_mod.fetch_chart_candles("XAUUSDT", "1m", 1)
    assert out == [{"time": 60, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 10.0, "delta": 4.0}]
