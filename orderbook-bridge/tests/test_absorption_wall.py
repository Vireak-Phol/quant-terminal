"""The absorption candidate carries a `wall` flag for the chart's DeepCharts-style
square marker: True only when the absorbed aggression traded into a resting
liquidity wall on the passive side."""

from types import SimpleNamespace

from analytics.absorption_engine import AbsorptionEngine


def _zone(side: str, center: float, multiple: float = 3.0):
    # Duck-typed LiquidityZone: the engine reads only side/center_price/multiple_of_mean.
    return SimpleNamespace(side=side, center_price=center, multiple_of_mean=multiple)


def _run(zones):
    eng = AbsorptionEngine(min_confidence=0.0)
    out = None
    t = 1_000_000
    for i in range(40):  # heavy aggressive buying, price pinned at 4000.00
        c = eng.ingest_trade(4000.0, 5.0, "buy", t + i * 50, resting_zones=zones)
        out = c or out
    return out


def test_wall_true_when_buying_into_ask_wall():
    cand = _run([_zone("ask", 4000.1)])
    assert cand is not None and cand.side == "buy"
    assert cand.wall is True
    assert cand.to_dict()["wall"] is True


def test_wall_false_without_passive_wall():
    cand = _run([_zone("bid", 4000.0)])  # wrong side: a bid wall does not absorb buys
    assert cand is not None and cand.side == "buy"
    assert cand.wall is False
    assert cand.to_dict()["wall"] is False
