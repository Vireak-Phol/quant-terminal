# Workspace Rules & Capabilities

## TradingView MCP Integration (Jackson Fork) - Cross-Platform (macOS & Windows)
- **Agent OS Auto-Detection**: Check current host OS before executing commands.
- **Installation Paths**:
  - **macOS**: `~/tradingview-mcp-jackson` (or `/Users/vireakphol/tradingview-mcp-jackson`)
  - **Windows**: `C:\Users\sinim\tradingview-mcp-jackson` (or `%USERPROFILE%\tradingview-mcp-jackson`)
- **Claude / MCP Config**:
  - **macOS**: `~/.claude.json` (Claude Code) and `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop)
  - **Windows**: `~/.claude.json` (Claude Code) and `%APPDATA%\Claude\claude_desktop_config.json` (Claude Desktop)
- **TradingView Desktop App CDP Connection**:
  - Requires TradingView Desktop running with Chrome DevTools Protocol (CDP) enabled on port 9222.
  - **Launch Debug Mode**:
    - **macOS**: `node ~/tradingview-mcp-jackson/src/cli/index.js launch` (or prompt `"run tv_launch"`)
    - **Windows**: Execute `launch_tv_debug.bat` or `node C:\Users\sinim\tradingview-mcp-jackson\src\cli\index.js launch` (or prompt `"run tv_launch"`)
- **Direct CLI Access Commands** (Run from local `tradingview-mcp-jackson` directory):
  - `node src/cli/index.js screenshot` — Capture active chart screenshot
  - `node src/cli/index.js brief` — Run morning brief & read chart labels/lines/tables
  - `node src/cli/index.js state` — Read current chart symbol, timeframe & studies
- **Capabilities**:
  - Read charts directly from local TradingView Desktop app (`morning_brief`, `chart_get_state`, `data_get_study_values`, `quote_get`, `capture_screenshot`).
  - Read Pine Script indicator drawings, lines, labels, boxes (`data_get_pine_lines`, `data_get_pine_labels`, `data_get_pine_tables`).
  - Execute morning briefs (`tv brief` or `morning_brief`), pine script editing, layout changes, replay practice, and visual chart analysis.

## Remember
- Make sure your response don't just make it done, please be careful with existing logic, if u concerned please ask me first.
- **File Search Scope**: Unless explicit context or file paths are specified in the prompt, strictly limit searches and edits to the currently open active file tab. Do NOT search across other project files without asking first.

---

## V6 Indicator System & Chart Analysis Rules (OSC-VIP V6 & REG-V6)

### 1. System Scope & Indicator Files
All V6 chart analysis and signal evaluation must be performed strictly using the logic defined in:
1. **`OSC-vip-v6.pine` (OSC-VIP V6 Institutional)**: Single-Slot Bayesian Execution & Microstructure Engine.
2. **`REG-V6.pine` (REG-V6)**: Structural & Calibration Engine (FVG Breakers, RPD, SMC, Liquidity Sweeps, Linear Regression Channels/OBs, Signal Ledger).

### 2. Bayesian Signal Tiers & Win Probabilities (`OSC-vip-v6.pine`)
Classify chart signals into the 3-Tier Bayesian Matrix:
- **Tier 1: A+ Harmonized Execution Signal (Bright Label + ATR SL/TP)**
  - **Win Probability**: $\ge 65.0\%$ (`minAplusWinProb`).
  - **Prerequisites**: Bar confirmed, Active Killzone, No Shock Guard, Volume Gate (`volZ > 0`), and **No Directional Conflict** (`opposite Win Prob < 55.0%`).
  - **Execution**: Valid high-conviction trade. Use Entry at close, Stop Loss at $1.5 \times \text{ATR}$, TP1 at $2.0 \times \text{ATR}$, TP2 at $3.5 \times \text{ATR}$.
- **Tier 2: Structural-Only Signal (Standard Outline / Circle)**
  - **Win Probability**: $50.0\% - 65.0\%$.
  - **Execution**: Moderate conviction setup. Reduce position size (e.g., 0.5R) or require confluence from REG-V6 setups.
- **Tier 3: Trap Warning / Friction (Dimmed Gray "⚠️ TRAP" / `x`)**
  - **Win Probability**: $< 50.0\%$.
  - **Execution**: **DO NOT TRADE**. High friction or counter-momentum trap risk.

### 3. Conflict Resolution & Multi-Signal Rules
When opposing signals coexist (e.g., Short signal alongside a lower-probability Long):
1. **Directional Conflict Suppression**: If an opposing signal has Win Prob $\ge 55.0\%$, A+ elevation is automatically suppressed.
2. **Primary Rule**: Always prioritize the higher-probability, higher-tier signal.
3. **Disregard Lower-Probability Setups**: If a Short signal triggers while a Long setup has $< 50\%$ (or $< 55\%$) probability:
   - **Ignore the Long setup completely** (classified as friction/trap risk).
   - Execute the Short trade if Short Win Prob $\ge 65\%$ (A+) or $50-65\%$ (Structural with reduced size).
4. **HTF Alignment**: Verify signal direction against the 4H 200 EMA (`htfBullTrend` / `htfBearTrend`). HTF trend agreement provides positive Bayesian log-odds weighting.

### 4. Environmental & Microstructure Guards
- **Macro Shock Guard**: If active (`tr > 3.5 * atr100` within 15 bars), all signals are muted due to extreme volatility spikes (news/CPI/FOMC).
- **Session Killzones**: Check whether the bar is inside London (`0200-0500`), NY AM (`0830-1100`), or Asia (`2000-0000`) sessions (NY Time). Signals outside killzones suffer a log-odds penalty.
- **Kaufman ER Regime**:
  - Trending (`erVal > 0.45`): Trend-following setups (CHoCH / RegOB breaks) have higher win probability.
  - Ranging (`erVal < 0.20`): Reversal setups (vwapZ overextension $\le -1.5$ or $\ge 1.5$, RPD peaks/valleys) have higher probability.
- **SMPI (Smart Money Pressure Index)**: Institutional order flow direction ($> 0$ for Long, $< 0$ for Short).

### 5. REG-V6 Structural Confluence
Cross-reference signals with `REG-V6.pine` elements:
- **Unicorn Setup**: Confluence of Fair Value Gap + Breaker block.
- **RegOB (Regression Order Block)**: Bounces/breaks of linear regression channels (`regLength = 100`).
- **RPD (Reversal Pattern Detection)**: Empirical reversal peaks and valleys.
- **Liquidity Sweeps**: Sweeps of 20-bar high/low followed by directional rejection.

### 6. Standard Chart Analysis Workflow for AI
When analyzing any chart or signal for the user:
1. **Check Bar Confirmation & Shock Guard**: Ensure signal is finalized and no news shock mutes the setup.
2. **Evaluate Bayesian Win Probabilities**: State `longWinProb` % and `shortWinProb` %.
3. **Identify Signal Tier**: Categorize as A+ ($\ge 65\%$), Structural ($50-65\%$), or Trap ($< 50\%$).
4. **Apply Conflict Resolution**: Filter out low-probability counter-signals ($< 55\%$).
5. **Check Microstructure & REG-V6 Confluence**: HTF 4H 200 EMA, Killzone, SMPI, RegOB, Unicorn, RPD.
6. **Deliver Clear Execution Plan**: Entry, Stop Loss ($1.5 \times \text{ATR}$), TP1 ($2.0 \times \text{ATR}$), TP2 ($3.5 \times \text{ATR}$), and position size.

### 7. AI Snapshot Generation & Persistence Rules
When generating an AI chart analysis or saving a trading terminal snapshot:
1. **Format as V2 DailyAnalysis JSON**: Ensure the analysis payload follows `trading-terminal/public/template.json` with `meta` (as_of timestamp, generator, last_price), `v6` (win probabilities, ER, SMPI, gates), `big_money_analysis`, `technical_confluence`, `risk_assessment`, `micro`, and `calendar`.
2. **Persist Snapshot**: Save the snapshot JSON using the persistence helper script:
   `node trading-terminal/scripts/save-snapshot.cjs <path-to-json-file>`
   This automatically creates `public/snapshots/YYYY-MM-DD-symbol.json` and updates `public/snapshots/index.json` manifest.
3. **Verify Load in Terminal**: Confirm the new session entry is registered in `public/snapshots/index.json` so the trading terminal UI immediately displays the new snapshot in the symbol switcher and date scrubber.

---

## Big Money Analysis Checklist (Beyond the Chart)

For every chart analysis, also pull and assess these institutional layers:

### 1. Order Flow & Tape
- Cumulative Volume Delta (CVD) direction
- Footprint / bid-ask imbalance
- Iceberg / hidden order detection (if visible)

### 2. COT Report (Commitment of Traders)
- Commercial hedgers (smart money) vs. speculators positioning
- Net long/short changes week-over-week for the asset

### 3. Macro Correlation Matrix
- **DXY** (USD Index) — inverse correlation with gold
- **Real yields** (TIPS) — gold's true opportunity cost
- **US 10Y yield** — real rate direction
- **Gold/Silver ratio** — risk appetite signal

### 4. Central Bank Activity
- Official sector gold purchases (China, India, Turkey, Poland, etc.)
- LBMA vault data / London gold flows (if available)
- COMEX inventory & delivery volumes

### 5. Intermarket Context
- Equities (risk-on/off), commodities basket
- Copper (Dr. Copper — economic health)
- Gold vs. BTC (digital gold narrative)

### 6. Event Calendar / Macro Risk
- FOMC, NFP, CPI, PPI, GDP, ECB/BOJ/BOE decisions
- Check Forex Factory or economic calendar for today's events

### 7. Options Flow
- Gamma levels on GLD / XAU options
- Large OTC barrier strikes (often round numbers: 4,000, 4,050, 4,100)

### 8. Delivery Method
When presenting analysis, include these alongside chart technicals in a structured format (correlation data, COT summary, calendar events, options gamma levels).

---

## Trading Terminal & Microstructure Architecture (Full-Stack Specs)

### 1. Dual-Process Architecture & Port Map
- **Backend Bridge** (`orderbook-bridge/`):
  - Async Python WebSocket daemon streaming Binance USDⓈ-M Futures (`XAUUSDT`).
  - Ingests `xauusdt@depth@100ms`, `xauusdt@aggTrade`, and `xauusdt@markPrice@1s`.
  - Aggregates resting depth into liquidity zones and evaluates live absorption candidates.
  - Broadcasts on **`ws://localhost:8765`**.
  - **Run Command**: `PYTHONPATH=orderbook-bridge:. .venv/bin/python3 orderbook-bridge/bridge.py`
