/// SciChart controller (a.k.a. SciChartDeepEngine): owns the surface, axes,
/// candlestick series, and the institutional overlays:
///   1. Bookmap Liquidity Heatmap  (UniformHeatmapDataSeries)
///   2. Price Candlesticks          (FastCandlestickRenderableSeries)
///   3. Heavy Absorption Bubbles    (data-scaled CustomAnnotation circles)
///   4. Liquidity Vacuum Pockets    (v7.4 Pine Strategy structure; BoxAnnotations)
///   5. Vacuum Magnet Line          (HorizontalLineAnnotation + axis badge)
///   6. Hopla 3 / 50 / 97 range     (HorizontalLineAnnotation)
///   7. Mark Price Line on Axis     (HorizontalLineAnnotation with amber badge)
///   8. Institutional Signal Markers & Active Trade Plan (ENTRY / SL / TP1 / TP2)
///
/// Every overlay group is independently toggleable via setLayerVisibility() and
/// every resource is released in delete() so React unmounts leave no WebGL leaks.
///
/// PERFORMANCE CONTRACT: update() is designed to be called at display refresh
/// (the cockpit coalesces websocket frames with requestAnimationFrame). Within a
/// frame it does the minimum work: candle O/H/L/C in place, heatmap pushed to the
/// GPU only when the grid changed, absorption bubbles rebuilt only on a new closed
/// candle (live footprints appended incrementally), and vacuum/hopla/signal annotations
/// rebuilt only when their v7.4 signature changes.

import {
  SciChartSurface,
  NumericAxis,
  DateTimeNumericAxis,
  SmartDateLabelProvider,
  NumberRange,
  SciChartJsNavyTheme,
  EAxisAlignment,
  EAutoRange,
  FastCandlestickRenderableSeries,
  OhlcDataSeries,
  UniformHeatmapDataSeries,
  UniformHeatmapRenderableSeries,
  HeatmapColorMap,
  BoxAnnotation,
  HorizontalLineAnnotation,
  TextAnnotation,
  ELabelPlacement,
  ZoomPanModifier,
  MouseWheelZoomModifier,
  ZoomExtentsModifier,
  CursorModifier,
  ChartModifierBase2D,
  EChart2DModifierType,
  translateFromCanvasToSeriesViewRect,
  XyDataSeries,
  XyScatterRenderableSeries,
  EllipsePointMarker,
  XyTextDataSeries,
  FastTextRenderableSeries,
  EHorizontalTextPosition,
  EVerticalTextPosition,
  EDataChangeType,
  EDataPointWidthMode,
  ECoordinateMode,
  EHorizontalAnchorPoint,
  EVerticalAnchorPoint,
  EFillPaletteMode,
  EStrokePaletteMode,
  EValueName,
  parseColorToUIntArgb,
  DefaultPaletteProvider,
} from "scichart";
import type {
  IFillPaletteProvider,
  IStrokePaletteProvider,
  IRenderableSeries,
  ModifierMouseArgs,
  Point,
} from "scichart";
import type { CandleData } from "../lib/klines";
import {
  detectHeavyAbsorptions,
  type HeavyAbsorptionPoint,
} from "../lib/absorption";
import type { V74Frame, TimeframeFrame } from "../types/v74";
import { DEFAULT_CHART_STYLE, bubblePaint, type ChartStyle } from "../lib/chartStyle";

export type Timeframe = "1m" | "5m" | "15m";

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
};

/** Overlay groups the UI can switch on/off. */
export type ChartLayer = "heatmap" | "bubbles" | "vacuum" | "hopla" | "delta";

/** Minimal shape the chart needs from a live frame. Structurally compatible with
 *  both the bridge `bookmap_update` frame and the `LiveOrderBookData` snapshot. */
export interface ChartFrame {
  mid_price: number;
  timestamp: number;
  liquidity_zones?: Array<{
    priceLow: string | number;
    priceHigh: string | number;
    displayedQuantity: string | number;
    firstSeenTimestamp?: number;
  }>;
  /** Dense per-bin resting depth for the live heatmap column (Bookmap gradient).
   *  bins[i] is the total resting volume at price priceMin + i*binSize. */
  heatmap_column?: {
    priceMin: number;
    binSize: number;
    bins: number[];
  } | null;
  absorption_candidates?: Array<{
    side: "buy" | "sell";
    price: string | number;
    timestamp: number;
    executedQuantity?: string | number;
    reason?: string;
    /** Aggression traded into a resting liquidity wall (square marker). */
    wall?: boolean;
  }>;
  v74?: V74Frame | null;
  // --- Audit R1/R3: candles + CVD + session + key levels + sweeps ---
  trade_candle?: {
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    d: number;
    bv: number;
    sv: number;
    closed: boolean;
  } | null;
  cvd?: number;
  session?: {
    london: boolean;
    ny_am: boolean;
    asia: boolean;
    london_fix: boolean;
    name: string;
  };
  key_levels?: {
    pdh: number | null;
    pdl: number | null;
    pwh: number | null;
    pwl: number | null;
  };
  sweep_events?: Array<{
    kind: "liq_sweep";
    time: number;
    price: number;
    dir: number;
  }>;
  // --- Bubble Regime engine: OI + liquidation classified sweeps ---
  bubbles?: Array<{
    type: "bubble_regime";
    timestamp: number;
    priceCenter: string | number;
    aggressorSide: "buy" | "sell";
    totalQuantity: string | number;
    sweepTicks: number;
    oiDelta: number;
    liquidationQuantity: string | number;
    regime:
      | "standard_flow"
      | "institutional_absorption_open"
      | "liquidation_exhaustion_flush"
      | "vacuum_sweep_breakout";
  }>;
}

/** A clickable absorption bubble recorded for hit-testing. */
export interface BubbleHit {
  x: number; // epoch seconds
  y: number; // price
  side: "buy" | "sell";
  point: HeavyAbsorptionPoint | null; // null for live-tape footprints
}

/** OHLC(+V/Δ) of the candle under the crosshair (or the live candle). */
export interface CandleReadout {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  delta: number | null;
  /** Cursor price on the Y axis (null when not hovering). */
  cursorPrice: number | null;
  live: boolean;
}

/** Records the pointer in SciChart's own (DPI-scaled, series-view) coordinates so
 *  hover readouts and click hit-tests agree with what is drawn, on Retina too. */
class PointerTrackerModifier extends ChartModifierBase2D {
  readonly type = EChart2DModifierType.Custom;
  /** Series-view-rect coordinates (device px), or null when outside the plot. */
  point: Point | null = null;
  onMove: (() => void) | null = null;

  modifierMouseMove(args: ModifierMouseArgs): void {
    super.modifierMouseMove(args);
    const svr = this.parentSurface?.seriesViewRect;
    this.point = svr ? translateFromCanvasToSeriesViewRect(args.mousePoint, svr) ?? null : null;
    this.onMove?.();
  }

  modifierMouseLeave(args: ModifierMouseArgs): void {
    super.modifierMouseLeave(args);
    this.point = null;
    this.onMove?.();
  }
}

const PRICE_ROWS = 240; // heatmap price buckets (240×160 depth tensor)
const HEATMAP_COLS = 160; // heatmap time columns
const MAX_CANDLES = 1000; // candle history cap (retains the seeded HISTORY_LIMIT)
const VISIBLE_CANDLES = 80; // how many candles the live view shows

// Default whitespace (in screen pixels) kept to the RIGHT of the newest candle
// in live-follow mode, so the active candle never hugs the right edge / the
// price-axis badges. Converted to time units per-frame from the current plot
// width (see applyLiveView), so it stays a constant on-screen gap regardless of
// timeframe or zoom.
const RIGHT_OFFSET_PX = 200;

// ── Absorption markers ──────────────────────────────────────────────────────
// Always a numbered circle. Each visual channel carries one fact:
//   COLOUR = aggressor side — blue: aggressive BUYERS, pink: aggressive SELLERS
//            (DeepCharts convention; distinct from the green/red candles).
//   SIZE   = strength tier:
//            "circle"  (r 12) — absorption
//            "square"  (r 15) — aggression traded into a resting liquidity wall
//            "diamond" (r 18, bright + white ring) — "battle": absorbed AND open
//                       interest rose (fresh passive positions defending the level)
//            (tier names kept from the DeepCharts shape mapping they replace)
//   NUMBER = volume: the candle detector's volume ratio (% of average) when known,
//            otherwise the live absorbed size in oz.
// One marker per candle per side; the tier only upgrades.
export type AbsorbShape = "circle" | "square" | "diamond";
const MARKER_PX: Record<AbsorbShape, number> = { circle: 12, square: 15, diamond: 18 };
const MARKER_FONT: Record<AbsorbShape, number> = { circle: 9, square: 10, diamond: 11 };

// Bubble + candle colours are user settings (lib/chartStyle.ts). Defaults keep the
// DeepCharts palette: BLUE = aggressive buyers, PINK = aggressive sellers — distinct
// from the green/red candles so markers never blend into bars.

/** Compact number for inside the circle: 87, 130, 1.2k. */
function absorbLabel(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return v >= 10 ? `${Math.round(v)}` : v.toFixed(1);
}

/** One absorption marker = one (side, candle). Evidence accumulates; it is rendered
 *  through GPU scatter + text series (see flushAbsorb), not per-marker DOM/SVG. */
interface AbsorbGroup {
  side: "buy" | "sell";
  bar: number;
  /** Bar-close candle detector hit (wick anchor + volume ratio). Recomputed on rebuild. */
  detector: HeavyAbsorptionPoint | null;
  /** Live tape episodes merged into this candle (oz, and Σ price×qty for the VWAP). */
  liveQty: number;
  livePxQty: number;
  /** Aggression traded into a resting wall (square tier). */
  wall: boolean;
  /** Bubble-regime "battle": absorbed AND open interest rose (diamond tier). */
  battle: boolean;
  battlePx: number | null;
}

