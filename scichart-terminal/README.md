# SciChart Terminal — personal order-flow terminal

A GPU-rendered, personal trading terminal built on **SciChart.js** (free Community
Edition) that visualises three institutional order-flow lenses on one chart:

| Overlay | Inspired by | Source data | Rendering |
| --- | --- | --- | --- |
| **Liquidity cluster heatmap** | Bookmap | `liquidity_zones[]` (resting limit-order volume) | `UniformHeatmapDataSeries` — rolling price×time grid, colour = displayed volume |
| **Absorption bubbles** | ATAS | `absorption_candidates[]` (aggressive volume absorbed w/o price move) | `XyScatterRenderableSeries` + `EllipsePointMarker` |
| **Liquidity vacuum** | OSC-VIP v7.4 Pine | `vacuum_zones[]` + `vacuum_magnet` | `BoxAnnotation` per pocket + magnet `HorizontalLineAnnotation` |

It **reuses the existing Python `orderbook-bridge`** as the data backend (Binance
USDⓈ-M Futures XAUUSDT) over WebSocket. No new market-data plumbing.

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

The bridge serves `ws://0.0.0.0:8765`. Optional env vars:

- `BRIDGE_PORT` — WebSocket port (default `8765`)
- `VACUUM_BAR_MS` — candle size fed to the vacuum engine (default `60000` = 1m)

### 2. Start the SciChart terminal (frontend)

```bash
cd scichart-terminal
pnpm install      # first time only
pnpm dev          # http://localhost:5273
```

Open http://localhost:5273. The header shows connection status and the current
vacuum-magnet direction. The chart draws candles, the liquidity heatmap, absorption
bubbles, and vacuum boxes/magnet line live.

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
│  ├─ hooks/useBridge.ts    # WS client, auto-reconnect, partial-frame merge
│  ├─ chart/
│  │  ├─ scichart-init.ts   # Community license + WASM config
│  │  └─ TerminalChart.ts   # surface + heatmap + bubbles + vacuum overlays
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
