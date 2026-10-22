"""Tests for the COMEX GC <-> Binance XAUUSDT cross-venue basis mapper."""

import math

import pytest

from analytics.basis_mapper import CrossVenueBasisMapper


def test_first_quote_seeds_basis_exactly():
    m = CrossVenueBasisMapper(ema_alpha=0.2)
    basis = m.update_quotes(gc_mid=4158.5, xauusdt_mid=4140.2)
    # First observation seeds the EMA directly at the raw basis.
    assert basis == pytest.approx(18.3)
    # Variance is still zero -> z-score undefined -> 0.0.
    assert m.get_basis_zscore() == 0.0


def test_map_before_any_quote_is_identity():
    m = CrossVenueBasisMapper()
    assert m.map_gc_level_to_xauusdt(4160.0) == 4160.0
    assert m.map_xauusdt_level_to_gc(4140.0) == 4140.0


def test_ema_basis_tracks_and_maps_level():
    m = CrossVenueBasisMapper(ema_alpha=0.2)
    for gc, xau in [(4158.5, 4140.2), (4158.6, 4140.25), (4159.4, 4140.25)]:
        m.update_quotes(gc_mid=gc, xauusdt_mid=xau)
    # GC level projected onto XAUUSDT = gc - ema_basis.
    mapped = m.map_gc_level_to_xauusdt(4160.0)
    assert mapped == round(4160.0 - m.ema_basis, 2)
    # Round-trip mapping is consistent.
    assert m.map_xauusdt_level_to_gc(mapped) == pytest.approx(4160.0, abs=0.01)


def test_zscore_positive_when_spread_stretches_above_ema():
    m = CrossVenueBasisMapper(ema_alpha=0.2)
    m.update_quotes(4158.5, 4140.2)   # seed basis ~18.3
    m.update_quotes(4158.6, 4140.25)  # basis ~18.35, builds variance
    m.update_quotes(4159.4, 4140.25)  # basis jumps to ~19.15 -> stretched up
    z = m.get_basis_zscore()
    assert z > 0.0
    assert math.isfinite(z)


def test_invalid_alpha_rejected():
    with pytest.raises(ValueError):
        CrossVenueBasisMapper(ema_alpha=0.0)
    with pytest.raises(ValueError):
        CrossVenueBasisMapper(ema_alpha=1.5)


def test_to_dict_shape():
    m = CrossVenueBasisMapper(ema_alpha=0.2)
    m.update_quotes(4158.5, 4140.2)
    d = m.to_dict()
    assert d["type"] == "cross_venue_basis"
    assert isinstance(d["gcMid"], str)
    assert isinstance(d["xauusdtMid"], str)
    assert d["emaBasis"] == pytest.approx(18.3)
    assert "basisZScore" in d
