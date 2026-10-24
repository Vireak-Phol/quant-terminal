# SciChart Terminal — personal order-flow terminal

A GPU-rendered, personal trading terminal built on **SciChart.js** (free Community
Edition) that visualises three institutional order-flow lenses on one chart:

| Overlay | Inspired by | Source data | Rendering |
| --- | --- | --- | --- |
| **Liquidity cluster heatmap** | Bookmap | `liquidity_zones[]` (resting limit-order volume) | `UniformHeatmapDataSeries` — rolling price×time grid, colour = displayed volume |
| **Absorption bubbles** | ATAS | `absorption_candidates[]` (aggressive volume absorbed w/o price move) | `XyScatterRenderableSeries` + `EllipsePointMarker` |
| **Liquidity vacuum** | OSC-VIP v7.4 Pine | `vacuum_zones[]` + `vacuum_magnet` | `BoxAnnotation` per pocket + magnet `HorizontalLineAnnotation` |

It **reuses the existing Python `orderbook-bridge`** as the data backend over
WebSocket. The bridge serves one of two venues, switchable from the instrument chip
in the header:

| Provider | Instrument | L2 heatmap | Absorption / regime | Delta candles | Volume |
| --- | --- | --- | --- | --- | --- |
| Binance USDⓈ-M (default) | XAUUSDT perp | ✔ | ✔ (real tape, OI, liquidations) | ✔ exchange taker delta | traded |
| OANDA v20 | XAU/USD CFD | — (quotes only) | bar-close detector only | — | tick count |

Layers whose data the active venue lacks are disabled in the toolbar (hover for the
reason) rather than drawn from fabricated inputs. Chart history is fetched **through
the bridge** (`get_klines`), so OANDA credentials stay server-side; if the bridge is
down and the venue is Binance, the chart falls back to Binance public REST.

---

## Architecture

```
Binance USDⓈ-M Futures  ──►  orderbook-bridge (Python, ws://localhost:8765)
                                  │  analytics/liquidity_zones.py   -> liquidity_zones[]
                                  │  analytics/absorption_engine.py -> absorption_candidates[]
                                  │  analytics/vacuum_engine.py     -> vacuum_zones[] + vacuum_magnet
                                  ▼
                              bookmap_update JSON frame
                                  ▼
                         scichart-terminal (React + SciChart.js)
```

### The vacuum engine

`orderbook-bridge/analytics/vacuum_engine.py` is an exact Python port of the
Liquidity Vacuum engine from `pine-strategy/7.4/OSC-vip-v7-4-lite.pine`. A "vacuum"
is an **untraded price pocket** in front of resting stops that price accelerates
through. Three confirmed-bar sources, ranked by strength:

1. **Equal highs / lows** → clustered stop pools — strength **3** (strongest)
2. **Unmitigated FVGs** → single-bar voids — strength **2**
3. **Displacement voids** → multi-bar impulse gaps — strength **1**

Lifecycle (identical to the Pine source): dedupe within `0.30×ATR`, a pocket dies
when price **closes through** it / its wick-scan **fill ≥ 0.85** / it is older than
**150 bars**; capped at **3 per side** (drop weakest, ties → oldest). The **magnet**
is the nearest live pocket on each side with effective strength
`3·exp(-dist / (ATR·1.5))`.

The bridge builds 1-minute candles from the live mid-price stream (see
`_CandleAggregator` in `bridge.py`) and feeds only **closed** bars to the engine, so
the output never repaints.

---

## Running it

### 1. Start the Python bridge (backend)

From the repo root:

```bash
# one-time: deps are already in .venv; if not:
#   python3 -m venv .venv && .venv/bin/pip install websockets aiohttp

.venv/bin/python orderbook-bridge/bridge.py
```

The bridge serves `ws://localhost:8765` (loopback only; browser origins other than
localhost get HTTP 403). Optional env vars:

- `BRIDGE_PORT` — WebSocket port (default `8765`)
- `BRIDGE_HOST` — bind address (default `localhost`; the socket has no auth)
- `MARKET_PROVIDER` — `binance` | `oanda` (overrides the UI choice)
- `VACUUM_BAR_MS` — candle size fed to the vacuum engine (default `60000` = 1m)

To enable OANDA, put `OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID` and `OANDA_ENV`
(`practice`/`live`) in the repo-root `.env` (see `.env.example`), then pick OANDA in
the instrument menu. The bridge saves the choice to `data/config.json` and restarts
itself (~5 s); the chart resets and reloads history automatically.

### 2. Start the SciChart terminal (frontend)

```bash
cd scichart-terminal
pnpm install      # first time only
pnpm dev          # http://localhost:5273
```

Open http://localhost:5273. The chart draws candles, the liquidity heatmap,
absorption bubbles, and vacuum boxes/magnet line live.

Chart controls:

- **Crosshair** — toolbar button or **Alt+C**. Dashed cursor lines with time/price
  axis badges, plus an OHLC · change · volume · Δ legend (top-left) for the candle
  under the cursor; it shows the live candle when the pointer leaves the plot.
- **Wheel** zoom, **drag** pan, **double-click** (or *Live*) snaps back to the live edge.
- **Click an absorption bubble** for the detector breakdown. **Alt+D** toggles the DOM.

### Rendering performance

Absorption markers are GPU scatter + text series (one draw call per size tier and
side) instead of one SVG annotation each, the heatmap grid is shared with SciChart by
reference and only the live column is copied per frame, geometry setters are skipped
when unchanged, hidden layers do no GPU work, and the OHLC legend is updated
imperatively (no React re-render on hover). Measured in headless Chrome against the
previous build with the same live feed: SVG nodes in the chart 1,205 → 37–121,
animation frame rate 2.5–21 fps → 23–32 fps.

### Production build

```bash
cd scichart-terminal
pnpm build        # tsc -b && vite build  ->  dist/
pnpm preview      # serve the built dist/
```

---

## Licensing

SciChart.js runs here under the **free Community Edition** — licensed for
non-commercial / personal / educational use indefinitely, with **no license key**.
A small SciChart watermark is shown; this is expected and fine for personal use. To
remove it you would purchase a commercial license and call
`SciChartSurface.setRuntimeLicenseKey(...)` in `src/chart/scichart-init.ts`.

### WASM assets

SciChart 6.x ships its WebAssembly engine as `_wasm/*.wasm`. `vite.config.ts` copies
those files into the served root via `vite-plugin-static-copy`, and
`src/chart/scichart-init.ts` calls `SciChartSurface.useWasmLocal()` so the terminal
runs **fully offline**. If local WASM ever fails to resolve, switch that call to
`SciChartSurface.useWasmFromCDN()`.

---

## Project layout

```
scichart-terminal/
├─ src/
│  ├─ types/frame.ts        # typed BookmapFrame (bridge contract)
│  ├─ hooks/useLiveOrderBook.ts # shared WS (ref-counted), request/response, venue types
│  ├─ hooks/useVenue.ts     # active venue + capability flags
│  ├─ lib/klines.ts         # chart history via bridge, Binance-direct fallback
│  ├─ chart/
│  │  ├─ scichart-init.ts   # Community license + WASM config
│  │  └─ TerminalChart.ts   # surface + heatmap + bubbles + vacuum + crosshair
│  ├─ components/Header/ProviderSwitcher.tsx  # Binance ⇄ OANDA menu
│  ├─ components/Dashboard/CrosshairLegend.tsx # OHLC hover readout
│  ├─ App.tsx               # header + chart mount
│  └─ main.tsx
├─ vite.config.ts           # WASM static copy, dev port 5273
└─ package.json
```

## Tests

The vacuum engine is unit-tested in
`orderbook-bridge/tests/test_vacuum_engine.py` (all three sources, dedupe,
consumption, aging, per-side cap, magnet strength/direction):

```bash
.venv/bin/python -m pytest orderbook-bridge/tests/test_vacuum_engine.py -q
```