function groupShape(g: AbsorbGroup): AbsorbShape {
  return g.battle ? "diamond" : g.wall ? "square" : "circle";
}

/** Detector markers stay on their wick; live-only markers sit at the episode VWAP. */
function groupPrice(g: AbsorbGroup): number | null {
  if (g.detector) return g.detector.price;
  if (g.liveQty > 0) return g.livePxQty / g.liveQty;
  return g.battlePx;
}

function groupLabel(g: AbsorbGroup): string {
  return absorbLabel(g.detector?.volRatio ?? g.liveQty);
}

const ABSORB_SHAPES: AbsorbShape[] = ["circle", "square", "diamond"];
const ABSORB_SIDES: Array<"buy" | "sell"> = ["buy", "sell"];

interface AbsorbLayer {
  scatter: Record<"buy" | "sell", { data: XyDataSeries; rs: XyScatterRenderableSeries }>;
  text: { data: XyTextDataSeries; rs: FastTextRenderableSeries };
}

export interface ChartConfig {
  tickSize: number;
  timeframe: Timeframe;
}

// --- Volume Delta Candle coloring (LuxAlgo "Volume Delta Candles" style) ------
// BODY  = sign of the bar's aggressor delta (taker buy − taker sell), brightness
//         scaled by |delta| relative to the mean |delta| of the loaded bars, so weak
//         imbalance bars fade and heavy-imbalance bars are saturated.
// WICK/OUTLINE = price direction (close vs open). A green outline with a red body is a
//         delta divergence: price rose while sellers were the aggressors (absorption).
//
// Historical bars get real delta from REST kline taker-buy volume; the forming bar
// sums the bridge's live 1-minute trade buckets.
//
// IMPORTANT: for the candlestick series, returning `undefined` from an override does
// NOT fall back to brushUp/brushDown — the native draw path passes fill=undefined as
// the fallback, which renders NEUTRAL (white). So when enabled we return an explicit
// color for every candle.

class DeltaPaletteProvider
  implements IFillPaletteProvider, IStrokePaletteProvider
{
  readonly fillPaletteMode = EFillPaletteMode.SOLID;
  readonly strokePaletteMode = EStrokePaletteMode.SOLID;
  readonly isRangeIndependant = true;

  /** Delta per candle, index-aligned with the OhlcDataSeries. */
  private deltas: Array<number | null>;
  /** When false, overrides are disabled and the series uses its default coloring. */
  enabled = false;
  /** |delta| <= deadband is treated as neutral (use close-vs-open fallback). */
  private readonly deadband: number;

  // Delta-candle colours follow the user's up/down candle body colours.
  private upArgb = parseColorToUIntArgb(DEFAULT_CHART_STYLE.candleUpBody);
  private downArgb = parseColorToUIntArgb(DEFAULT_CHART_STYLE.candleDownBody);

  setColors(up: string, down: string) {
    this.upArgb = parseColorToUIntArgb(up);
    this.downArgb = parseColorToUIntArgb(down);
  }
  /** Low-delta body color (bars with weak imbalance fade toward this). */
  private readonly dimArgb = parseColorToUIntArgb("#2a2e39");

  constructor(deltas: Array<number | null>, deadband = 0) {
    this.deltas = deltas;
    this.deadband = deadband;
  }

  /** Swap the backing array (e.g. after a timeframe reset reallocates it). */
  setDeltas(deltas: Array<number | null>) {
    this.deltas = deltas;
  }

  onAttached(_parentSeries: IRenderableSeries): void {}
  onDetached(): void {}
  /** Mean |delta| over the loaded bars, refreshed once per render pass. */
  private meanAbs = 0;
  /** Called once before the per-point loop. Always recompute while enabled so live
   *  delta changes repaint (a state-dependent return let SciChart reuse a stale
   *  palette cache). Also refreshes the intensity normaliser here, not per point. */
  shouldUpdatePalette(): boolean {
    if (this.enabled) {
      let s = 0;
      let n = 0;
      for (const d of this.deltas) {
        if (d != null && Number.isFinite(d) && d !== 0) {
          s += Math.abs(d);
          n++;
        }
      }
      this.meanAbs = n > 0 ? s / n : 0;
    }
    return true;
  }

  /** Linear blend of two ARGB colors (t=0 → a, t=1 → b), alpha forced opaque. */
  private static mix(a: number, b: number, t: number): number {
    const ch = (c: number, sh: number) => (c >>> sh) & 0xff;
    const r = Math.round(ch(a, 16) + (ch(b, 16) - ch(a, 16)) * t);
    const g = Math.round(ch(a, 8) + (ch(b, 8) - ch(a, 8)) * t);
    const bl = Math.round(ch(a, 0) + (ch(b, 0) - ch(a, 0)) * t);
    return ((0xff << 24) | (r << 16) | (g << 8) | bl) >>> 0;
  }

  private priceUp(index: number, close: number, otherValues?: Map<string, Float64Array>): boolean | undefined {
    const open = otherValues?.get(EValueName.Open)?.[index];
    if (open === undefined || !Number.isFinite(open)) return undefined;
    return close >= open;
  }

  /** Body: delta sign, brightness scaled by |delta| vs the mean (weak = dim). */
  private fillFor(index: number, close: number, otherValues?: Map<string, Float64Array>): number | undefined {
    if (!this.enabled) return undefined;
    const d = this.deltas[index];
    if (d == null || !Number.isFinite(d) || Math.abs(d) <= this.deadband || this.meanAbs <= 0) {
      // No delta for this bar: plain close-vs-open color so it never renders white.
      const up = this.priceUp(index, close, otherValues);
      return up === undefined ? undefined : up ? this.upArgb : this.downArgb;
    }
    // |delta| = 2x mean or more → full color; tiny delta → mostly the dim base.
    const t = Math.min(1, 0.2 + 0.8 * (Math.abs(d) / (2 * this.meanAbs)));
    return DeltaPaletteProvider.mix(this.dimArgb, d > 0 ? this.upArgb : this.downArgb, t);
  }

  /** Outline/wick: price direction, so a body that disagrees with it = delta divergence. */
  private strokeFor(index: number, close: number, otherValues?: Map<string, Float64Array>): number | undefined {
    if (!this.enabled) return undefined;
    const up = this.priceUp(index, close, otherValues);
    return up === undefined ? undefined : up ? this.upArgb : this.downArgb;
  }

  overrideFillArgb(
    _x: number,
    yValue: number,
    index: number,
    _opacity?: number,
    _metadata?: unknown,
    otherValues?: Map<string, Float64Array>,
  ): number | undefined {
    return this.fillFor(index, yValue, otherValues);
  }

  overrideStrokeArgb(
    _x: number,
    yValue: number,
    index: number,
    _opacity?: number,
    _metadata?: unknown,
    otherValues?: Map<string, Float64Array>,
  ): number | undefined {
    return this.strokeFor(index, yValue, otherValues);
  }
}

export class TerminalChart {
  private surface!: SciChartSurface;
  private cfg: ChartConfig;
  private tfSeconds: number;

  private xAxis!: DateTimeNumericAxis;
  private yAxis!: NumericAxis;

  private candleData!: OhlcDataSeries;
  private candlestickSeries!: FastCandlestickRenderableSeries;
  // Per-candle order-flow delta (oz), index-aligned with candleData, for the
  // Volume Delta Candle coloring. Mutated in lockstep with candle append/remove.
  private candleDelta: Array<number | null> = [];
  private deltaPalette!: DeltaPaletteProvider;
  private plainPalette = DefaultPaletteProvider.createEmpty();

  private heatmapData!: UniformHeatmapDataSeries;
  private heatmapSeries!: UniformHeatmapRenderableSeries;

  // Absorption markers: model (one group per side×candle) + GPU series per size tier.
  private absorbGroups = new Map<string, AbsorbGroup>();
  private absorbLayers!: Record<AbsorbShape, AbsorbLayer>;
  private absorbDirty = false;

  // Crosshair + pointer tracking (hover readout / click hit-test).
  private cursorModifier!: CursorModifier;
  private pointer!: PointerTrackerModifier;
  private crosshairEnabled = true;

  // User colour settings (candles + bubbles); applied live by setStyle().
  private style: ChartStyle = { ...DEFAULT_CHART_STYLE };

  private vacuumAnnotations: (
    | BoxAnnotation
    | HorizontalLineAnnotation
    | TextAnnotation
  )[] = [];
  private hoplaAnnotations: HorizontalLineAnnotation[] = [];
  private markPriceAnnotation: HorizontalLineAnnotation | null = null;
  // --- Audit R3: key levels + sweep markers + v7.5 institutional signals ---
  private keyLevelAnnotations: HorizontalLineAnnotation[] = [];
  private sweepAnnotations: (BoxAnnotation | TextAnnotation)[] = [];
  private bubbleRegimeAnnotations: TextAnnotation[] = [];
  private signalAnnotations: (HorizontalLineAnnotation | TextAnnotation)[] = [];
  private keyLevelsSig = "";
  private sweepsSig = "";
  private bubblesSig = "";
  private signalsSig = "";

  // Candle history storage for the rolling absorption detector.
  private historicalCandles: CandleData[] = [];

