# Institutional Audit — scichart-terminal (XAUUSD Order-Flow Terminal)

Date: 2026-10-21
Auditor: Quant-bank desk review (automated)
Scope: orderbook-bridge (Python) + scichart-terminal (React/SciChart)

## Executive Summary

The terminal is architecturally sound — GPU rendering, rAF-coalesced frames, bridge emits
only diffs of the heavy v74 frame, three properly tested order-flow lenses. **But the
decision surface the trader actually trades from (the chart) is missing four of the five
signals that institutional desks weight highest**: cumulative volume delta, volatility
regime, session/kill-zone timing, and liquidity-sweep events. Worse, two of the three
chart overlays are running on **fabricated inputs**: the live candles are rebuilt from
mid-price ticks with `volume=0`, so the "Heavy Absorption" bubble detector — which is
primarily a *volume*-ratio detector — is structurally blind on live bars.

Findings ranked by P&L impact. (C)=correctness (L)=latency (P)=probability/edge.

---

## CRITICAL — signals running blind or wrong

### F1. (C)(P) Live candles are synthetic & volume-less — Heavy Absorption runs blind
`TerminalChart.updateCandles()` builds OHLC from the mid-price stream and pushes
`volume: 0` into `historicalCandles` (line ~310). `lib/absorption.detectHeavyAbsorptions()`
gates on `volRatio >= 70/55/130/175`, all computed against a rolling volume average.
With `volume=0`, `volRatio = 0/avg = 0` for every live candle → **no live candle can ever
trigger a wick-rejection absorption bubble**. Only the bridge-side `absorption_candidates`
(marked `text: "ABS"`) ever draw. The locally-detected "heavy absorption" history the user
sees is reconstructed solely from the 200 seeded klines and decays as live bars push
them out. **Impact: the headline overlay degrades to nothing after ~3.3 h of live bars.**

### F2. (C)(P) Bridge `_CandleAggregator` discards trade volume & delta
The vacuum engine is fed OHLC-only `Candle(t,o,h,l,c)`; trade flow (qty, side) is ignored.
So candle-level volume / delta / CVD is never computed anywhere in the pipeline. XAUUSD
perp without delta is a coin flip: the single most predictive short-horizon microstructure
feature (signed aggressor imbalance) is dropped on the floor.

### F3. (C) No CVD / delta aggregator exists
`RECENT_TRADES` deque (maxlen=80) is the only aggregation of the trade stream and it is
displayed raw. No cumulative volume delta, no per-bucket delta, no divergence detection
(price up + CVD down = distribution). This is the textbook institutional filter for
fading vacuum-magnet touches.

### F4. (C)(P) Absorption thresholds not volatility-normalized across regimes
`AbsorptionEngine` uses fixed `total_vol >= 10.0 oz` cluster gate, `buy_vol >= 12.0`,
fixed 4000 ms window, `vol_score = min(buy_vol/40, 1)`. During Asia lunch (thin) these
almost never fire; during NY open (news) they fire constantly → threshold is effectively
session-regime-dependent but never adjusted. The engine has `vol_z`/`session_vol` data
available via the v74 runtime but ignores it.

---

## HIGH — edge signals computed but never rendered

### F5. (P) Kill-zone / session flags never surface to the chart
`engine/sessions.py` computes London/NY-AM/Asia/London-fix flags (DST-correct,
America/New_York). They flow into v74 context (`killzone`, `active_killzone`) and gates,
but **no visual band on the chart**. Trader cannot see *when* the A+ setups are allowed.

### F6. (P) Liquidity sweep events (`liq_sweep`) never drawn
`StructureEvent(kind='liq_sweep')` is emitted by the v74 REG liquidity module, appears in
`structure.events`, but `TerminalChart` only renders `structure.vacuum` + `hopla`. Sweep
markers (the highest-win-rate institutional fade entry) are invisible.

