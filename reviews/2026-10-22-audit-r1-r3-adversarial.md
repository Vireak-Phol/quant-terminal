# ⚔️ Adversarial Vulnerability Report

- **Date:** 2026-10-22
- **Target:** React 18 / TypeScript / SciChart / Python Async Engine
- **Scope / Ref:** `scichart-terminal/src/chart/TerminalChart.ts`, `scichart-terminal/src/types/frame.ts`, `orderbook-bridge/bridge.py`, `orderbook-bridge/analytics/absorption_engine.py`, `orderbook-bridge/analytics/trade_candles.py`
- **Verdict:** Vulnerabilities Found (3 Critical, 3 High/Medium, 2 Low)

## Summary Matrix

| # | Vulnerability / Failure Mode | Severity | Framework Vector | Exploitation / Crash Scenario | Remediation |
|---|---|---|---|---|---|
| 1 | Runtime Crash on Null Key Levels (`kl.pdh!.toFixed(2)`) | Critical | JS Evaluation / TS Assertion | Initial frame passes `{ pdh: null, ... }`. Expression `kl.pdh!.toFixed(2)` throws `TypeError: Cannot read properties of null` before `mk()` guard runs, completely halting the render loop. | Format label inside `mk()` after the null guard. |
| 2 | Liquidity Sweep Markers Rendered in 1970 Off-Screen | High | Unit Mismatch (s vs ms) | `StructureEvent.time` in v74 is already in epoch seconds (`k.t`). Doing `Math.floor(s.time / 1000)` sets `x1 = 1729548` (Jan 1970), making sweep markers permanently invisible off-screen. | Detect unit or treat `s.time` as epoch seconds directly. |
| 3 | Synthetic `volume: 0` Candles Unfixed (Heavy Absorption Blind) | High | Dead-Letter Payload / Incomplete Wiring | Frame now broadcasts `trade_candle`, but `TerminalChart.updateCandles()` still constructs mid-price candles with hardcoded `volume: 0`, leaving live Heavy Absorption detector 100% blind. | Ingest `frame.trade_candle` in `updateCandles()` and seed volume and delta. |
| 4 | Rapid Buffer Saturation via High-Frequency Trade Loop | Medium | Window Resolution Collapse | `_cluster_vol_history.append(total_vol)` executes on every single trade in `evaluate_absorption()`. At 50 trades/sec, the 500-item deque saturates within 10s with identical rolling slices, corrupting `_global_median()`. | Sample cluster volume periodically (e.g. once every 4s window), not on every trade. |
| 5 | Missing Production Integration of `update_session_baseline` | Medium | Dead Code / Disconnected Feature | `update_session_baseline()` was implemented and unit-tested in isolation, but is never invoked anywhere in `bridge.py`. Regime normalization is inert in production; `_vol_scale` stays 1.0. | Hook session regime / volume-z updates from `v74` or `engine/sessions.py` into bridge tick. |
| 6 | Out-of-Order Trade Ingestion Triggers Duplicate Candle Closes | Medium | Clock Skew / Network Jitter | In `trade_candles.py`, `if bucket != self._bucket:` triggers if an out-of-order trade has `bucket < self._bucket`. This prematurely closes the newly opened bar and emits duplicate corrupted candles. | Guard with `if bucket > self._bucket:` and fold or ignore historical ticks. |
| 7 | Stale Signature Cache on Timeframe Switch | Low | State Desync | `setTimeframe()` resets `vacuumSig` and `hoplaSig`, but does not reset `keyLevelsSig`, `sweepsSig`, or clean up `keyLevelAnnotations` and `sweepAnnotations`. | Reset signatures and detach annotations inside `setTimeframe()`. |
| 8 | Rejection Wick Occlusion by Centered Sweep Text | Low | Visual Alignment Clutter | `TextAnnotation` defaults to `verticalAnchorPoint: Center` placed directly at `s.price` (the high or low wick). Text obscures the rejection wick rather than floating above/below. | Set `verticalAnchorPoint` to `Top` for swept lows and `Bottom` for swept highs with padding. |

---

## Actionable Punchlist