  // Heatmap rolling grids [PRICE_ROWS][HEATMAP_COLS] (ring-buffered on the X axis).
  // displayZGrid is handed to SciChart BY REFERENCE and mutated in place; changes are
  // published with one notifyDataChanged() instead of re-validating a 38k-cell copy.
  private rawZGrid: number[][] = [];
  private displayZGrid: number[][] = [];
  private heatmapFadeEnabled = false;
  private heatmapFadeStrength = 0.7;
  private priceFloor = 0;
  private lastHeatmapBucket = 0;
  private heatmapInitialized = false;
  /** Raw grid changed while the layer was hidden: full refresh when shown again. */
  private heatmapStale = false;

  // Candle aggregation state (bucketStartSec -> ohlc).
  private curBucket = 0;
  private curOhlc: { o: number; h: number; l: number; c: number } | null = null;
  private curBucketMaxVol = 0;

  // Live delta accumulation for the forming chart bar. The bridge's trade candle is a
  // fixed 1-minute bucket, so on 5m/15m charts the bar delta is the sum of every
  // minute bucket inside it. `barDeltaBase` is the REST (taker-buy) delta seeded at
  // load time; `minuteBaseline` removes the part of the load-minute that REST already
  // counted, so nothing is double-counted.
  private minuteDelta = new Map<number, number>();
  private minuteBaseline = new Map<number, number>();
  private barDeltaBase = 0;
  private deltaSeedMinuteMs = -1;

  // Live-follow control.
  private liveFollow = true;
  private suppressRangeEvents = false;

  // Layer visibility state (driven by the cockpit header).
  private layers: Record<ChartLayer, boolean> = {
    heatmap: true,
    bubbles: true,
    vacuum: true,
    hopla: true,
    delta: false,
  };

  // Last frame kept so toggles can re-render overlays without a new tick.
  private lastFrame: ChartFrame | null = null;

  // --- Perf: signature caches so overlays only rebuild when data changes ---
  private vacuumSig = "";
  private hoplaSig = "";
  private seenFootprintIds = new Set<string>();
  // Last applied live-view range, to skip redundant visibleRange writes.
  private lastViewFirstX = NaN;
  private lastViewLastX = NaN;
  private lastViewPad = NaN;
  private lastViewWidth = NaN;
  private lastViewLo = NaN;
  private lastViewHi = NaN;

  constructor(cfg: ChartConfig) {
    this.cfg = cfg;
    this.tfSeconds = TIMEFRAME_SECONDS[cfg.timeframe];
    for (let r = 0; r < PRICE_ROWS; r++) {
      this.rawZGrid.push(new Array(HEATMAP_COLS).fill(0));
      this.displayZGrid.push(new Array(HEATMAP_COLS).fill(0));
    }
  }

  async init(rootElement: string | HTMLDivElement) {
    const { sciChartSurface, wasmContext } = await SciChartSurface.create(
      rootElement,
      {
        theme: new SciChartJsNavyTheme(),
      },
    );
    this.surface = sciChartSurface;

    // --- X = time (DateTime), Y = price ---
    this.xAxis = new DateTimeNumericAxis(wasmContext, {
      drawMajorGridLines: true,
      labelProvider: new SmartDateLabelProvider(),
      autoRange: EAutoRange.Never,
    });
    this.yAxis = new NumericAxis(wasmContext, {
      axisAlignment: EAxisAlignment.Right,
      growBy: new NumberRange(0.08, 0.08),
      autoRange: EAutoRange.Never,
      labelPrecision: 2,
    });
    this.surface.xAxes.add(this.xAxis);
    this.surface.yAxes.add(this.yAxis);

    // Stop live-follow when the user zooms or pans manually.
    this.xAxis.visibleRangeChanged.subscribe(() => {
      if (!this.suppressRangeEvents) this.liveFollow = false;
    });

    // --- Bookmap Heatmap (behind candles) ---
    this.heatmapData = new UniformHeatmapDataSeries(wasmContext, {
      xStart: 0,
      xStep: this.tfSeconds,
      yStart: 0,
      yStep: this.cfg.tickSize,
      zValues: this.displayZGrid,
    });
    this.heatmapSeries = new UniformHeatmapRenderableSeries(wasmContext, {
      dataSeries: this.heatmapData,
      opacity: 0.38,
      colorMap: new HeatmapColorMap({
        minimum: 0,
        maximum: 1000,
        gradientStops: [
          { offset: 0, color: "transparent" },
          { offset: 0.1, color: "#11263c55" },
          { offset: 0.25, color: "#1d477388" },
          { offset: 0.5, color: "#2563eb99" },
          { offset: 0.75, color: "#f59e0baa" },
          { offset: 1.0, color: "#ef4444cc" },
        ],
      }),
    });
    this.surface.renderableSeries.add(this.heatmapSeries);

    // --- Candlesticks ---
    // Candles are strictly time-ordered and never NaN: these flags let SciChart use
    // its fast resampling / binary-search paths instead of scanning.
    this.candleData = new OhlcDataSeries(wasmContext, { isSorted: true, containsNaN: false });
    this.deltaPalette = new DeltaPaletteProvider(this.candleDelta);
    this.deltaPalette.setColors(this.style.candleUpBody, this.style.candleDownBody);
    this.deltaPalette.enabled = this.layers.delta;
    this.candlestickSeries = new FastCandlestickRenderableSeries(wasmContext, {
      dataSeries: this.candleData,
      strokeThickness: 1,
      brushUp: this.style.candleUpBody,
      brushDown: this.style.candleDownBody,
      strokeUp: this.style.candleUpWick,
      strokeDown: this.style.candleDownWick,
      dataPointWidth: 0.7,
      dataPointWidthMode: EDataPointWidthMode.Relative,
      // Attached only while the Delta layer is on (applyLayerVisibility), so plain
      // candles never pay the per-candle palette pass.
      paletteProvider: this.layers.delta ? this.deltaPalette : this.plainPalette,
    });
    this.surface.renderableSeries.add(this.candlestickSeries);

    // --- Absorption markers (GPU): per size tier one scatter series per side plus
    //     one text series for the numbers. Hundreds of markers cost one draw call per
    //     series instead of one SVG DOM node each, and pan/zoom no longer relayouts.
    this.absorbLayers = {} as Record<AbsorbShape, AbsorbLayer>;
    for (const shape of ABSORB_SHAPES) {
      const battle = shape === "diamond";
      const size = MARKER_PX[shape] * 2;
      const scatter = {} as AbsorbLayer["scatter"];
      for (const side of ABSORB_SIDES) {
        const col = bubblePaint(this.style, side, battle);
        const data = new XyDataSeries(wasmContext, { containsNaN: false, isSorted: false });
        const rs = new XyScatterRenderableSeries(wasmContext, {
          dataSeries: data,
          pointMarker: new EllipsePointMarker(wasmContext, {
            width: size,
            height: size,
            fill: col.fill,
            stroke: col.stroke,
            strokeThickness: col.strokeThickness,
          }),
        });
        this.surface.renderableSeries.add(rs);
        scatter[side] = { data, rs };
      }
      const tdata = new XyTextDataSeries(wasmContext, { isSorted: false, containsNaN: false });
      const trs = new FastTextRenderableSeries(wasmContext, {
        dataSeries: tdata,
        dataLabels: {
          style: { fontFamily: "Arial", fontSize: MARKER_FONT[shape] },
          color: this.style.bubbleText,
          horizontalTextPosition: EHorizontalTextPosition.Center,
          verticalTextPosition: EVerticalTextPosition.Center,
          calculateTextBounds: false,
        },
      });
      this.surface.renderableSeries.add(trs);
      this.absorbLayers[shape] = { scatter, text: { data: tdata, rs: trs } };
    }

    // --- Crosshair: native cursor (lines + axis badges), no SciChart tooltip — the
    //     OHLC readout is a DOM legend driven by getReadout(). The pointer tracker
    //     shares SciChart's coordinate space for hover + click hit-tests.
    this.cursorModifier = new CursorModifier({
      crosshairStroke: "#94a3b8",
      crosshairStrokeThickness: 1,
      crosshairStrokeDashArray: [3, 3],
      showTooltip: false,
      showAxisLabels: true,
      axisLabelFill: "#334155",
      axisLabelStroke: "#f8fafc",
    });
    this.cursorModifier.isEnabled = this.crosshairEnabled;
    this.pointer = new PointerTrackerModifier();

    // --- Interaction: wheel zoom, drag pan, double-click reset to live extents ---
    this.surface.chartModifiers.add(
      new ZoomPanModifier(),
      new MouseWheelZoomModifier(),
      new ZoomExtentsModifier({
        onZoomExtents: () => {
          this.resetView();
          return false;
        },
      }),
      this.cursorModifier,
      this.pointer,
    );

    // Apply initial layer visibility now that series exist.
    this.applyLayerVisibility();
  }

  /** Toggle an overlay group on/off. Re-renders dependent annotations when needed. */
  setLayerVisibility(layer: ChartLayer, visible: boolean) {
    this.layers[layer] = visible;
    this.applyLayerVisibility();
    // Vacuum + Hopla are annotation-based; force a rebuild from the last frame.
    if ((layer === "vacuum" || layer === "hopla") && this.lastFrame) {
      if (layer === "vacuum") {
        this.vacuumSig = "";
        this.updateVacuum(this.lastFrame);
      } else {
        this.hoplaSig = "";
        this.updateHopla(this.lastFrame);
      }
    }
    // Bubble-regime markers share the `bubbles` toggle; rebuild from last frame.
    if (layer === "bubbles" && this.lastFrame) {
      this.bubblesSig = "";
      this.updateBubbleRegimes(this.lastFrame);
    }
  }

  getLayerVisibility(): Record<ChartLayer, boolean> {
    return { ...this.layers };
  }