### F7. (P) `shock_hard` / `toxic_flow` / `vwap_z` context not displayed
The v74 context exposes shock gating, toxic flow flag, VWAP z-score — all gate the signal
engine, but the trader sees none of them. When no A+ fires, the reason is opaque.

### F8. (P) Prior-day/week levels (`pdh/pdl/pwh/pwl`) computed but not drawn
`structure.key_levels` carries them; chart draws nothing. These are the liquidity magnets
that the vacuum engine's stop-pools cluster around.

---

## MEDIUM — performance / latency

### F9. (L) Heatmap always marshals full 240×160 tensor when dirty
`updateHeatmap` only calls `setZValues(this.zGrid)` when `dirty`, but the dirty check
covers the whole grid. When only the newest column changed (the common case), we still
push 38 400 floats across the WASM bridge every frame the book moves. SciChart supports
updating a z-slice via `setZValues` with the same array (no partial API), so the real
fix is: skip repaint entirely when the newest column is byte-identical to the previous
column — currently it *is* compared per-cell but `dirty` flips on any change including
the zero-clear sweep at the start of each frame. Should only flip when the final painted
column differs from what was there.

### F10. (L) `price_history` (250 points) re-serialized + resent every broadcast
`terminal_state["price_history"] = list(PRICE_HISTORY)` runs on every depth update
(up to 50 Hz upstream) and the full 250-entry array ships at 12-15 fps. Frontend only
uses it in DiagnosticsPanel. Should be a separate low-frequency key or delta-encoded.

### F11. (L) `refresh_v74_frame` rebuilds a ~70 KB frame every 5 s even when idle
The guardrail timer fires regardless of whether a bar closed. With zero clients the
broadcast skips, but the frame rebuild still runs (hub.frame under lock). Minor.

---

## LOW — polish / robustness

### F12. (C) Mid-price candles vs trade-price candles mismatch
Frontend seeds with Binance klines (trade price) then continues with mid-price candles.
Across a funding-flip or wide-spread episode this produces a visible seam in the series
and shifts wick-rejection ratios by up to half a spread.

### F13. AbsorptionEngine `expected_displacement = sqrt(vol) * local_vol * 0.10` — the
0.10 constant is uncalibrated for XAUUSD. At 0.15 local vol and 40 oz cluster the
expectation is ~0.09 USD, far below one tick — stall factor saturates at 1.0 in quiet
markets, inflating confidence.

### F14. No volume-profile overlay. Institutional desks anchor on POC/VAH/VAL of the
session; the heatmap shows *resting* liquidity but not *transacted* volume-at-price.

---

## Remediation plan (this iteration)

| # | Fix | File(s) | Impact |
|---|-----|---------|--------|
| R1 | Trade-price candle aggregation + per-bucket volume & delta in bridge | bridge.py (new `TradeCandleAggregator`), broadcast `candles[]` + `cvd` | F1,F2,F3 |
| R2 | Volatility-normalized absorption thresholds (scale by `session_vol`, session-aware window) | analytics/absorption_engine.py | F4,F13 |
| R3 | Expose session/killzone + key levels + sweep events in bridge frame | bridge.py terminal_state | F5,F6,F8 |
| R4 | Frontend: consume bridge candles (trade price + volume) instead of synthetic; draw session bands, killzone shading, sweep markers, PDH/PDL/PWH/PWL, CVD sub-pane, session volume profile (POC/VAH/VAL) | TerminalChart.ts, App.tsx, types/frame.ts | F1,F5,F6,F8,F12,F14 |
| R5 | Heatmap dirty-check only on effective column change | TerminalChart.ts | F9 |
| R6 | Slim price_history: keep in frame but only in diagnostics (send every 30th frame) | bridge.py | F10 |

Backtest: with R1-R2 in place, run `engine/backtest.py` and verify the expectancy of
A+ signals **conditioned on CVD-aligned** vs CVD-divergent (target: measurable lift in
win rate / expectancy_r in the ledger `reliability` view).
