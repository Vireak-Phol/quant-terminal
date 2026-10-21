# Trading Terminal — Institutional Upgrade Spec

**Status:** in progress · foundation landed, UI layer outstanding
**Scope decided:** Phase 1 + 2 · snapshot-history data model · multi-symbol · V6 cockpit
**Last updated:** 2026-07-29

---

## 1. Why

`trading-terminal/` began as a 1,869-LOC static viewer: one hardcoded `DailyAnalysis`
object, six tabs switched in `App.tsx`, five decorative Chart.js panels. One symbol,
one day, no keyboard path, no provenance, and no connection to the OSC-VIP V6 /
REG-V6 engine that produces the analysis.

The gaps that actually matter on a desk:

| Gap | Consequence |
|---|---|
| No time axis | "What changed since yesterday?" is unanswerable |
| No breadth | Nobody watches one instrument; no watchlist, no cross-asset read |
| Not keyboard-driven | Institutional users navigate by command line, not mouse |
| No provenance | Numbers of unknown age; nothing to act on |
| Decorative charts | A 2-bar chart where a price-aligned ladder belongs |
| Colour-only bull/bear, 9–10px type | Fails a11y and fails anyone reading across a desk |
| V6 disconnected | Tier rules live only in Pine and in prose |

**Target:** a keyboard-first, provenance-stamped, multi-symbol terminal with a session
archive, real microstructure panels, an alert engine, and a V6 cockpit that makes the
tier logic auditable at a glance.

### Framing

This is a **discretionary awareness aid**, not a backtested signal system. Confluence
weights are stated openly, not calibrated against realised outcomes. Any copy in the
UI should reflect that — no implied edge, no performance claims.

---

## 2. Non-negotiable constraints

1. **Zero new runtime dependencies.** Fuzzy match, hotkeys, tiling, toasts and
   virtualisation are all hand-rolled — row counts here are <500. Keeps the
   dependency surface at `react`, `react-dom`, `chart.js`, `react-chartjs-2`.
2. **Additive schema only.** Every v2 field is optional. The untouched
   `public/xauusd-analysis.json` (no `meta`, no `v6`) must keep rendering, with empty
   states where new data is absent. This is verification item V2 and is the single
   most important regression.
3. **`.agents/AGENTS.md` applies:** *"be careful with existing logic; if concerned, ask
   first."* No `.pine` file is touched by this work.
4. **One rules home.** V6 classification lives only in `src/lib/v6.ts`. No panel
   re-derives a tier inline.

---

## 3. Current status

### 3.1 Landed

| File | What it does |
|---|---|
| `tailwind.config.js` | Palette migrated to `rgb(var(--c-x) / <alpha-value>)`; semantic tokens; `text-2xs`; `spacing.panel/row` |
| `src/styles/globals.css` | 3 themes, 3 densities, tokenised badges, focus ring, tabular numerals, `prefers-reduced-motion`, print stylesheet |
| `src/types/analysis.ts` | v2 additive schema + `SnapshotRef` + widened `TabId` |
| `src/lib/format.ts` | Price/volume/percent/label/glyph/time formatting |
| `src/lib/v6.ts` | **The V6 rule engine.** Tier classification, prereq gates, trade plan, regime |
| `src/lib/delta.ts` | Session-over-session comparison, series extraction |
| `src/lib/confluence.ts` | Composite score + per-factor contributions, `breadthOf` |
| `src/lib/sessions.ts` | NY-time killzones, desk clocks, 24h axis mapping |
| `src/lib/risk.ts` | Position sizing, R-multiples, expectancy, staleness |
| `src/lib/chartSetup.ts` | Single Chart.js registration + theme-aware options |
| `src/lib/validate.ts` | Field-level snapshot validation |
| `src/lib/exporters.ts` | CSV, clipboard, markdown brief |
| `src/lib/fuzzy.ts` | Command-palette ranking |
| `src/lib/hotkeys.ts` | `useHotkeys`, `useFocusTrap`, platform labels |
| `src/store/usePrefs.ts` | Theme/density/layout/sizing, localStorage |
| `src/store/useSnapshots.ts` | Manifest fetch, lazy load, cache, overrides, fallback |

### 3.2 Not yet verified

> **`npm run build` has NOT been run since these changes.** The typecheck was
> attempted and blocked by a tooling outage. Treat §3.1 as written-but-unverified.
> **First action on resuming: run `npm run build` and fix fallout before anything
> else.**