- [ ] **#1: `scichart-terminal/src/chart/TerminalChart.ts:797-800` — Runtime Crash on Null Key Levels**
  - **Attack Scenario:** On bridge initialization or session start, `frame.key_levels` contains `{ pdh: null, pdl: null, pwh: null, pwl: null }`. Because argument expressions in JavaScript evaluate prior to entering `mk`, evaluating `` `PDH ${kl.pdh!.toFixed(2)}` `` causes an immediate unhandled `TypeError` that crashes the entire animation loop on frame arrival.
  - **Fix:** Move formatting inside the helper or safely format after checking:
    ```ts
    const mk = (price: number | null, color: string, prefix: string) => {
      if (price == null || !Number.isFinite(price)) return;
      const line = new HorizontalLineAnnotation({
        y1: price,
        stroke: color,
        strokeThickness: 1.5,
        strokeDashArray: [8, 4],
        showLabel: true,
        labelPlacement: ELabelPlacement.TopLeft,
        axisLabelFill: color,
        axisLabelStroke: "#000000",
        labelValue: `${prefix} ${price.toFixed(2)}`,
      });
      this.surface.annotations.add(line);
      this.keyLevelAnnotations.push(line);
    };

    mk(kl.pdh, "#a855f7", "PDH");
    mk(kl.pdl, "#a855f7", "PDL");
    mk(kl.pwh, "#ec4899", "PWH");
    mk(kl.pwl, "#ec4899", "PWL");
    ```

- [ ] **#2: `scichart-terminal/src/chart/TerminalChart.ts:821` — Liquidity Sweeps Rendered in 1970 Off-Screen**
  - **Attack Scenario:** In `orderbook-bridge/engine/runtime.py:290`, `StructureEvent.time` is set from `k.t`, which is defined in `data.py:22` as epoch seconds. When `TerminalChart.ts` divides `s.time` by `1000` (`Math.floor(s.time / 1000)`), the timestamp is collapsed from ~1,740,000,000 to ~1,740,000 (January 1970). The markers are placed 55 years off the left edge of the chart canvas and never appear.
  - **Fix:** Normalize timestamp dynamically:
    ```ts
    for (const s of sweeps.slice(-10)) {
      // Handle both epoch seconds (from v74 Kline.t) and epoch ms
      const tSec = s.time > 1e11 ? Math.floor(s.time / 1000) : Math.floor(s.time);
      const color = s.dir > 0 ? "#22c55e" : "#ef4444";
      const marker = new TextAnnotation({
        x1: tSec,
        y1: s.price,
        yCoordinateMode: ECoordinateMode.DataValue,
        text: s.dir > 0 ? "▲ SWEEP" : "▼ SWEEP",
        textColor: color,
        fontSize: 9,
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: "bold",
        horizontalAnchorPoint: EHorizontalAnchorPoint.Center,
        verticalAnchorPoint: s.dir > 0 ? EVerticalAnchorPoint.Top : EVerticalAnchorPoint.Bottom,
      });
      this.surface.annotations.add(marker);
      this.sweepAnnotations.push(marker);
    }
    ```

- [ ] **#3: `scichart-terminal/src/chart/TerminalChart.ts:472-508` — Synthetic `volume: 0` Candles Unfixed**
  - **Attack Scenario:** Audit Finding F1 stated: *"Live candles are synthetic & volume-less — Heavy Absorption runs blind"*. Even though `trade_candle` and `cvd` were added to `bridge.py` and `frame.ts`, `updateCandles()` in `TerminalChart.ts` was not updated to read `frame.trade_candle`. It continues to build OHLC purely from `frame.mid_price` with hardcoded `volume: 0`. The entire Heavy Absorption overlay will decay to 0 within 3.3 hours.
  - **Fix:** In `updateCandles()`, consume `frame.trade_candle`:
    ```ts
    private updateCandles(frame: ChartFrame, nowSec: number): boolean {
      const tc = frame.trade_candle;
      const bucket = tc ? Math.floor(tc.t / 1000) : Math.floor(nowSec / this.tfSeconds) * this.tfSeconds;
      const price = tc ? tc.c : frame.mid_price;
      const vol = tc ? tc.v : 0;
      // Use trade-candle OHLC if available, fallback to mid-price tick
      ...
    ```

