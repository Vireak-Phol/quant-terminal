# Real-Time Market Microstructure Terminal

A professional-grade real-time market microstructure visualization and order-flow terminal for **Binance USDⓈ-M Futures XAUUSDT** (`TRADIFI_PERPETUAL`).

Combines sequence-synchronized Level-2 depth, horizontal resting liquidity zones, absorption bubbles, Depth of Market (DOM) ladder, and Bayesian log-odds confluence scoring with high-performance Lightweight-Charts v5.

---

## 1. Key Capabilities

1. **Binance USDⓈ-M Futures Market Data Engine**:
   - Primary Instrument: `XAUUSDT` (`contractType: TRADIFI_PERPETUAL`, tick size `$0.01`, step size `0.001` oz).
   - Sequence-synchronized order book with automatic REST snapshot reconciliation and gap recovery.
   - Live stream over WebSocket (`xauusdt@depth@100ms`, `xauusdt@aggTrade`, `xauusdt@kline_1m`, `xauusdt@markPrice@1s`).

2. **Feature A — Resting Liquidity Zones Overlay (Bookmap-Inspired)**:
   - Evaluates resting depth against absolute quantity ($\ge 15.0$ oz), notional value ($\ge \$50,000$), and relative multiple of mean depth ($\ge 2.0\times$).
   - Clusters adjacent price levels into contiguous zones.
   - Full lifecycle state machine: `active`, `reduced`, `removed`, `replenished`, and `uncertain`.
   - Dynamic visual intensity, edge extension, and click inspection tooltip.

3. **Feature B — Heavy Absorption & Footprint Bubbles**:
   - **TradingView Heavy Absorption Indicator**: Analyzes rolling 20-period volume average and True Range (ATR) across historical candlesticks and real-time ticks.
   - Detects Buyers Absorbed (trapped buying at highs) and Sellers Absorbed (trapped selling at lows) with wick rejection ratios $\ge 35\%$ and volume spikes $\ge 175\%$.
   - Plotted as translucent green bubbles (bullish bars) and red bubbles (bearish bars) containing centered volume ratio numbers (e.g. `80`, `130`, `187`).
   - High-contrast canvas watermarks: `BUYERS ABSORBED` (red, top right) and `SELLERS ABSORBED` (green, bottom left).
   - Ingests real-time executed trade flow from Python bridge with dynamic alpha decay for live session footprints.
   - Interactive click inspection tooltip (`🎯 Heavy Absorption Detector`).

4. **Feature C — Professional Candlestick Chart**:
   - Lightweight-Charts v5 full-bleed candlestick chart.
   - Timeframes: `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`.
   - Volume histogram sub-panel.
   - **No EMA or VWAP lines** (deliberately removed to maintain institutional price action clarity).
   - Best Bid, Best Ask, and Mark Price reference lines with visible axis labels.
   - **Gated guide lines**: Dashed guide lines across the chart are strictly gated to labeled badges and mega-walls to eliminate visual clutter.

5. **Observability & Diagnostics**:
   - Connection state, order book sync state, feed latency, and reconnect count.
   - Sequence gap detection and recovery counter.
   - Integrated session recorder and replay player with adjustable speeds ($1\times - 10\times$).

---

## 2. Quick Run Guide

### Step 1: Start the Python Backend Bridge
From repository root:
```bash
PYTHONPATH=orderbook-bridge:. .venv/bin/python3 orderbook-bridge/bridge.py
```

### Step 2: Start the React Terminal
In a separate terminal:
```bash
cd trading-terminal
npm run dev
```
Open [http://localhost:5173](http://localhost:5173).

### Step 3: Run Automated Test Suites
```bash
cd orderbook-bridge && ../.venv/bin/python -m pytest tests -q   # engine + Pine parity
cd trading-terminal && pnpm test                                # UI
```

### v7.4 Signal Engine UI
- **★ SIGNALS** panel (5m / 15m): active trade plan (entry, SL, TP1/TP2, size, cost in R), **measured** win rate with 95% CI and net expectancy (gray *warm-up* until n ≥ 15), long/short gate checklist, market context, recent signals. Tabs: **Ledger** (backtest vs live per setup, gross vs net, reliability chart) and **Risk** (equity, risk %, fees, leverage, stop/TP multiples, guardrail limits).
- **Chart layers** (top-left toggles, persisted): Signals, Trade box, Structure (Unicorn FVG/breaker, RegOB, PDH/PDL, sweeps, RPD), Hopla 3/50/97, Vacuum pockets + magnet, History (closed outcomes in R). All distance-culled; no VWAP/EMA lines.
- **Alerts**: toast + chime for each new live A+ (🔔 toggle in header); Telegram via `.env`.
- Soft guardrail banner: daily -3R, 3 losses in a row, 5 A+ trades/day (configurable).
- `VITE_BRIDGE_URL` overrides the default `ws://localhost:8765`.