- **Frontend Cockpit** (`trading-terminal/`):
  - Vite + React 18 + TypeScript + Tailwind CSS + Lightweight Charts v5.
  - Runs on **`http://localhost:5173`**.
  - **Dev Server**: `cd trading-terminal && pnpm dev`
  - **Build Verification**: `cd trading-terminal && pnpm build`

### 2. Active Chart Component (`TradingViewDeepChart.tsx`)
Located at [`trading-terminal/src/components/Dashboard/TradingViewDeepChart.tsx`](trading-terminal/src/components/Dashboard/TradingViewDeepChart.tsx).
- **Chart Stack**: Full-bleed Lightweight Charts Candlestick Series (`candleSeriesRef`) + Volume Histogram (`volumeSeriesRef`) + High-performance 2D Canvas Overlay (`overlayCanvasRef`).
- **TradingView "Heavy Absorption" Indicator Engine**:
  - **Detection Algorithm (`detectHeavyAbsorptions`)**: Evaluates rolling 20-period volume average and rolling 20-period True Range (ATR) across candlestick history and updates on real-time ticks.
  - **Conditions**:
    1. *Buyers Absorbed*: Upper wick dominance $\ge 35\%$ with volume ratio $\ge 70\%$, or $\ge 48\%$ wick with $\ge 55\%$ volume, or volume spike $\ge 130\%$ with $\ge 28\%$ upper wick. Placed at candle `high`.
    2. *Sellers Absorbed*: Lower wick dominance $\ge 35\%$ with volume ratio $\ge 70\%$, or $\ge 48\%$ wick with $\ge 55\%$ volume, or volume spike $\ge 130\%$ with $\ge 28\%$ lower wick. Placed at candle `low`.
    3. *High Volume Effort-vs-Result Spikes*: Volume ratio $\ge 175\%$ with compressed or normal spread. Placed at candle mid-point.
  - **Canvas Rendering**:
    - **`BUYERS ABSORBED`**: Red watermark text (`rgba(239, 68, 68, 0.88)`) top right.
    - **`SELLERS ABSORBED`**: Green watermark text (`rgba(34, 197, 94, 0.88)`) bottom left (clearing bottom legend).
    - **Translucent Bubbles**: Bullish bars = translucent emerald (`rgba(16, 185, 129, 0.40)`) with `#34d399` stroke; Bearish bars = translucent crimson (`rgba(239, 68, 68, 0.40)`) with `#f87171` stroke.
    - **Centered Numbers**: Crisp white volume ratio % (e.g., `80`, `130`, `187`, `99`, `129`).
  - **Click-to-Inspect Tooltip**: Clicking any bubble opens `🎯 Heavy Absorption Detector` showing price anchor, volume ratio vs 20-SMA, wick rejection %, bar bias, and institutional explanation.