Known integration gaps that will surface:

- `TabId` gained six members. The `switch` in `App.tsx:19` is no longer exhaustive and
  `renderTab()` now returns `JSX.Element | undefined`. Harmless at runtime, but the
  new tabs render nothing until wired.
- `src/hooks/useAnalysisData.ts` still holds the old static state and is not yet an
  adapter over `useSnapshots`.
- The 25 off-palette usages catalogued in §4.4 are still present in components; only
  the `.badge-*` rules in `globals.css` were converted.
- The five chart components still call `ChartJS.register(...)` individually and
  hardcode `#94a3b8` / `rgba(42,48,64,0.5)`. They do not yet import `chartSetup`.
- `public/snapshots/` does not exist, so `useSnapshots` will take the `fallback` path
  and show the bundled snapshot. This is correct behaviour, not a bug — but it means
  the time axis is invisible until fixtures land (§6.1).

### 3.3 Outstanding

Everything in §6. Roughly: 2 store hooks, ~20 components, 9 panels, 3 tabs, fixtures,
and the migration of 6 existing tabs.

---

## 4. Design system

### 4.1 Tokens

All colour flows through CSS custom properties on `<html>`, consumed by Tailwind as
`rgb(var(--c-x) / <alpha-value>)`.

> **The `<alpha-value>` form is mandatory.** The codebase uses ~25 Tailwind alpha
> modifiers (`bg-terminal-surface/50`, `border-terminal-border/50`,
> `bg-terminal-accent/10`). A bare `var()` breaks every one of them silently.

Structural: `bg` `surface` `card` `border` `border-strong`
Brand: `accent` `accent-dim` `gold`
Type: `text` `text-dim`
Semantic: `bull` `bear` `warn` `info` `muted`
Tinted fills: `bull-deep` `bear-deep` `warn-deep` `info-deep` `muted-deep`

`terminal-green` / `terminal-red` are retained as aliases of `bull` / `bear` so
existing call sites keep resolving.

### 4.2 Themes — `<html data-theme>`

- `dark` (default) — current palette
- `contrast` — pure-black ground, dim text at 13.4:1, for bright floors and low vision
- `light` — desk/print; directional hues darkened (green-500 on white is 2.2:1 and
  unusable for text, so light uses green-700 at 4.9:1)

Every theme's `--c-text-dim` clears WCAG AA against its own `--c-bg`.

### 4.3 Density — `<html data-density>`

Driven by root font-size so every rem-based size scales from one control.
`compact` 15px · `normal` 16px · `comfortable` 17px.
Floor is 11px (`text-2xs` = 0.6875rem); the old `text-[9px]` / `text-[10px]` are gone.

### 4.4 Off-palette debt to clear

These bypass the theme and must be migrated to semantic tokens as each component is
touched. Audited counts:

```
text-red-400 ×5     text-green-400 ×4    text-gray-400 ×2
bg-red-900/30 ×2    bg-red-900/20 ×2     bg-green-900/20 ×2
text-orange-400     text-blue-400        border-red-900/30
border-red-800/50   border-green-800/50  border-gray-700/50
bg-red-900/40       bg-orange-900/20     bg-green-900/40
bg-green-900/30     bg-gray-800/40       bg-gray-800/30
bg-blue-900/20
```

Mapping: `green→bull`, `red→bear`, `orange/amber→warn`, `blue→info`, `gray→muted`;
`*-900/*` tints → `*-deep/*`.

### 4.5 Accessibility rules

- **Never colour alone.** Every directional signal pairs a hue with a glyph and a word:
  `▲ BULLISH 58%`. Use `biasGlyph()` / `arrow()` from `format.ts`.
- Focus is always visible (`:focus-visible` ring is global).
- Tables get `scope` on headers and a `<caption>` (may be `sr-only-abs`).
- Tab nav uses `role="tablist"` / `role="tab"` / `aria-selected`.
- Modals: `role="dialog"`, `aria-modal`, `useFocusTrap`, Escape closes.
- Motion honours the OS setting; there is deliberately no in-app motion toggle.
- Any element that is chrome-only gets `data-print="hide"`.

---

## 5. Module reference (already written — call these, don't re-implement)