  private applyLayerVisibility() {
    if (this.heatmapSeries) {
      const wasHidden = !this.heatmapSeries.isVisible;
      this.heatmapSeries.isVisible = this.layers.heatmap;
      // Grid kept advancing while hidden but was not pushed to the GPU; catch up now.
      if (wasHidden && this.layers.heatmap && this.heatmapStale && this.heatmapInitialized) {
        this.heatmapStale = false;
        this.recalculateDisplayGrid();
        this.heatmapData.notifyDataChanged(EDataChangeType.Update);
      }
    }
    if (this.absorbLayers) {
      for (const shape of ABSORB_SHAPES) {
        const l = this.absorbLayers[shape];
        l.scatter.buy.rs.isVisible = this.layers.bubbles;
        l.scatter.sell.rs.isVisible = this.layers.bubbles;
        l.text.rs.isVisible = this.layers.bubbles;
      }
    }
    for (const m of this.bubbleRegimeAnnotations)
      m.isHidden = !this.layers.bubbles;
    if (this.deltaPalette && this.candlestickSeries) {
      this.deltaPalette.enabled = this.layers.delta;
      const want = this.layers.delta ? this.deltaPalette : this.plainPalette;
      if (this.candlestickSeries.paletteProvider !== want) this.candlestickSeries.paletteProvider = want;
      this.surface?.invalidateElement({ force: true });
    }
  }

  /** Apply candle + bubble colours. Safe before init() (used as construction values).
   *  Mutates series/markers in place — no data rebuild. */
  setStyle(style: ChartStyle) {
    this.style = { ...style };
    if (!this.candlestickSeries) return;
    const cs = this.candlestickSeries;
    cs.brushUp = style.candleUpBody;
    cs.brushDown = style.candleDownBody;
    cs.strokeUp = style.candleUpWick;
    cs.strokeDown = style.candleDownWick;
    this.deltaPalette.setColors(style.candleUpBody, style.candleDownBody);
    for (const shape of ABSORB_SHAPES) {
      const layer = this.absorbLayers[shape];
      for (const side of ABSORB_SIDES) {
        const paint = bubblePaint(style, side, shape === "diamond");
        const pm = layer.scatter[side].rs.pointMarker;
        if (pm) {
          pm.fill = paint.fill;
          pm.stroke = paint.stroke;
          pm.strokeThickness = paint.strokeThickness;
        }
      }
      layer.text.rs.dataLabelProvider.color = style.bubbleText;
    }
    this.surface?.invalidateElement({ force: true });
  }

  /** Crosshair (cursor lines + axis badges) on/off. */
  setCrosshair(enabled: boolean) {
    this.crosshairEnabled = enabled;
    if (this.cursorModifier) this.cursorModifier.isEnabled = enabled;
    this.surface?.invalidateElement({ force: true });
  }

  /** Called on every pointer move/leave over the plot (hover readout). */
  setPointerListener(fn: (() => void) | null) {
    if (this.pointer) this.pointer.onMove = fn;
  }