### 2b. v7.4 Signal Engine (`orderbook-bridge/engine/`)
- Python port of OSC-VIP v7.4 + REG v7.4 (bar-for-bar parity tests in `orderbook-bridge/tests/`). Bridge publishes `terminal_state["v74"]` (only when changed); frontend types in `trading-terminal/src/types/v74.ts`.
- **Honest-probability rule**: UI "win rate" = measured ledger hit rate after fees/slippage (Beta(2,2), Wilson CI, warm-up < 15 samples). Never label the OSC model score as a probability.
- Chart layers live in `Dashboard/v74ChartLayers.ts`; panel in `Dashboard/V7SignalPanel.tsx`. Legacy `v7_engine.py` / `v7_signal` removed.

### 3. Deliberate Architectural Invariants (DO NOT REVERT)
1. **NO VWAP OR EMA LINES**: VWAP and EMA 20 lines were intentionally removed from the terminal chart to maximize raw price action and microstructure visibility. Do NOT re-add them unless explicitly requested.
2. **Zone Guide Line Gating (No Ghost Lines)**:
   - Dashed horizontal guide lines across the chart are strictly gated to levels that have successfully placed text badges or are classified as mega-walls (`labeledZoneIds.has(zone.id) || isMegaWall`).
   - Minor unlabeled depth levels render strictly as resting profile histogram bars on the right margin to prevent chart clutter.
3. **Mark Price Line**: Has `axisLabelVisible: true` so the `MARK` badge is permanently visible on the price axis.
4. **Scope Control**: Keep all terminal edits focused on the active component tab [`TradingViewDeepChart.tsx`](trading-terminal/src/components/Dashboard/TradingViewDeepChart.tsx) and [`App.tsx`](trading-terminal/src/App.tsx).