### `lib/format.ts`
`price(v, dp?)` `usd` `compact` `int` `signed` `pct` `signedPct` `label` `arrow`
`biasGlyph` `hhmmToMinutes` `clockHM(d, tz?)` `ago(from, now)` `minutesUntil`
`humanDuration` `clamp`

### `lib/v6.ts` — the rule engine
Constants: `A_PLUS_FLOOR` 65 · `STRUCTURAL_FLOOR` 50 · `CONFLICT_FLOOR` 55 ·
`SL_ATR_MULT` 1.5 · `TP1_ATR_MULT` 2.0 · `TP2_ATR_MULT` 3.5 ·
`ER_TRENDING` 0.45 · `ER_RANGING` 0.20

```ts
assessV6(v6: V6Engine, entry?: number): V6Assessment
// → { long, short, primary, counter, muted, actionable, regime, plan,
//     confluenceCount, confluences }
quickTier(longProb, shortProb): { tier, side }   // watchlist rows only
tierLabel(t)   tierTone(t) → 'bull'|'warn'|'bear'|'muted'
```

`SideAssessment` carries `tier`, `winProb`, `reason` (plain-language verdict),
`suppressed`, `prereqs[]`, `sizeFactor`.

**Encoded rules** (from `.agents/AGENTS.md` §2–§4):
- Shock guard active → **everything muted**, tier `none`. Absolute; not a demotion,
  because the volatility spike invalidates the probability estimate itself.
- `p ≥ 65` **and** all five gates pass → `a_plus`
- `p ≥ 65` but any gate fails → **demoted to `structural`**, `suppressed: true`, and
  `reason` names the blocker
- `50 ≤ p < 65` → `structural`, `sizeFactor` 0.5
- `p < 50` → `trap`, `sizeFactor` 0, do not trade
- Gates: bar confirmed · active killzone · no shock · `volZ > 0` · opposing `< 55`
- Plan: SL 1.5×ATR, TP1 2.0×ATR, TP2 3.5×ATR from entry

### `lib/delta.ts`
`delta(value, prior)` · `deltaOf(current, prior, selector)` · `seriesOf` ·
`labelledSeriesOf` · `deltaTone(d, invert?)`

Selectors are **functions, not string paths**, so TypeScript keeps checking the field
exists. `deltaTone(d, invert=true)` for metrics where down is good (risk, distribution,
put/call) — getting this wrong paints a deteriorating book green.

### `lib/confluence.ts`
`computeConfluence(d): ConfluenceResult` — 0–100 (50 neutral), `direction`,
`strength`, `agreement/total`, and `factors[]` sorted by absolute bias.

Weights: flow .22 · orderflow .18 · V6 .18 · structure .16 · trend .14 · momentum .12 ·
volume .08. Renormalised over whichever factors are present. V6 abstains entirely when
muted rather than dragging the composite toward neutral.

`breadthOf(rows)` → `{ bullish, bearish, neutral, netPct, regime }`.

### `lib/sessions.ts`
`KILLZONES` (London 02:00–05:00, NY AM 08:30–11:00, Asia 20:00–24:00 — **NY time**),
`SESSIONS`, `killzoneState(now)`, `nyMinutes`, `minutesInZone`, `DESK_CLOCKS`,
`pctOfDay`.

Killzone state is computed live, not read from the snapshot: the strip keeps ticking
even when the analysis is hours old. `v6.killzone` records the state *at capture*,
which is a different fact — don't conflate them.

### `lib/risk.ts`
`sizePosition(SizingInput): SizingResult` · `rMultiple(entry, stop, target)` →
`{ r, breakevenWinRate }` · `expectancyR(winProbPct, r)` · `stalenessOf(asOf, now)` →
`{ level: 'live'|'recent'|'stale'|'unknown', ageMinutes, label, tone }`
(live <5m, recent <30m, stale beyond).

### `lib/chartSetup.ts`
`registerCharts()` (auto-runs on import) · `cssToken(name, alpha?)` ·
`chartTheme(): ChartTheme` · `baseOptions(theme)`.

Call `chartTheme()` during render and key datasets on the active theme so a theme
switch rebuilds them. Never hardcode a colour in a chart again.

### `lib/validate.ts`
`validateAnalysis(unknown): ValidationResult` → `{ ok, errors[], warnings[], data }`.
Errors block; warnings inform (unknown enum → neutral badge, which is degraded but
honest). `summariseIssues(r)` for toasts.