  /** OHLC readout for the candle under the pointer, or the live (last) candle when
   *  the pointer is outside the plot. O(log n) binary search on the x values. */
  getReadout(): CandleReadout | null {
    const n = this.candleData?.count() ?? 0;
    if (n === 0) return null;
    const xs = this.candleData.getNativeXValues();
    let idx = n - 1;
    let cursorPrice: number | null = null;
    const p = this.pointer?.point;
    if (p) {
      const xCalc = this.xAxis.getCurrentCoordinateCalculator();
      const yCalc = this.yAxis.getCurrentCoordinateCalculator();
      const xv = xCalc.getDataValue(p.x);
      cursorPrice = yCalc.getDataValue(p.y);
      // Candle i covers [x_i, x_i + tf): last index with x_i <= xv.
      let lo = 0;
      let hi = n - 1;
      if (xv < xs.get(0)) idx = 0;
      else {
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (xs.get(mid) <= xv) lo = mid;
          else hi = mid - 1;
        }
        idx = lo;
      }
    }
    const t = xs.get(idx);
    const j = this.findCandleIndex(t);
    const vol = j >= 0 ? this.historicalCandles[j].volume : null;
    const d = this.candleDelta[idx];
    return {
      time: t,
      open: this.candleData.getNativeOpenValues().get(idx),
      high: this.candleData.getNativeHighValues().get(idx),
      low: this.candleData.getNativeLowValues().get(idx),
      close: this.candleData.getNativeCloseValues().get(idx),
      volume: vol,
      delta: d != null && Number.isFinite(d) ? d : null,
      cursorPrice,
      live: idx === n - 1,
    };
  }

  /** Historical candles sorted by time (for O(log n) readout lookups). */
  private findCandleIndex(t: number): number {
    const hc = this.historicalCandles;
    let lo = 0;
    let hi = hc.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (hc[mid].time === t) return mid;
      if (hc[mid].time < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Load historical candles from Binance to seed price action + absorption history. */
  loadHistoricalCandles(candles: CandleData[]) {
    if (!this.surface || candles.length === 0) return;
    this.historicalCandles = [...candles];
    this.candleData.clear();
    this.candleDelta.length = 0;
    for (const c of candles) {
      this.candleData.append(c.time, c.open, c.high, c.low, c.close);
      // Real aggressor delta from REST taker-buy volume (null if the field is absent).
      this.candleDelta.push(c.delta ?? null);
    }
    const last = candles[candles.length - 1];
    this.curBucket = last.time;
    this.curOhlc = { o: last.open, h: last.high, l: last.low, c: last.close };
    this.curBucketMaxVol = last.volume;
    // The last REST bar is still forming: its delta covers trades up to fetch time.
    // Live minute deltas are added on top, minus what the fetch-minute already held.
    this.barDeltaBase = last.delta ?? 0;
    this.deltaSeedMinuteMs = Math.floor(Date.now() / 60_000) * 60_000;
    this.minuteDelta.clear();
    this.minuteBaseline.clear();

    if (this.priceFloor === 0) {
      const span = PRICE_ROWS * this.cfg.tickSize;
      this.priceFloor =
        Math.round((last.close - span / 2) / this.cfg.tickSize) *
        this.cfg.tickSize;
    }

    this.rebuildHeavyAbsorptions();
    this.liveFollow = true;
    this.invalidateView();
    this.applyLiveView();
  }

  /** Switch timeframe: clear state and prepare for new klines. */
  setTimeframe(tf: Timeframe) {
    this.cfg.timeframe = tf;
    this.tfSeconds = TIMEFRAME_SECONDS[tf];
    this.curOhlc = null;
    this.curBucket = 0;
    this.curBucketMaxVol = 0;
    this.candleDelta.length = 0;
    this.minuteDelta.clear();
    this.minuteBaseline.clear();
    this.barDeltaBase = 0;
    this.deltaSeedMinuteMs = -1;
    this.heatmapInitialized = false;
    this.lastHeatmapBucket = 0;
    this.historicalCandles = [];
    this.seenFootprintIds.clear();
    this.vacuumSig = "";
    this.hoplaSig = "";
    this.keyLevelsSig = "";
    this.sweepsSig = "";
    this.signalsSig = "";
    for (const a of this.keyLevelAnnotations)
      this.surface?.annotations.remove(a);
    this.keyLevelAnnotations = [];
    for (const a of this.sweepAnnotations) this.surface?.annotations.remove(a);
    this.sweepAnnotations = [];
    for (const a of this.signalAnnotations) this.surface?.annotations.remove(a);
    this.signalAnnotations = [];
    this.bubblesSig = "";
    for (const a of this.bubbleRegimeAnnotations)
      this.surface?.annotations.remove(a);
    this.bubbleRegimeAnnotations = [];
    this.clearAbsorb();
    for (let r = 0; r < PRICE_ROWS; r++) {
      this.rawZGrid[r].fill(0);
      this.displayZGrid[r].fill(0);
    }
    this.heatmapData?.notifyDataChanged(EDataChangeType.Update);
    this.candleData?.clear();
    this.lastFrame = null;
    this.liveFollow = true;
    this.invalidateView();
  }

  /** Market-data venue changed (e.g. Binance → OANDA): drop everything derived from
   *  the old feed, including the heatmap price anchor and the mark line. */
  resetForVenue() {
    this.setTimeframe(this.cfg.timeframe);
    this.priceFloor = 0;
    this.vacuumAnnotations.forEach((a) => this.surface?.annotations.remove(a));
    this.vacuumAnnotations = [];
    this.hoplaAnnotations.forEach((a) => this.surface?.annotations.remove(a));
    this.hoplaAnnotations = [];
    if (this.markPriceAnnotation) {
      this.surface?.annotations.remove(this.markPriceAnnotation);
      this.markPriceAnnotation = null;
    }
  }

  /** Feed a (coalesced) websocket frame. Called at most once per animation frame. */
  update(frame: ChartFrame) {
    if (!this.surface || !frame.mid_price) return;
    this.lastFrame = frame;
    const nowSec = Math.floor((frame.timestamp ?? Date.now()) / 1000);
    const newCandle = this.updateCandles(frame, nowSec);
    if (newCandle) {
      this.rebuildHeavyAbsorptions();
    }
    this.updateHeatmap(frame, nowSec);
    if (frame.absorption_candidates && frame.absorption_candidates.length > 0) {
      this.appendLiveFootprints(frame.absorption_candidates);
    }
    this.updateVacuum(frame);
    this.updateHopla(frame);
    this.updateMarkPrice(frame.mid_price);
    // --- Audit R3: key levels + sweep markers + v7.5 institutional signals ---
    this.updateKeyLevels(frame);
    this.updateSweeps(frame);
    this.updateSignals(frame);
    this.updateBubbleRegimes(frame);
    this.flushAbsorb();
    if (this.liveFollow) {
      this.applyLiveView();
    }
    this.surface.invalidateElement({ force: true });
  }

  /**
   * Delta of the forming chart bar. The bridge streams a fixed 1-minute trade candle,
   * so a 5m/15m bar's delta is the sum of the minute buckets inside it, plus the REST
   * taker-buy delta seeded at load (minus the fetch-minute portion REST already had).
   */
  private liveBarDelta(tc: ChartFrame["trade_candle"]): number {
    if (tc) {
      if (tc.t === this.deltaSeedMinuteMs && !this.minuteBaseline.has(tc.t)) {
        this.minuteBaseline.set(tc.t, tc.d);
      }
      this.minuteDelta.set(tc.t, tc.d);
    }
    const startMs = this.curBucket * 1000;
    const endMs = startMs + this.tfSeconds * 1000;
    let sum = this.barDeltaBase;
    for (const [t, d] of this.minuteDelta) {
      if (t < startMs) {
        this.minuteDelta.delete(t); // older bars are final; drop
        this.minuteBaseline.delete(t);
      } else if (t < endMs) {
        sum += d - (this.minuteBaseline.get(t) ?? 0);
      }
    }
    return sum;
  }

  /** Returns true when a new candle bucket was opened (caller rebuilds bubbles). */
  private updateCandles(frame: ChartFrame, nowSec: number): boolean {
    const price = frame.mid_price;
    const tc = frame.trade_candle;
    const bucket = Math.floor(nowSec / this.tfSeconds) * this.tfSeconds;
    if (this.curOhlc === null || bucket > this.curBucket) {
      if (this.historicalCandles.length > 0 && this.curOhlc !== null) {
        const closing =
          this.historicalCandles[this.historicalCandles.length - 1];
        if (closing.time === this.curBucket) {
          closing.volume = Math.max(closing.volume, this.curBucketMaxVol);
        }
      }

      this.curBucket = bucket;
      this.curOhlc = { o: price, h: price, l: price, c: price };
      this.curBucketMaxVol = tc ? tc.v : 0;
      this.barDeltaBase = 0; // a bar opened live has no REST-seeded portion
      this.candleData.append(bucket, price, price, price, price);
      // Keep the delta array index-aligned with candleData: append this bar's
      // starting delta, then trim from the front in lockstep with removeAt(0).
      this.candleDelta.push(this.liveBarDelta(tc));
      while (this.candleData.count() > MAX_CANDLES) {
        this.candleData.removeAt(0);
        this.candleDelta.shift();
      }
      this.historicalCandles.push({
        time: bucket,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: tc ? tc.v : 0,
      });
      while (this.historicalCandles.length > MAX_CANDLES) {
        this.historicalCandles.shift();
      }
      return true;
    }
    this.curOhlc.h = Math.max(this.curOhlc.h, price);
    this.curOhlc.l = Math.min(this.curOhlc.l, price);
    this.curOhlc.c = price;
    const idx = this.candleData.count() - 1;
    if (idx >= 0) {
      this.candleData.update(
        idx,
        this.curOhlc.o,
        this.curOhlc.h,
        this.curOhlc.l,
        this.curOhlc.c,
      );
      // Refresh the forming bar's delta (sum of every 1m trade bucket in this bar)
      // so the candle color tracks the live buy/sell imbalance.
      if (tc) this.candleDelta[idx] = this.liveBarDelta(tc);
    }
    if (this.historicalCandles.length > 0) {
      const last = this.historicalCandles[this.historicalCandles.length - 1];
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      if (tc) {
        this.curBucketMaxVol = Math.max(this.curBucketMaxVol, tc.v);
        last.volume = Math.max(last.volume, tc.v);
      }
    }
    return false;
  }

  /**
   * Re-run the bar-close Heavy Absorption detector over the candle history and merge
   * its hits into the marker model. Live-tape evidence and regime "battle" upgrades
   * already attached to a candle are preserved (they used to be wiped at every candle
   * close, so live markers vanished as soon as the bridge's 4 s window rolled on).
   */
  private rebuildHeavyAbsorptions() {
    if (!this.surface) return;
    for (const g of this.absorbGroups.values()) g.detector = null;

    const points = detectHeavyAbsorptions(this.historicalCandles);
    for (const pt of points) {
      // buyers_absorbed = aggressive BUYERS were absorbed → aggressor side "buy".
      const side: "buy" | "sell" = pt.type === "buyers_absorbed" ? "buy" : "sell";
      this.absorbGroup(side, pt.time).detector = pt;
    }

    // Drop markers with no remaining evidence and anything older than the chart.
    const oldest = this.historicalCandles.length ? this.historicalCandles[0].time : -Infinity;
    for (const [k, g] of this.absorbGroups) {
      if (g.bar < oldest || (!g.detector && g.liveQty <= 0 && !g.battle)) this.absorbGroups.delete(k);
    }
    this.absorbDirty = true;
  }

  /** Get-or-create the single marker group for (side, candle). */
  private absorbGroup(side: "buy" | "sell", timeSec: number): AbsorbGroup {
    const bar = Math.floor(timeSec / this.tfSeconds) * this.tfSeconds;
    const key = `${side}-${bar}`;
    let g = this.absorbGroups.get(key);
    if (!g) {
      g = { side, bar, detector: null, liveQty: 0, livePxQty: 0, wall: false, battle: false, battlePx: null };
      this.absorbGroups.set(key, g);
    }
    return g;
  }

  private clearAbsorb() {
    this.absorbGroups.clear();
    this.seenFootprintIds.clear();
    this.absorbDirty = true;
  }

  /**
   * Push the marker model to the GPU series — only when something changed, and at
   * most once per animation frame (called at the end of update()). A few hundred
   * points per series: a clear + appendRange is far cheaper than diffing.
   */
  private flushAbsorb() {
    if (!this.absorbDirty || !this.absorbLayers) return;
    this.absorbDirty = false;
    type Buf = { x: number[]; y: number[] };
    const pts: Record<AbsorbShape, Record<"buy" | "sell", Buf>> = {
      circle: { buy: { x: [], y: [] }, sell: { x: [], y: [] } },
      square: { buy: { x: [], y: [] }, sell: { x: [], y: [] } },
      diamond: { buy: { x: [], y: [] }, sell: { x: [], y: [] } },
    };
    const txt: Record<AbsorbShape, Buf & { t: string[] }> = {
      circle: { x: [], y: [], t: [] },
      square: { x: [], y: [], t: [] },
      diamond: { x: [], y: [], t: [] },
    };
    for (const g of this.absorbGroups.values()) {
      const y = groupPrice(g);
      if (y == null || !Number.isFinite(y)) continue;
      const shape = groupShape(g);
      pts[shape][g.side].x.push(g.bar);
      pts[shape][g.side].y.push(y);
      const label = groupLabel(g);
      if (label) {
        txt[shape].x.push(g.bar);
        txt[shape].y.push(y);
        txt[shape].t.push(label);
      }
    }
    for (const shape of ABSORB_SHAPES) {
      const layer = this.absorbLayers[shape];
      for (const side of ABSORB_SIDES) {
        const { data } = layer.scatter[side];
        data.clear();
        if (pts[shape][side].x.length) data.appendRange(pts[shape][side].x, pts[shape][side].y);
      }
      layer.text.data.clear();
      if (txt[shape].x.length) layer.text.data.appendRange(txt[shape].x, txt[shape].y, txt[shape].t);
    }
  }

  /**
   * Incrementally merge live order-flow absorption footprints.
   *
   * The bridge re-evaluates its rolling absorption window on every trade, so one
   * sustained episode emits many near-identical candidates a few cents apart. They
   * are the same event and merge into the single marker for that candle/side
   * (volume-weighted price, summed size). `wall` upgrades it to the larger tier.
   */
  private appendLiveFootprints(
    candidates: ChartFrame["absorption_candidates"],
  ) {
    if (!this.surface || !candidates) return;
    for (const a of candidates) {
      const t = Math.floor(a.timestamp / 1000);
      const px = Number(a.price);
      if (!Number.isFinite(px)) continue;
      const id = `${a.side}-${t}-${px}`;
      if (this.seenFootprintIds.has(id)) continue;
      this.seenFootprintIds.add(id);

      const side: "buy" | "sell" = a.side === "buy" ? "buy" : "sell";
      const qty = Math.max(Number(a.executedQuantity ?? 0) || 0, 1e-9);
      const g = this.absorbGroup(side, t);
      g.liveQty += qty;
      g.livePxQty += px * qty;
      if (a.wall) g.wall = true;
      this.absorbDirty = true;
    }
    if (this.seenFootprintIds.size > 2000) {
      const recent = Array.from(this.seenFootprintIds).slice(-500);
      this.seenFootprintIds = new Set(recent);
    }
  }

  private updateHeatmap(frame: ChartFrame, nowSec: number) {
    const mid = frame.mid_price;
    const span = PRICE_ROWS * this.cfg.tickSize;
    // full: every column must be re-derived (shift / re-anchor / init).
    // colDirty: only the live (right-most) column changed — the common intra-bar case.
    let full = false;
    let colDirty = false;

    if (
      this.priceFloor === 0 ||
      mid < this.priceFloor + 15 ||
      mid > this.priceFloor + span - 15
    ) {
      const oldPriceFloor = this.priceFloor;
      const newPriceFloor =
        Math.round((mid - span / 2) / this.cfg.tickSize) * this.cfg.tickSize;
      if (oldPriceFloor !== 0 && oldPriceFloor !== newPriceFloor) {
        const rowDelta = Math.round(
          (newPriceFloor - oldPriceFloor) / this.cfg.tickSize,
        );
        for (let c = 0; c < HEATMAP_COLS; c++) {
          const colData = new Array(PRICE_ROWS).fill(0);
          for (let r = 0; r < PRICE_ROWS; r++) {
            const oldR = r + rowDelta;
            if (oldR >= 0 && oldR < PRICE_ROWS) {
              colData[r] = this.rawZGrid[oldR][c];
            }
          }
          for (let r = 0; r < PRICE_ROWS; r++) {
            this.rawZGrid[r][c] = colData[r];
          }
        }
      }
      this.priceFloor = newPriceFloor;
      full = true;
    }

    const bucket = Math.floor(nowSec / this.tfSeconds) * this.tfSeconds;
    const zones = frame.liquidity_zones ?? [];
    const col = HEATMAP_COLS - 1;

    if (!this.heatmapInitialized) {
      this.heatmapInitialized = true;
      this.lastHeatmapBucket = bucket;
      for (let r = 0; r < PRICE_ROWS; r++) this.rawZGrid[r].fill(0);

      for (const z of zones) {
        const lo = Number(z.priceLow);
        const hi = Number(z.priceHigh);
        const qty = Number(z.displayedQuantity);
        if (!Number.isFinite(lo) || !Number.isFinite(qty)) continue;
        const rLo = Math.floor((lo - this.priceFloor) / this.cfg.tickSize);
        const rHi = Math.floor((hi - this.priceFloor) / this.cfg.tickSize);
        if (rLo > PRICE_ROWS - 1 || rHi < 0) continue;

        const firstSeen = z.firstSeenTimestamp
          ? z.firstSeenTimestamp > 1e11
            ? Math.floor(z.firstSeenTimestamp / 1000)
            : z.firstSeenTimestamp
          : null;

        for (let c = 0; c < HEATMAP_COLS; c++) {
          const colTime = bucket - (HEATMAP_COLS - 1 - c) * this.tfSeconds;
          const shouldPaint =
            firstSeen != null ? colTime >= firstSeen : c >= HEATMAP_COLS - 20;
          if (shouldPaint) {
            for (
              let r = Math.max(0, rLo);
              r <= Math.min(PRICE_ROWS - 1, rHi);
              r++
            ) {
              this.rawZGrid[r][c] = Math.max(this.rawZGrid[r][c], qty);
            }
          }
        }
      }
      full = true;
    } else {
      if (bucket !== this.lastHeatmapBucket) {
        const elapsed = Math.round(
          (bucket - this.lastHeatmapBucket) / this.tfSeconds,
        );
        if (elapsed > 0) {
          const shiftCount = Math.min(HEATMAP_COLS, elapsed);
          this.lastHeatmapBucket = bucket;
          // In-place left shift (no per-row slice/concat allocations).
          for (let r = 0; r < PRICE_ROWS; r++) {
            const row = this.rawZGrid[r];
            if (shiftCount >= HEATMAP_COLS) {
              row.fill(0);
            } else {
              row.copyWithin(0, shiftCount);
              row.fill(0, HEATMAP_COLS - shiftCount);
            }
          }
          full = true;
        } else {
          this.lastHeatmapBucket = bucket;
        }
      }

      for (let r = 0; r < PRICE_ROWS; r++) {
        if (this.rawZGrid[r][col] !== 0) {
          this.rawZGrid[r][col] = 0;
          colDirty = true;
        }
      }
      // Dense Bookmap gradient: paint every binned depth level into the live
      // column so the map reads continuously at any timeframe, not just the
      // handful of thresholded zones. Zones then highlight on top via max().
      if (this.paintDenseColumn(frame.heatmap_column, col)) {
        colDirty = true;
      }
      this.paintZones(zones, (r, qty) => {
        const v = Math.max(this.rawZGrid[r][col], qty);
        if (v !== this.rawZGrid[r][col]) {
          this.rawZGrid[r][col] = v;
          colDirty = true;
        }
      });
    }

    // Geometry: every setter fires notifyDataChanged(), which makes SciChart
    // re-normalise all 38,400 cells on the next render. Only write on change.
    const hd = this.heatmapData;
    const xStart = bucket - (HEATMAP_COLS - 1) * this.tfSeconds;
    if (hd.yStart !== this.priceFloor) hd.yStart = this.priceFloor;
    if (hd.yStep !== this.cfg.tickSize) hd.yStep = this.cfg.tickSize;
    if (hd.xStart !== xStart) hd.xStart = xStart;
    if (hd.xStep !== this.tfSeconds) hd.xStep = this.tfSeconds;

    if (!full && !colDirty) return;
    // Hidden layer: keep the raw grid advancing (cheap) but skip the display pass and
    // the GPU upload; applyLayerVisibility() catches up when it is shown again.
    if (!this.layers.heatmap) {
      this.heatmapStale = true;
      return;
    }
    if (full || this.heatmapStale) {
      this.heatmapStale = false;
      this.recalculateDisplayGrid();
    } else {
      // Live column only. Its fade factor is exactly 1 (t = 1), so display == raw.
      for (let r = 0; r < PRICE_ROWS; r++) this.displayZGrid[r][col] = this.rawZGrid[r][col];
    }
    hd.notifyDataChanged(EDataChangeType.Update);
  }

  /** Recompute display grid applying BookMap historical time-decay fade. */
  private recalculateDisplayGrid() {
    const maxCol = HEATMAP_COLS - 1;
    for (let c = 0; c < HEATMAP_COLS; c++) {
      let factor = 1.0;
      if (this.heatmapFadeEnabled && maxCol > 0) {
        const t = c / maxCol;
        factor =
          1 -
          this.heatmapFadeStrength +
          this.heatmapFadeStrength * Math.pow(t, 1.35);
      }
      for (let r = 0; r < PRICE_ROWS; r++) {
        this.displayZGrid[r][c] = this.rawZGrid[r][c] * factor;
      }
    }
  }

  /** Update BookMap heatmap time-decay fade settings. */
  setHeatmapFade(enabled: boolean, strength?: number) {
    this.heatmapFadeEnabled = enabled;
    if (strength !== undefined) {
      this.heatmapFadeStrength = Math.max(0, Math.min(1, strength));
    }
    if (this.heatmapInitialized) {
      this.recalculateDisplayGrid();
      this.heatmapData?.notifyDataChanged(EDataChangeType.Update);
    }
  }

  getHeatmapFade(): { enabled: boolean; strength: number } {
    return {
      enabled: this.heatmapFadeEnabled,
      strength: this.heatmapFadeStrength,
    };
  }

  /** Map resting-liquidity zones onto price rows and invoke a cell writer. */
  private paintZones(
    zones: NonNullable<ChartFrame["liquidity_zones"]>,
    write: (row: number, qty: number) => void,
  ) {
    for (const z of zones) {
      const lo = Number(z.priceLow);
      const hi = Number(z.priceHigh);
      const qty = Number(z.displayedQuantity);
      if (!Number.isFinite(lo) || !Number.isFinite(qty)) continue;
      const rLo = Math.floor((lo - this.priceFloor) / this.cfg.tickSize);
      const rHi = Math.floor((hi - this.priceFloor) / this.cfg.tickSize);
      if (rLo > PRICE_ROWS - 1 || rHi < 0) continue;
      for (let r = Math.max(0, rLo); r <= Math.min(PRICE_ROWS - 1, rHi); r++) {
        write(r, qty);
      }
    }
  }

  /** Paint the dense per-bin depth column from the bridge into one heatmap time
   *  column. Each bin maps to a price row via (priceMin + i*binSize). Returns
   *  true if any cell changed. This is the Bookmap continuous-gradient source;
   *  it fills every resting level rather than only the thresholded zones, which
   *  is what makes small timeframes read densely instead of sparse. */
  private paintDenseColumn(
    dense: ChartFrame["heatmap_column"],
    col: number,
  ): boolean {
    if (!dense || !dense.bins || dense.bins.length === 0) return false;
    const { priceMin, binSize, bins } = dense;
    if (!Number.isFinite(priceMin) || !(binSize > 0)) return false;
    let changed = false;
    for (let i = 0; i < bins.length; i++) {
      const qty = bins[i];
      if (!(qty > 0)) continue;
      const price = priceMin + i * binSize;
      const r = Math.floor((price - this.priceFloor) / this.cfg.tickSize);
      if (r < 0 || r > PRICE_ROWS - 1) continue;
      const v = Math.max(this.rawZGrid[r][col], qty);
      if (v !== this.rawZGrid[r][col]) {
        this.rawZGrid[r][col] = v;
        changed = true;
      }
    }
    return changed;
  }

  /** Pick the v7.4 timeframe frame matching the chart timeframe, falling back. */
  private pickV74Frame(frame: ChartFrame): TimeframeFrame | undefined {
    const frames = frame.v74?.frames;
    if (!frames) return undefined;
    return (
      (frames as Record<string, TimeframeFrame>)[this.cfg.timeframe] ||
      frames["5m"] ||
      frames["15m"]
    );
  }

  /** Render Liquidity Vacuum pockets + Magnet line — only when the signature changes. */
  private updateVacuum(frame: ChartFrame) {
    if (!this.layers.vacuum) {
      if (this.vacuumAnnotations.length) {
        for (const a of this.vacuumAnnotations)
          this.surface.annotations.remove(a);
        this.vacuumAnnotations = [];
      }
      this.vacuumSig = "__off__";
      return;
    }

    const vacFrame = this.pickV74Frame(frame);
    const structure = vacFrame?.structure;
    // Note: the engine only runs 5m/15m, so on a 1m chart these pockets come from the
    // 5m engine (sized by 5m ATR). No on-chart tag is shown, by user preference.
    const srcTf = (vacFrame as { tf?: string } | undefined)?.tf;
    const pockets = structure?.vacuum ?? [];
    const vacBand = structure?.vac_band ?? 0;
    const magnet =
      vacBand > 0
        ? structure?.vac_above
        : vacBand < 0
          ? structure?.vac_below
          : null;

    const sig =
      pockets
        .map((v) => `${v.strength}:${v.top}:${v.bottom}:${v.price}:${v.birth_time}`)
        .join("|") + `#${vacBand}:${magnet ?? ""}:${srcTf ?? ""}:${this.curBucket}`;
    if (sig === this.vacuumSig) return;
    this.vacuumSig = sig;

    for (const a of this.vacuumAnnotations) this.surface.annotations.remove(a);
    this.vacuumAnnotations = [];
    if (pockets.length === 0 && magnet == null) return;

    const strengthColor = (s: number) =>
      s === 3 ? "#FF5252" : s === 2 ? "#FFA726" : "#8B9BB4";

    // Pine: box.new(bar_index, top, bar_index + 10, bottom) at birth, right edge
    // trailed to bar_index + 10 on the last bar. Mirror that instead of a full-width band.
    const latestTime =
      this.curBucket ||
      (this.candleData.count() > 0
        ? this.candleData.getNativeXValues().get(this.candleData.count() - 1)
        : Math.floor(Date.now() / 1000));
    const rightEdge = latestTime + 10 * this.tfSeconds;

    for (const v of pockets) {
      const color = strengthColor(v.strength);
      const top = Math.max(v.top, v.bottom);
      const bot = Math.min(v.top, v.bottom);
      const birthSec =
        v.birth_time > 1e11 ? Math.floor(v.birth_time / 1000) : Math.floor(v.birth_time || 0);
      const leftEdge = birthSec > 0 && birthSec <= latestTime ? birthSec : latestTime;

      const box = new BoxAnnotation({
        x1: leftEdge,
        x2: rightEdge,
        xCoordinateMode: ECoordinateMode.DataValue,
        yCoordinateMode: ECoordinateMode.DataValue,
        y1: top,
        y2: bot,
        fill: color + "1a",
        stroke: color + "88",
        strokeThickness: 1,
        strokeDashArray: [4, 4],
      });
      this.surface.annotations.add(box);
      this.vacuumAnnotations.push(box);

      const label = new TextAnnotation({
        x1: rightEdge,
        xCoordinateMode: ECoordinateMode.DataValue,
        horizontalAnchorPoint: EHorizontalAnchorPoint.Left,
        y1: (top + bot) / 2,
        yCoordinateMode: ECoordinateMode.DataValue,
        verticalAnchorPoint: EVerticalAnchorPoint.Center,
        text: `🌀 ${v.price.toFixed(2)}`,
        textColor: color,
        fontSize: 10,
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: "bold",
      });
      this.surface.annotations.add(label);
      this.vacuumAnnotations.push(label);
    }

    if (magnet != null) {
      const line = new HorizontalLineAnnotation({
        y1: magnet,
        stroke: "#00E5FF",
        strokeThickness: 1.5,
        strokeDashArray: [6, 3],
        showLabel: true,
        labelPlacement: ELabelPlacement.TopRight,
        axisLabelFill: "#00E5FF",
        axisLabelStroke: "#000000",
        labelValue: `🧲 ${magnet.toFixed(2)}`,
      });
      this.surface.annotations.add(line);
      this.vacuumAnnotations.push(line);
    }
  }

  /** Render the Hopla 3 / 50 / 97 lines — only when the signature changes. */
  private updateHopla(frame: ChartFrame) {
    if (!this.layers.hopla) {
      if (this.hoplaAnnotations.length) {
        for (const a of this.hoplaAnnotations)
          this.surface.annotations.remove(a);
        this.hoplaAnnotations = [];
      }
      this.hoplaSig = "__off__";
      return;
    }

    const h = this.pickV74Frame(frame)?.structure?.hopla;
    const sig = h ? `${h.line_3}:${h.line_50}:${h.line_97}` : "";
    if (sig === this.hoplaSig) return;
    this.hoplaSig = sig;

    for (const a of this.hoplaAnnotations) this.surface.annotations.remove(a);
    this.hoplaAnnotations = [];
    if (!h) return;

    const mk = (
      price: number,
      color: string,
      label: string,
      dash: number[],
    ) => {
      const line = new HorizontalLineAnnotation({
        y1: price,
        stroke: color,
        strokeThickness: 1,
        strokeDashArray: dash,
        showLabel: true,
        labelPlacement: ELabelPlacement.TopRight,
        axisLabelFill: color,
        axisLabelStroke: "#000000",
        labelValue: label,
      });
      this.surface.annotations.add(line);
      this.hoplaAnnotations.push(line);
    };

    if (Number.isFinite(h.line_97))
      mk(h.line_97, "#ff3b30", `97% ${h.line_97.toFixed(2)}`, [4, 4]);
    if (Number.isFinite(h.line_50))
      mk(h.line_50, "#94a3b8", `EQ ${h.line_50.toFixed(2)}`, [1, 4]);
    if (Number.isFinite(h.line_3))
      mk(h.line_3, "#00b4d8", `3% ${h.line_3.toFixed(2)}`, [4, 4]);
  }

  /** Render prior-day/week high/low key levels — only when signature changes. */
  private updateKeyLevels(frame: ChartFrame) {
    const kl = frame.key_levels;
    const sig = kl ? `${kl.pdh}:${kl.pdl}:${kl.pwh}:${kl.pwl}` : "";
    if (sig === this.keyLevelsSig) return;
    this.keyLevelsSig = sig;

    for (const a of this.keyLevelAnnotations)
      this.surface.annotations.remove(a);
    this.keyLevelAnnotations = [];
    if (!kl) return;

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
  }

  /** Render liquidity sweep markers (liq_sweep events) — only when signature changes. */
  private updateSweeps(frame: ChartFrame) {
    const sweeps = frame.sweep_events || [];
    const sig = sweeps.map((s) => `${s.time}:${s.price}:${s.dir}`).join("|");
    if (sig === this.sweepsSig) return;
    this.sweepsSig = sig;

    for (const a of this.sweepAnnotations) this.surface.annotations.remove(a);
    this.sweepAnnotations = [];
    if (sweeps.length === 0) return;

    for (const s of sweeps.slice(-10)) {
      const tSec =
        s.time > 1e11 ? Math.floor(s.time / 1000) : Math.floor(s.time);
      const color = s.dir > 0 ? "#22c55e" : "#ef4444";
      const marker = new TextAnnotation({
        x1: tSec,
        y1: s.price,
        yCoordinateMode: ECoordinateMode.DataValue,
        text: "🎯",
        textColor: color,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: "bold",
        horizontalAnchorPoint: EHorizontalAnchorPoint.Center,
        verticalAnchorPoint:
          s.dir > 0 ? EVerticalAnchorPoint.Top : EVerticalAnchorPoint.Bottom,
      });
      this.surface.annotations.add(marker);
      this.sweepAnnotations.push(marker);
    }
  }

  /** Render v7.4 / v7.5 Institutional Signal Markers (▲ A+ / ▼ A+) & Active Trade Plan (ENTRY/SL/TP1/TP2). */
  private updateSignals(frame: ChartFrame) {
    const tfFrame = this.pickV74Frame(frame);
    const sigs = (tfFrame?.signals || []).filter(
      (s) => s.tier === "A_PLUS" || s.tier === "STRUCTURAL",
    );
    const active = tfFrame?.active_signal || null;

    const sig =
      sigs
        .slice(-16)
        .map(
          (s) => `${s.id}:${s.status}:${s.outcome ?? ""}:${s.win_rate ?? ""}`,
        )
        .join("|") +
      `#active:${active ? `${active.id}:${active.plan.entry}:${active.plan.stop}:${active.plan.tp1}:${active.plan.tp2}` : "none"}`;
    if (sig === this.signalsSig) return;
    this.signalsSig = sig;

    for (const a of this.signalAnnotations) this.surface.annotations.remove(a);
    this.signalAnnotations = [];
    if (sigs.length === 0 && !active) return;

    for (const s of sigs.slice(-16)) {
      if (s.entry == null || !Number.isFinite(s.entry)) continue;
      const tSec =
        s.time > 1e11 ? Math.floor(s.time / 1000) : Math.floor(s.time);
      const isLong = s.direction === "LONG";
      const isAPlus = s.tier === "A_PLUS";
      const color = isLong
        ? isAPlus
          ? "#10b981"
          : "#34d399"
        : isAPlus
          ? "#f43f5e"
          : "#fb7185";
      const winPct =
        s.win_rate != null ? ` ${Math.round(s.win_rate * 100)}%` : "";
      const tierBadge = isAPlus ? "A+" : "S";
      const marker = new TextAnnotation({
        x1: tSec,
        y1: s.entry,
        yCoordinateMode: ECoordinateMode.DataValue,
        text: `${isLong ? "▲" : "▼"} ${tierBadge}${winPct}`,
        textColor: color,
        fontSize: isAPlus ? 10 : 9,
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: "bold",
        horizontalAnchorPoint: EHorizontalAnchorPoint.Center,
        verticalAnchorPoint: isLong
          ? EVerticalAnchorPoint.Top
          : EVerticalAnchorPoint.Bottom,
      });
      this.surface.annotations.add(marker);
      this.signalAnnotations.push(marker);
    }

    if (active && active.plan) {
      const mkLevel = (
        price: number | undefined,
        color: string,
        label: string,
        dash: number[],
      ) => {
        if (price == null || !Number.isFinite(price)) return;
        const line = new HorizontalLineAnnotation({
          y1: price,
          stroke: color,
          strokeThickness: 1.25,
          strokeDashArray: dash,
          showLabel: true,
          labelPlacement: ELabelPlacement.TopLeft,
          axisLabelFill: color,
          axisLabelStroke: "#000000",
          labelValue: `${label} ${price.toFixed(2)}`,
        });
        this.surface.annotations.add(line);
        this.signalAnnotations.push(line);
      };
      mkLevel(
        active.plan.entry,
        "#38bdf8",
        `${active.direction} ENTRY`,
        [2, 2],
      );
      mkLevel(active.plan.stop, "#ef4444", "SL", [4, 4]);
      mkLevel(active.plan.tp1, "#10b981", "TP1", [4, 4]);
      mkLevel(active.plan.tp2, "#059669", "TP2", [6, 3]);
    }
  }

  /** Bubble Regime markers: OI + liquidation classified aggressive sweeps from
   *  the BubbleRegimeEngine. */
  private updateBubbleRegimes(frame: ChartFrame) {
    if (!this.surface) return;

    const all = frame.bubbles || [];
    const notable = all.filter((b) => b.regime !== "standard_flow");
    const sig = notable
      .slice(-8)
      .map((b) => `${b.timestamp}:${b.regime}:${b.priceCenter}`)
      .join("|");
    if (sig === this.bubblesSig) return;
    this.bubblesSig = sig;

    for (const a of this.bubbleRegimeAnnotations)
      this.surface.annotations.remove(a);
    this.bubbleRegimeAnnotations = [];

    // Regime absorption is NOT drawn as a glyph: it upgrades the per-candle absorption
    // marker to the "battle" tier. Applied to the model even while the layer is hidden.
    for (const b of notable) {
      if (b.regime !== "institutional_absorption_open") continue;
      const p0 = typeof b.priceCenter === "string" ? parseFloat(b.priceCenter) : b.priceCenter;
      if (!Number.isFinite(p0)) continue;
      const tSec0 = b.timestamp > 1e11 ? Math.floor(b.timestamp / 1000) : Math.floor(b.timestamp);
      const g = this.absorbGroup(b.aggressorSide === "buy" ? "buy" : "sell", tSec0);
      if (!g.battle) {
        g.battle = true;
        g.battlePx = p0;
        this.absorbDirty = true;
      }
    }
    if (!this.layers.bubbles || notable.length === 0) return;

    // Single-glyph markers, no text.
    const META: Record<string, { glyph: string; color: string }> = {
      liquidation_exhaustion_flush: { glyph: "💥", color: "#f43f5e" },
      vacuum_sweep_breakout: { glyph: "⚡", color: "#f59e0b" },
    };

    for (const b of notable.slice(-8)) {
      const tSec0 =
        b.timestamp > 1e11 ? Math.floor(b.timestamp / 1000) : Math.floor(b.timestamp);
      const meta = META[b.regime];
      if (!meta) continue;
      const tSec = tSec0;
      const price =
        typeof b.priceCenter === "string"
          ? parseFloat(b.priceCenter)
          : b.priceCenter;
      if (!Number.isFinite(price)) continue;
      const isBuy = b.aggressorSide === "buy";
      const marker = new TextAnnotation({
        x1: tSec,
        y1: price,
        yCoordinateMode: ECoordinateMode.DataValue,
        text: meta.glyph,
        textColor: meta.color,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: "bold",
        horizontalAnchorPoint: EHorizontalAnchorPoint.Center,
        verticalAnchorPoint: isBuy
          ? EVerticalAnchorPoint.Top
          : EVerticalAnchorPoint.Bottom,
      });
      this.surface.annotations.add(marker);
      this.bubbleRegimeAnnotations.push(marker);
    }
  }

  private updateMarkPrice(midPrice: number) {
    if (!this.markPriceAnnotation) {
      this.markPriceAnnotation = new HorizontalLineAnnotation({
        y1: midPrice,
        stroke: "#f59e0b",
        strokeThickness: 1,
        strokeDashArray: [4, 4],
        showLabel: true,
        labelValue: `MARK ${midPrice.toFixed(2)}`,
        labelPlacement: ELabelPlacement.Axis,
        axisLabelFill: "#f59e0b",
        axisLabelStroke: "#000000",
      });
      this.surface.annotations.add(this.markPriceAnnotation);
    } else {
      this.markPriceAnnotation.y1 = midPrice;
      this.markPriceAnnotation.labelValue = `MARK ${midPrice.toFixed(2)}`;
    }
  }

  /**
   * Click-to-inspect hit test against the marker under the pointer. Uses the pointer
   * position recorded by PointerTrackerModifier (SciChart's DPI-scaled series-view
   * space), so it matches what is drawn on Retina displays too. `tolerancePx` is in
   * CSS pixels.
   */
  hitTestBubble(tolerancePx = 16): BubbleHit | null {
    const p = this.pointer?.point;
    if (!this.surface || !p || this.absorbGroups.size === 0 || !this.layers.bubbles) return null;
    const dpr = window.devicePixelRatio || 1;
    const xCalc = this.xAxis.getCurrentCoordinateCalculator();
    const yCalc = this.yAxis.getCurrentCoordinateCalculator();
    let best: BubbleHit | null = null;
    let bestDist = tolerancePx * dpr;
    for (const g of this.absorbGroups.values()) {
      const y = groupPrice(g);
      if (y == null) continue;
      const d = Math.hypot(xCalc.getCoordinate(g.bar) - p.x, yCalc.getCoordinate(y) - p.y);
      if (d < bestDist) {
        bestDist = d;
        best = { x: g.bar, y, side: g.side, point: g.detector };
      }
    }
    return best;
  }

  /** Reset the cached live-view range so the next applyLiveView() always writes. */
  private invalidateView() {
    this.lastViewFirstX = NaN;
    this.lastViewLastX = NaN;
    this.lastViewPad = NaN;
    this.lastViewWidth = NaN;
    this.lastViewLo = NaN;
    this.lastViewHi = NaN;
  }

  /** Snap the view to the latest VISIBLE_CANDLES and fit price to visible highs/lows. */
  applyLiveView() {
    const n = this.candleData.count();
    if (n === 0) return;
    const xVals = this.candleData.getNativeXValues();
    const lastX = xVals.get(n - 1);
    const firstIdx = Math.max(0, n - VISIBLE_CANDLES);
    const firstX = xVals.get(firstIdx);

    const candleSpan = Math.max(lastX - firstX, this.tfSeconds);
    let pad = this.tfSeconds * 4;
    const plotWidthPx = this.surface?.seriesViewRect?.width ?? 0;
    const minSafePlot = RIGHT_OFFSET_PX + 120;
    if (plotWidthPx > minSafePlot) {
      const computedPad =
        (candleSpan * RIGHT_OFFSET_PX) / (plotWidthPx - RIGHT_OFFSET_PX);
      pad = Math.min(computedPad, candleSpan * 1.5);
    }

    const highs = this.candleData.getNativeHighValues();
    const lows = this.candleData.getNativeLowValues();
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = firstIdx; i < n; i++) {
      const h = highs.get(i);
      const l = lows.get(i);
      if (Number.isFinite(h) && h > hi) hi = h;
      if (Number.isFinite(l) && l < lo) lo = l;
    }

    const widthChanged = Math.abs(plotWidthPx - this.lastViewWidth) > 8;
    const padChanged = Math.abs(pad - this.lastViewPad) > this.tfSeconds * 0.5;
    const xChanged =
      firstX !== this.lastViewFirstX ||
      lastX !== this.lastViewLastX ||
      widthChanged ||
      padChanged;
    const yOk = Number.isFinite(hi) && Number.isFinite(lo) && hi > lo;
    const yChanged = yOk && (lo !== this.lastViewLo || hi !== this.lastViewHi);

    if (!xChanged && !yChanged) return;

    this.suppressRangeEvents = true;
    if (xChanged) {
      this.xAxis.visibleRange = new NumberRange(firstX, lastX + pad);
      this.lastViewFirstX = firstX;
      this.lastViewLastX = lastX;
      this.lastViewPad = pad;
      this.lastViewWidth = plotWidthPx;
    }
    if (yChanged) {
      const padY = (hi - lo) * 0.12;
      this.yAxis.visibleRange = new NumberRange(lo - padY, hi + padY);
      this.lastViewLo = lo;
      this.lastViewHi = hi;
    }
    this.suppressRangeEvents = false;
  }

  /** Re-enable live follow (used by the "Live" button / double-click reset). */
  resetView() {
    this.liveFollow = true;
    this.invalidateView();
    this.applyLiveView();
  }

  /** Release every WebGL buffer, texture, annotation and listener. */
  delete() {
    for (const a of this.hoplaAnnotations) this.surface?.annotations.remove(a);
    this.hoplaAnnotations = [];
    for (const a of this.vacuumAnnotations) this.surface?.annotations.remove(a);
    this.vacuumAnnotations = [];
    for (const a of this.keyLevelAnnotations)
      this.surface?.annotations.remove(a);
    this.keyLevelAnnotations = [];
    for (const a of this.sweepAnnotations) this.surface?.annotations.remove(a);
    this.sweepAnnotations = [];
    for (const a of this.signalAnnotations) this.surface?.annotations.remove(a);
    this.signalAnnotations = [];
    for (const a of this.bubbleRegimeAnnotations)
      this.surface?.annotations.remove(a);
    this.bubbleRegimeAnnotations = [];
    this.absorbGroups.clear();
    if (this.pointer) this.pointer.onMove = null;
    if (this.markPriceAnnotation) {
      this.surface?.annotations.remove(this.markPriceAnnotation);
      this.markPriceAnnotation = null;
    }
    this.surface?.delete();
    this.lastFrame = null;
  }
}