- [ ] **#4: `orderbook-bridge/analytics/absorption_engine.py:221` — Rapid Buffer Saturation in High-Frequency Loop**
  - **Attack Scenario:** `self._cluster_vol_history.append(total_vol)` executes on every single trade that meets the threshold. Since `total_vol` is calculated over a rolling 4000ms window, 50 trades in 1 second will append 50 almost-identical values to a deque with maxlen=500. Within 10 seconds of active market conditions, the entire history is wiped out and replaced with identical slices from that single burst. `_global_median()` becomes the instantaneous spike volume instead of a multi-hour session anchor.
  - **Fix:** Throttle cluster volume history updates so they are recorded at most once per observation window (e.g., every 4000ms), or let `update_session_baseline` exclusively manage `_cluster_vol_history`:
    ```python
    # Only record cluster volume at discrete non-overlapping intervals
    if current_time_ms - self._last_cluster_record_ms >= self.effective_window_ms:
        self._cluster_vol_history.append(total_vol)
        self._last_cluster_record_ms = current_time_ms
    ```

- [ ] **#5: `orderbook-bridge/bridge.py:311-344` — Missing Production Integration of `update_session_baseline`**
  - **Attack Scenario:** Regime normalization for absorption gates was implemented in `absorption_engine.py`, but `absorption_engine.update_session_baseline()` is never called in `bridge.py`. As a result, the volume gates remain static at `10.0 oz` across both thin Asian trading and volatile NY opens.
  - **Fix:** In `bridge.py:on_depth_update()` or upon bar close, compute the session cluster median from v74 volume metrics (or session profile) and push it to `absorption_engine.update_session_baseline(session_median_vol)`.

- [ ] **#6: `orderbook-bridge/analytics/trade_candles.py:107` — Out-of-Order Trade Ingestion in `TradeCandleAggregator`**
  - **Attack Scenario:** If an aggressor trade arrives delayed due to network transport jitter (`bucket < self._bucket`), `bucket != self._bucket` evaluates to `True`. The aggregator closes the currently forming bucket prematurely, steps backward, and then re-advances on the next trade, emitting duplicate and scrambled closed candle objects.
  - **Fix:** Ensure bucket progression only advances:
    ```python
    if bucket > self._bucket:
        closed = TradeCandle(...)
        self._bucket = bucket
        ...
    elif bucket == self._bucket:
        # Same bucket: update OHLCV
        ...
    # else: late/out-of-order trade: fold volume/delta into current or ignore
    ```

- [ ] **#7: `scichart-terminal/src/chart/TerminalChart.ts:428-447` — Timeframe Switch Cache Invalidation**
  - **Attack Scenario:** Switching timeframe clears candles and resets `vacuumSig` and `hoplaSig`, but leaves `this.keyLevelsSig` and `this.sweepsSig` active. When the new timeframe loads, if key levels or sweeps match the previous signature string, they will not be re-rendered on the reset surface.
  - **Fix:** In `setTimeframe()`, reset:
    ```ts
    this.keyLevelsSig = "";
    this.sweepsSig = "";
    for (const a of this.keyLevelAnnotations) this.surface?.annotations.remove(a);
    this.keyLevelAnnotations = [];
    for (const a of this.sweepAnnotations) this.surface?.annotations.remove(a);
    this.sweepAnnotations = [];
    ```

- [ ] **#8: `scichart-terminal/src/chart/TerminalChart.ts:823-834` — Wick Occlusion by Centered Sweep Text**
  - **Attack Scenario:** Bullish sweep occurs at candle low `k.l`. A text marker "▲ SWEEP" is placed at `y1: s.price` with default center vertical anchor point, drawing text directly on top of the bottom shadow/wick.
  - **Fix:** Set vertical anchor point according to sweep direction:
    ```ts
    verticalAnchorPoint: s.dir > 0 ? EVerticalAnchorPoint.Top : EVerticalAnchorPoint.Bottom,
    ```

---

## Team Sign-off

- [ ] Vulnerabilities Remediated
- [ ] Regression Tests Verified
