from engine.alerts import AlertDispatcher, format_signal


def _sig(i="s1", tier="A_PLUS", measured=True):
    return {
        "id": i, "tf": "5m", "direction": "LONG", "tier": tier, "setup": "FVG_Bull",
        "plan": {"entry": 4000.0, "stop": 3997.0, "tp1": 4004.0, "tp2": 4007.0, "qty": 0.33, "risk_usd": 0.99, "rr_tp1": 1.33, "flags": []},
        "probability": {"status": "measured" if measured else "warmup", "source": "backtest", "min_samples": 15,
                        "stat": {"win_rate": 58.2, "ci_lo": 51.0, "ci_hi": 65.0, "n": 120, "expectancy_r": 0.12}},
    }


def test_format_measured_and_warmup():
    t = format_signal(_sig())
    assert "Measured win rate 58.2%" in t and "n=120" in t and "SL 3997.0" in t
    assert "warm-up" in format_signal(_sig(measured=False))


def test_dedupe_tier_filter_and_delivery():
    sent = []
    d = AlertDispatcher(sender=sent.append, min_spacing_s=0.0)
    assert d.on_signal(_sig("a"))
    assert not d.on_signal(_sig("a"))  # duplicate id
    assert not d.on_signal(_sig("b", tier="STRUCTURAL"))  # tier filtered
    d.flush()
    assert len(sent) == 1


def test_retry_then_success():
    calls = []

    def flaky(text):
        calls.append(text)
        if len(calls) == 1:
            raise OSError("boom")

    d = AlertDispatcher(sender=flaky, min_spacing_s=0.0)
    d.on_signal(_sig("x"))
    d.flush(timeout=5)
    assert len(calls) == 2


def test_disabled_without_credentials():
    d = AlertDispatcher(token=None, chat_id=None)
    assert not d.enabled and not d.on_signal(_sig("z"))