### `lib/exporters.ts`
`toCsv` · `downloadCsv` · `downloadText` · `copyText` (with non-secure-context
fallback) · `snapshotFilename` · `toMarkdownBrief(d)`.

### `lib/hotkeys.ts`
`useHotkeys(hotkeys[], enabled?)` · `useFocusTrap(active, ref)` · `hotkeyLabel` ·
`MOD_LABEL` · `isTypingInto`.

Two rules baked in: never fire while typing (unless `allowInInput`), never shadow
browser shortcuts (bare letters only; `mod` reserved for the palette).

### `store/usePrefs.ts`
`{ prefs, set, cycleTheme, cycleDensity, setCell, reset }`.
`Prefs` = theme · density · layout · cells[] · equity · riskPct · contractSize ·
showDeltas. Merges over defaults on load so an older blob can't leave fields undefined.

### `store/useSnapshots.ts`
```ts
{ status, notice, dismissNotice, current, prior, series,
  symbol, date, symbols, dates, hasArchive,
  selectSymbol, selectDate, step, loadSnapshot, clearOverrides }
```
`current` is never null — falls back to the bundled snapshot. `dates` is newest-first,
so the prior session is index+1. `step(+1)` goes older, `step(-1)` newer. Uploaded
snapshots become overrides keyed `symbol|date` and take precedence over the archive.

---

## 6. Remaining work

### 6.1 Fixtures — `public/snapshots/`

**Do this first.** Without fixtures the time axis, watchlist, V6 cockpit and
microstructure panels all render empty states and cannot be developed against.

`public/snapshots/index.json`:
```json
[
  { "date": "2026-07-29", "symbol": "XAUUSD", "market": "FOREX",
    "file": "/snapshots/2026-07-29-xauusd.json" },
  { "date": "2026-07-28", "symbol": "XAUUSD", "market": "FOREX",
    "file": "/snapshots/2026-07-28-xauusd.json" }
]
```

Required set:
- **XAUUSD × 4 consecutive sessions.** Vary confidence, imbalance and bias so deltas
  and sparklines have something to show. The newest carries the full v2 payload:
  `meta`, `v6`, `watchlist`, `micro.cvd_series` (~30 points), `positioning_detail
  .gex_by_strike` (~12 strikes spanning max pain), `calendar`.
- **NVDA × 1**, reusing `src/data/sample.ts`, to prove symbol switching.
- Older sessions may omit `v6` / `micro` deliberately — that exercises the empty
  states in the archive rather than only on upload.

Also update `public/template.json` to v2 with every optional block present and
commented via a `_README` key, since it is what `Download Template` hands out.

### 6.2 `store/useUrlState.ts`

Sync `?symbol=&date=&tab=` with `history.replaceState`. Read once on mount to seed
`useSnapshots`; write on change. Guard against loops — only write when the value
actually differs. Deep links must survive a reload.

### 6.3 `store/useAlerts.ts`

```ts
interface AlertRule {
  id: string; enabled: boolean; symbol: string | '*'
  field: string            // dotted path, resolved against the snapshot
  op: '<' | '<=' | '>' | '>=' | '==' | '!=' | 'crosses'
  value: number | string
  label?: string
}
```
Evaluate on every `current` change. Fire once per `(rule, symbol, date)` — dedupe or
the archive prefetch will spam on load. `crosses` needs the prior snapshot. Emit an
in-app toast; request `Notification` permission only on explicit user action, never on
mount. Persist rules and the fired-log to localStorage.

Ship 3 default rules disabled by default: `v6 tier == a_plus`, `imbalance_score < 40`,
`risk_assessment.overall_risk == high`.

### 6.4 Shared components — `src/components/Shared/`

