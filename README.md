# Institution Terminal

A personal, GPU-rendered order-flow terminal for **gold (XAU)**. It combines a
Bookmap-style liquidity heatmap, ATAS/DeepCharts-style absorption bubbles, the
OSC-VIP / REG **v7.4** signal engine (a Python port of the Pine strategies) and an
empirical signal ledger. All of it is shown on one SciChart.js chart.

> **Not financial advice.** The terminal shows signals and statistics; it does not
> place orders. Every "win rate" it shows is a *measured*, cost-adjusted hit rate
> from the ledger, never a model guess.

---

## Contents

1. [Quick start](#1-quick-start)
2. [Architecture](#2-architecture)
3. [Configuration](#3-configuration)
4. [Using the terminal](#4-using-the-terminal)
5. [Market-data providers](#5-market-data-providers)
6. [Signals, ledger & backtesting](#6-signals-ledger--backtesting)
7. [Keyboard & mouse reference](#7-keyboard--mouse-reference)
8. [Troubleshooting](#8-troubleshooting)
9. [Security](#9-security)
10. [Development](#10-development)

---

## 1. Quick start

**Requirements:** macOS / Linux / Windows, Python 3.12+ (repo `.venv` uses 3.14),
Node.js 22+, pnpm, and a browser with WebGL2 (Chrome, Edge, Brave, Safari 17+).

```bash
# 0. one-time setup (from the repo root)
python3 -m venv .venv && .venv/bin/pip install websockets numpy pytest
(cd scichart-terminal && pnpm install)
cp .env.example .env            # optional: OANDA / Telegram credentials

# 1. start the data bridge (terminal 1)
PYTHONPATH=orderbook-bridge:. .venv/bin/python3 orderbook-bridge/bridge.py

# 2. start the terminal UI (terminal 2)
cd scichart-terminal && pnpm dev
```

Open **http://localhost:5273**.

On first start the bridge **warms up**: it replays ~30 days of bars through the v7.4
engine so every indicator matches its Pine state. This takes about 10–60 s. The chart
is live straight away; the Signals panel shows *Warming up* until the engine is ready.

For a production build: `cd scichart-terminal && pnpm build && pnpm preview`.

---

## 2. Architecture

```
 Venue (Binance USDⓈ-M  |  OANDA v20)
        │  depth / trades / quotes / klines
        ▼
 orderbook-bridge  (Python, ws://localhost:8765)
   market_data/   provider adapters, local order book
   analytics/     liquidity zones, absorption, vacuum, VWAP-Z, SMPI, bubble regime
   engine/        v7.4 OSC + REG engine, risk plans, SQLite ledger, calibration
        │  JSON frames ~14 fps  +  request/response commands
        ▼
 scichart-terminal (React + SciChart.js WebGL, http://localhost:5273)
```

| Folder | What it is |
| --- | --- |
| `orderbook-bridge/` | Data backend + signal engine. See its [README](orderbook-bridge/README.md) |
| `scichart-terminal/` | **The terminal UI** (current). See its [README](scichart-terminal/README.md) |
| `trading-terminal/` | Legacy Lightweight-Charts UI (kept for reference) |
| `pine-strategy/7.4/` | Source Pine scripts the engine is ported from |
| `data/` | Runtime state: ledgers (`*.db`), kline cache, `config.json`, recordings (git-ignored) |

---

## 3. Configuration

### `.env` (repo root, git-ignored)

Only these keys are read from `.env`:

| Key | Purpose |
| --- | --- |
| `OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID` | Enables the OANDA provider |
| `OANDA_ENV` | `practice` (default) or `live` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Opt-in Telegram alerts for new signals |
| `ALERT_TIERS` | Tiers to push, e.g. `A_PLUS` or `A_PLUS,STRUCTURAL` |

### Shell environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MARKET_PROVIDER` | — | `binance` or `oanda`; overrides the choice saved from the UI |
| `BRIDGE_HOST` | `localhost` | Bind address. The socket has no auth, so keep it local |
| `BRIDGE_PORT` | `8765` | Bridge port. The UI follows `VITE_BRIDGE_URL` (see below) |
| `BRIDGE_ALLOWED_ORIGINS` | — | Extra browser origins allowed to connect (comma-separated) |
| `OANDA_HISTORY_DAYS` | `180` | How far back OANDA history is backfilled |
| `VITE_BRIDGE_URL` | `ws://localhost:8765` | Frontend: bridge address (set when running `pnpm dev`) |

### Saved state

| Where | What |
| --- | --- |
| `data/config.json` | Active provider, risk settings per provider (`risk`, `risk_oanda`) |
| `data/ledger.db`, `data/ledger_oanda.db` | Signal ledgers (backtest + live), one per provider |
| Browser localStorage | Theme, chart colours, crosshair, heatmap fade, alert sound |

---

## 4. Using the terminal

### 4.1 Header at a glance

```
[● XAUUSDT PERP BINANCE ▾] [1m 5m 15m ⟳ ✛]   MID · SPR · BOOK   CVD · Δ   [layers] [panels] [🎨 🔔 theme ● LIVE]
  instrument / provider     timeframe, live,   live quote        order      chart     signals,  colours, sound,
  menu                      crosshair                            flow       layers    DOM, flow, theme, connection
                                                                                       diags
```

- **Instrument chip**: shows the symbol, contract type and provider. Click it to
  switch provider (see [§5](#5-market-data-providers)).
- **Timeframe**: `1m`, `5m` or `15m`. Switching reloads up to 1,000 candles of history.
- **⟳ Live**: snaps back to the live edge after you zoom or pan.
- **✛ Crosshair**: turns the crosshair and OHLC readout on or off.
- **Connection dot**: green means *Live*, amber means *Connecting*, red means
  *Offline*. The UI reconnects automatically.

### 4.2 Chart layers

| Button | Layer | How to read it |
| --- | --- | --- |
| **Heatmap** | Resting limit-order liquidity over time | Brighter = more size resting at that price. Walls that persist are levels the market respects or has to absorb. The ▾ next to it sets the **fade**: older liquidity dims so the live edge stands out |
| **Absorb** | Absorption bubbles | Aggressive orders that hit resting liquidity **without moving price**. Blue = buyers absorbed (often near highs), pink = sellers absorbed (often near lows). Size = strength: normal → **wall** (hit a resting wall) → **battle** (absorbed while open interest rose; brightest, with a light ring). The number is the candle's volume as % of its 20-bar average, or the absorbed size in oz for live-tape bubbles. **Click a bubble** for details |
| **Vacuum** | Liquidity-vacuum pockets + 🧲 magnet | Untraded price pockets that price tends to move through quickly. Red = equal highs/lows (strongest), orange = unfilled gaps (FVGs), grey = jumps between bars. The cyan 🧲 line is the nearest pocket in the direction of pull |
| **Hopla** | 3 % / 50 % / 97 % range | Session range extremes and equilibrium |
| **Delta** | Volume-delta candle colouring | Body colour = sign of aggressor delta, brightness = size of the imbalance. Wick/outline = price direction. **A green outline with a red body** means price rose while sellers were the aggressors (absorption/divergence) |

Always on: the **MARK** price line, prior-day/week highs and lows (**PDH/PDL/PWH/PWL**),
🎯 liquidity sweeps, 💥 liquidation flushes, ⚡ vacuum breakouts, ▲/▼ signal
markers, and the active trade plan (**ENTRY / SL / TP1 / TP2** lines).

If a layer button is greyed out, the active provider does not supply its data. Hover
the button to see why.

### 4.3 Crosshair & OHLC readout

Move the mouse over the chart and you get:

- dashed crosshair lines with **time and price labels** on the axes;
- a legend at the top-left with **time · O · H · L · C · change (%) · volume · Δ** for
  the candle under the cursor, and **⌖** for the price at the cursor. Change, volume
  and Δ are for the whole candle.

When the mouse leaves the chart, the legend shows the **live** candle. Times are UTC.
On OANDA the volume field reads **Ticks** (quote-change count) and Δ is hidden.
Toggle with **✛** or **Alt+C**.

### 4.4 Chart colours (🎨)

The 🎨 button opens the colour settings. Changes apply instantly and are saved in
the browser.

- **Presets**: *Classic* (default), *Mono*, *Hollow-ish*, and *Colour-blind*
  (blue/orange candles and cyan/yellow bubbles, for red-green colour blindness).
- **Candles**: up body, down body, up wick/outline, down wick/outline. The Delta layer
  uses the same up/down body colours.
- **Absorption bubbles**: buyers colour, sellers colour, colour of the number, and
  fill opacity (10–100 %). The wall and battle sizes are worked out from the same
  colour; battle bubbles always stay near-opaque so they stand out.
- **Reset to defaults** restores the shipped look.

### 4.5 Side panels

| Panel | Shortcut | Contents |
| --- | --- | --- |
| **Signals** | — | v7.4 engine for **5m / 15m** in three tabs. **Signal**: the open trade plan, long/short checklist (killzone, shock guard, volume, conflict, cooldown), market context (regime, 4H trend, VWAP-Z/SMPI, ATR). **Ledger**: measured results per setup. **Risk**: equity, risk %, fees, stop/target multiples |
| **DOM** | Alt+D | Order-book ladder (top 25 levels), top-of-book imbalance meter, resting walls |
| **Flow** | — | Bubble-regime feed (absorption opens, liquidation flushes, vacuum breakouts), CVD and open interest |
| **Diags** | — | Feed health (latency, sync state, reconnects, sequence gaps), contract info, and the **recorder/replay** controls |

**🔔** toggles the chime for new **A+** signals. Every A+ signal also raises a toast
with entry, SL, TP1 and the measured win rate. **Theme** cycles through dark,
high-contrast and light.

---

## 5. Market-data providers

Click the instrument chip and choose a provider. The bridge saves the choice and
**restarts itself (~5 s)**; the chart clears and reloads from the new venue. Each
provider has its **own ledger and risk settings**, so statistics are never mixed.

| | **Binance USDⓈ-M** (default) | **OANDA v20** |
| --- | --- | --- |
| Instrument | XAUUSDT perpetual | XAU/USD CFD |
| Order-book depth / heatmap | ✔ 1,000-level synchronised book | — quotes only |
| Trade tape, absorption, sweep regimes | ✔ | — (bar-close absorption detector only) |
| Open interest, liquidations, funding | ✔ | — |
| Volume | traded (oz) | tick count |
| Delta / CVD | exchange taker delta | tick-rule estimate (CVD only) |
| Costs in ledger | taker fee + slippage | spread (~$0.35), no commission |
| Credentials | none | `OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID`, `OANDA_ENV` |

The terminal never fakes missing data. On OANDA the heatmap and Delta layers are
disabled, and live absorption and regime classification are switched off, because
their inputs (a real order book and real trades with size) don't exist there.

**Enabling OANDA:** in the OANDA hub, open *Manage API Access* and create a token.
Put the token, your account ID and `OANDA_ENV` into `.env`, then pick OANDA in the
menu. Until the credentials are set, OANDA appears greyed out with the reason shown.

---

## 6. Signals, ledger & backtesting

**Tiers.** *A+* is a high-conviction setup with every gate passed. *Structural* is a
valid structure with lower conviction. *Trap* means friction or counter-momentum, so
do not trade it. Only A+ and Structural are drawn on the chart.

**Win rates are measured, not predicted.** Every signal is recorded in the SQLite
ledger and scored by a conservative rule:

- the entry is the close of the signal bar;
- the stop is hit → −1 R;
- TP1 is hit first → a win;
- both are hit inside the same bar → counted as a loss;
- otherwise the trade closes at the horizon.

Fees and slippage are subtracted. The UI shows a Beta(2,2)-smoothed rate with a 95 %
Wilson interval, and shows grey **warm-up** until a setup has **15 or more** samples.

Fill the ledger with history using a backtest, which runs the identical live code
path:

```bash
cd orderbook-bridge
../.venv/bin/python -m engine.backtest --tf 5m --tf 15m                 # active provider
../.venv/bin/python -m engine.backtest --provider oanda --tf 5m         # OANDA ledger
```

**Trade plans** (Risk tab): stops scale with session volatility and move behind a
resting wall when one sits within 0.5 ATR. TP1 and TP2 are multiples of the stop.
Size comes from equity × risk %, capped by leverage. Plans whose costs exceed 30 % of
1 R are flagged `cost_heavy`. Guardrails (max trades per day, daily loss limit,
consecutive losses) show as warnings in the Signals panel.

---

## 7. Keyboard & mouse reference

| Action | Input |
| --- | --- |
| Zoom time axis | Mouse wheel |
| Pan | Click-drag |
| Back to live edge | Double-click chart, or **⟳ Live** |
| Inspect an absorption bubble | Click it |
| Crosshair on/off | **Alt+C** |
| DOM ladder on/off | **Alt+D** |
| Close any menu | **Esc** or click outside |

---

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Header shows **Offline** | The bridge isn't running, or it's on another port. Start it, or run `VITE_BRIDGE_URL=ws://localhost:<port> pnpm dev` |
| Bridge log: `HTTP 403` on connect | You opened the UI from a non-localhost address. Add it to `BRIDGE_ALLOWED_ORIGINS` |
| Signals panel stuck on *Warming up* | The first warm-up downloads history; wait about a minute. The kline cache in `data/cache/` makes later starts fast |
| OANDA greyed out in the provider menu | Set `OANDA_API_TOKEN` and `OANDA_ACCOUNT_ID` in `.env`, then reopen the menu |
| `OANDA HTTP 401` in the bridge log | Wrong token, or a practice token used with `OANDA_ENV=live` (or the reverse) |
| "History unavailable" toast | The venue's REST API is unreachable. On Binance, the UI falls back to Binance's public API by itself |
| Chart blank or white | WebGL2 is disabled. Enable hardware acceleration in the browser |
| Win rate shows *warm-up* | Fewer than 15 samples. Run a backtest (§6) |
| Small SciChart watermark | Expected: the free Community licence ([details](scichart-terminal/README.md#licensing)) |

---

## 9. Security

- The bridge binds to **localhost** and rejects browser connections from other
  websites. It has **no authentication** and accepts control commands (risk
  settings, provider switch, recording). Do not expose it with
  `BRIDGE_HOST=0.0.0.0` except on a trusted network.
- API tokens live only in `.env` (git-ignored) and stay on the server. The browser
  never sees them, and they are masked in logs.
- Telegram alerts carry only signal details, never account data.

---

## 10. Development

```bash
# backend tests (from orderbook-bridge/)
../.venv/bin/python -m pytest tests -q

# frontend type-check + production build, and unit tests (from scichart-terminal/)
pnpm build
pnpm test
```

Component-level docs: [orderbook-bridge/README.md](orderbook-bridge/README.md) covers
engines, providers and the WebSocket commands.
[scichart-terminal/README.md](scichart-terminal/README.md) covers the rendering
pipeline, performance notes and licensing.