| Component | Spec |
|---|---|
| `Panel` | Wrapper: title, subtitle, actions slot, collapse, per-panel `ErrorBoundary`, skeleton/empty passthrough. **Every panel uses this** — one bad panel must not blank the terminal |
| `ErrorBoundary` | Class component. Shows panel title + error + "reload panel" |
| `EmptyState` | Icon, message, optional CTA. Used wherever a v2 block is absent |
| `Skeleton` | Shimmer honouring reduced-motion |
| `DeltaChip` | `Delta` + `invert?` → `▲ +4 (+9.1%)` in the right tone. Hidden when `prefs.showDeltas` is false or `d.isNew` |
| `Sparkline` | Inline SVG, no dependency. `values[]`, ~64×18, last-point dot |
| `Gauge` | Arc with threshold ticks. Used for the V6 dual probability gauges — must render the 50/55/65 marks |
| `DataTable` | Generic sortable table: column defs, keyboard row nav (↑↓, Enter), CSV action, `scope`/`caption` |
| `Toast` | Bottom-right stack, auto-dismiss, `role="status"` |
| `MetricTile` | **Existing** — extend with `delta?`, `invert?`, `glyph?`, `tone` |
| `Badge` | **Existing** — extend variants to `warn` / `info`, always render a glyph |

### 6.5 Shell — `src/components/Layout/`, `src/components/Command/`

- **`TopBar`** (rebuild of `Header.tsx`) — symbol switcher, date scrubber with
  `[` `]` affordance, bias as glyph+text+colour, confidence meter, composite score.
- **`StatusBar`** (new, bottom) — as-of stamp · source · **staleness pill** from
  `stalenessOf` · revision · active killzone + countdown · four desk clocks.
  Ticks on a 30s interval. This is the provenance fixture; it is always visible.
- **`Sidebar`** — `role="tablist"`, add the new tabs, show hotkey numbers.
- **`CommandPalette`** — `⌘K`/`Ctrl+K` or `:`. Sources: symbols, function codes,
  dates, verbs. `fuzzyRank` over `[title, code, keywords]`. `highlightRuns` for
  display. Recents in localStorage. Full keyboard control, focus trap, Escape.
- **`ShortcutOverlay`** — `?`. Grouped cheatsheet built from the same `Hotkey[]`
  array that registers them, so it cannot drift.
- **`PanelGrid`** — presets `single|split|quad|six`; each cell picks a panel from a
  menu; persisted via `prefs.cells`. **Deliberately not drag-and-drop** — gets the
  desk-layout value without a dnd dependency.

**Function codes** (Bloomberg-style, for the palette):
`OV` overview · `V6` cockpit · `IF` institutional flow · `OF` order flow ·
`SMC` smart money · `CH` charts · `WL` watchlist · `RSK` risk · `ALRT` alerts ·
`WS` workspace

**Hotkeys:**
`1`–`9` tabs · `⌘K`/`:` palette · `[` `]` prev/next session · `d` density ·
`t` theme · `e` export brief · `c` copy brief · `?` overlay · `Esc` close

### 6.6 V6 cockpit — `src/components/Dashboard/V6Tab.tsx`

Consumes `assessV6()` only; no inline rule logic.

- Dual probability gauges (long vs short) with 50/55/65 threshold ticks
- Tier badge **with its reason**: `A+ SUPPRESSED — opposing side 57.0% ≥ 55.0%`
- Prereq checklist, five rows, pass/fail + observed detail
- Trade plan: entry, SL, TP1, TP2, R:R, breakeven win rate, expectancy, and size
  from `sizePosition()` using `prefs.equity` / `riskPct` / `contractSize`
- Regime strip: ER + classification, SMPI sign, HTF 4H 200EMA alignment
- REG-V6 confluence checklist: Unicorn, RegOB, RPD, sweep
- **No `v6` block → `EmptyState` with a template link. Never a crash.**

### 6.7 Panels — `src/components/Panels/`

| Panel | Notes |
|---|---|
| `LiquidityLadder` | **The centrepiece.** One shared price axis carrying liquidity clusters, key levels, FVGs, order blocks and last price, volume-node bars scaled by strength. Replaces four disconnected lists that currently force the reader to join prices in their head |
| `CvdChart` | Cumulative-delta line + per-bar delta histogram + divergence markers, from `micro.cvd_series` |
| `GexByStrike` | Gamma per strike, max-pain marker, zero-gamma flip line. Replaces the lone scalar in `InstitutionalFlowTab` |
| `BlockTape` | `large_blocks` as a tape: size-heat shading, running buy/sell totals, significance filter, sortable |
| `LiquidityHeatmap` | Price × time intensity grid |
| `ConfluenceWaterfall` | Per-factor contributions from `computeConfluence()` |
| `WatchlistBlotter` | Sortable, keyboard-navigable: symbol · bias · confidence · V6 tier (`quickTier`) · imbalance · Δ · sparkline. Row → `selectSymbol` |
| `CorrelationMatrix` | Bias-agreement heatmap + `breadthOf` risk-on/off read |
| `SessionStrip` | 24h band, killzones, now-marker, countdown |
| `EconCalendar` | Impact tiers, time-to-event, **shock-guard pre-warning when a high-impact event is <30m out** — mirrors the V6 macro shock rule |

### 6.8 Migration of existing components

- All five `Charts/*.tsx` → drop local `ChartJS.register`, import `chartSetup`, use
  `chartTheme()` + `baseOptions()`.
- All six existing tabs → wrap in `Panel`, add `DeltaChip` where a prior exists,
  replace off-palette classes per §4.4, add glyphs to every colour signal.
- `JsonUploader` → drag-and-drop, multi-file, `validateAnalysis` with a field-level
  error list, warnings shown but non-blocking.
- `useAnalysisData` → thin adapter over `useSnapshots` preserving the `{ data }` prop
  contract, so the six existing tabs need no prop changes.
- `App.tsx` → shell composition, hotkeys, URL state, toasts, palette, status bar,
  per-tab error boundaries.
- `index.html` → title, description, `theme-color`.

---

## 7. Verification

Run in order. V1 and V2 gate everything else.

1. **V1 — Build.** `npm run build` (`tsc -b && vite build`) clean.
2. **V2 — Backwards compatibility (the important one).** Load the untouched
   `public/xauusd-analysis.json` (old schema) via `Load JSON`. Every original panel
   renders identically; new panels show empty states, not crashes. Then load a
   malformed file and confirm field-level errors appear instead of silent acceptance.
3. **V3 — Themes × densities.** `npm run dev`; walk every tab across 3 themes × 3
   densities. No unreadable text, no clipped layout, no off-palette element that
   stayed dark in light mode.
4. **V4 — Keyboard only.** Unplug the mouse. `⌘K` → symbol → Enter; `1`–`9`;
   `[` `]` to scrub; `?`; `Esc`. Focus visible at every step.
5. **V5 — V6 rule branches.** Craft snapshots and confirm `assessV6` classifies:
   - long 71 / short 40, all gates pass → `a_plus`
   - long 71 / short 57 → `structural`, `suppressed`, reason names the conflict
   - long 71 / short 40 but `vol_z: -0.3` → `structural`, reason names the volume gate
   - long 58 / short 30 → `structural`
   - long 44 → `trap`
   - `shock_guard: true` → both sides `none`, `muted`
6. **V6 — Provenance.** Back-date `meta.as_of`; staleness pill goes green → amber → red.
7. **V7 — Real-data fit.** Pull a live brief through the tradingview MCP
   (`morning_brief`, `data_get_pine_tables` on the V6 studies), convert to a snapshot,
   and confirm the extended schema accommodates real generator output. **The schema is
   only correct if the real pipeline fits it** — `micro`, `gex_by_strike` and
   `calendar` currently have no producer and are the most likely to be wrong.
8. **V8 — Motion and print.** `prefers-reduced-motion` on → nothing pulses. Print
   preview → legible one-page brief, no clipped scroll containers.

---

## 8. Risks

- **Schema guesswork.** `micro`, `positioning_detail.gex_by_strike` and `calendar`
  were designed without a producer. V7 exists to correct them **before** the panels
  calcify around invented field names. Do V7 early if possible.
- **Token migration blast radius.** §4.4 touches most components. Mitigated by keeping
  the `terminal.*` token *names* identical — only values moved behind vars — so the
  ~100 existing class usages still resolve.
- **Panel count.** Ten new panels is the bulk of the remaining work. Each is
  independently shippable behind `Panel` + `ErrorBoundary`; one thin on data degrades
  to an empty state rather than blocking the rest. Cut from the bottom of the §6.7
  table if scope needs trimming — `LiquidityLadder`, `WatchlistBlotter` and the V6
  cockpit carry most of the value.
- **Alert dedupe.** The archive prefetch loads every snapshot on mount. Without
  per-`(rule, symbol, date)` dedupe this fires a toast storm on first load.

---

## 9. Out of scope

- Live bridge server (WebSocket + TradingView CDP polling). Considered and deferred;
  the snapshot archive is the substrate a bridge would later write into, so nothing
  here blocks it.
- Order execution, real position/PnL book, VaR — phase 3, not commissioned.
- Any change to `.pine` indicator logic.
