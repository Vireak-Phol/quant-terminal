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
  CustomAnnotation,
  HorizontalLineAnnotation,
  TextAnnotation,
  ELabelPlacement,
  ZoomPanModifier,
  MouseWheelZoomModifier,
  ZoomExtentsModifier,
  EDataPointWidthMode,
  ECoordinateMode,
  EHorizontalAnchorPoint,
  EVerticalAnchorPoint,
  EFillPaletteMode,
  EStrokePaletteMode,
  EValueName,
  parseColorToUIntArgb,
} from "scichart";
import type {
  IFillPaletteProvider,
  IStrokePaletteProvider,
  IRenderableSeries,
} from "scichart";
import type { CandleData } from "../lib/klines";
import {
  detectHeavyAbsorptions,
  type HeavyAbsorptionPoint,
} from "../lib/absorption";
import type { V74Frame, TimeframeFrame } from "../types/v74";

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
  point: HeavyAbsorptionPoint | null; // null for live-tape footprints
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

// Absorption bubbles are fixed-size markers (reverted from volume/zoom scaling):
// every bubble is drawn at a constant pixel radius, matching the original
// EllipsePointMarker look. `priceRadius` is retained on the annotation for
// possible future use but is NOT used for sizing.
const BUBBLE_RADIUS_PX = 12; // on-screen radius (24px diameter, original size)

/**
 * A round absorption bubble. Positioned at a (time, price) point and rendered at
 * a constant pixel radius so its on-screen size is stable regardless of volume
 * or zoom (matches the original fixed-size scatter marker).
 */
class VolumeBubbleAnnotation extends CustomAnnotation {
  priceRadius: number;
  fillColor: string;
  strokeColor: string;
  label: string;

  constructor(opts: {
    time: number;
    price: number;
    priceRadius: number;
    fill: string;
    stroke: string;
    label: string;
  }) {
    super({
      x1: opts.time,
      y1: opts.price,
      xCoordinateMode: ECoordinateMode.DataValue,
      yCoordinateMode: ECoordinateMode.DataValue,
      horizontalAnchorPoint: EHorizontalAnchorPoint.Center,
    });
    this.priceRadius = opts.priceRadius;
    this.fillColor = opts.fill;
    this.strokeColor = opts.stroke;
    this.label = opts.label;
  }

  getSvgString(annotation: CustomAnnotation): string {
    const self = annotation as VolumeBubbleAnnotation;
    const rPx = BUBBLE_RADIUS_PX;
    const d = rPx * 2 + 4; // svg box with a little padding for the stroke
    const c = d / 2;
    const text = self.label
      ? `<text x="${c}" y="${c}" fill="#ffffff" font-family="monospace" font-size="9" ` +
        `text-anchor="middle" dominant-baseline="central">${self.label}</text>`
      : "";
    return (
      `<svg width="${d}" height="${d}" viewBox="0 0 ${d} ${d}" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="${c}" cy="${c}" r="${rPx}" fill="${self.fillColor}" ` +
      `stroke="${self.strokeColor}" stroke-width="1.5" />` +
      text +
      `</svg>`
    );
  }
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
const DELTA_UP_COLOR = "#26a69a"; // buyers in control
const DELTA_DOWN_COLOR = "#ef5350"; // sellers in control

class DeltaPaletteProvider
  implements IFillPaletteProvider, IStrokePaletteProvider
{
  readonly fillPaletteMode = EFillPaletteMode.SOLID;
  readonly strokePaletteMode = EStrokePaletteMode.SOLID;
  readonly isRangeIndependant = true;

  /** Delta per candle, index-aligned with the OhlcDataSeries. */
  private deltas: number[];
  /** When false, overrides are disabled and the series uses its default coloring. */
  enabled = false;
  /** |delta| <= deadband is treated as neutral (use close-vs-open fallback). */
  private readonly deadband: number;

  private readonly upArgb = parseColorToUIntArgb(DELTA_UP_COLOR);
  private readonly downArgb = parseColorToUIntArgb(DELTA_DOWN_COLOR);
  /** Low-delta body color (bars with weak imbalance fade toward this). */
  private readonly dimArgb = parseColorToUIntArgb("#2a2e39");

  constructor(deltas: number[], deadband = 0) {
    this.deltas = deltas;
    this.deadband = deadband;
  }

  /** Swap the backing array (e.g. after a timeframe reset reallocates it). */
  setDeltas(deltas: number[]) {
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
        if (Number.isFinite(d) && d !== 0) {
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
    if (d === undefined || !Number.isFinite(d) || Math.abs(d) <= this.deadband || this.meanAbs <= 0) {
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
  private candleDelta: number[] = [];
  private deltaPalette!: DeltaPaletteProvider;

  private heatmapData!: UniformHeatmapDataSeries;
  private heatmapSeries!: UniformHeatmapRenderableSeries;

  // Absorption bubbles are DeepChart-style: drawn in price (data) units so they
  // scale with the chart zoom, with radius proportional to volume. Each bubble
  // is a VolumeBubbleAnnotation; we keep them in one list for lifecycle mgmt.
  private bubbleAnnotations: VolumeBubbleAnnotation[] = [];

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

  // Recorded bubble positions for click-to-inspect hit-testing.
  private bubbleHits: BubbleHit[] = [];

  // Heatmap rolling grids [PRICE_ROWS][HEATMAP_COLS] (ring-buffered on the X axis).
  private rawZGrid: number[][] = [];
  private displayZGrid: number[][] = [];
  private heatmapFadeEnabled = false;
  private heatmapFadeStrength = 0.7;
  private priceFloor = 0;
  private lastHeatmapBucket = 0;
  private heatmapInitialized = false;

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
  // Live ABS episodes merged per (side, candle) — see appendLiveFootprints.
  private liveAbsGroups = new Map<
    string,
    { bubble: VolumeBubbleAnnotation; hit: BubbleHit; count: number; pxQty: number; qty: number }
  >();
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
      axisTitle: "Time",
      drawMajorGridLines: true,
      labelProvider: new SmartDateLabelProvider(),
      autoRange: EAutoRange.Never,
    });
    this.yAxis = new NumericAxis(wasmContext, {
      axisTitle: "Price (USDT)",
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
      zValues: this.displayZGrid.map((row) => [...row]),
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
    this.candleData = new OhlcDataSeries(wasmContext);
    this.deltaPalette = new DeltaPaletteProvider(this.candleDelta);
    this.deltaPalette.enabled = this.layers.delta;
    this.candlestickSeries = new FastCandlestickRenderableSeries(wasmContext, {
      dataSeries: this.candleData,
      strokeThickness: 1,
      brushUp: "#26a69a",
      brushDown: "#ef5350",
      strokeUp: "#26a69a",
      strokeDown: "#ef5350",
      dataPointWidth: 0.7,
      dataPointWidthMode: EDataPointWidthMode.Relative,
      paletteProvider: this.deltaPalette,
    });
    this.surface.renderableSeries.add(this.candlestickSeries);

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
    if (this.heatmapSeries) this.heatmapSeries.isVisible = this.layers.heatmap;
    for (const b of this.bubbleAnnotations) b.isHidden = !this.layers.bubbles;
    for (const m of this.bubbleRegimeAnnotations)
      m.isHidden = !this.layers.bubbles;
    if (this.deltaPalette) {
      this.deltaPalette.enabled = this.layers.delta;
      // Force the candlestick series to repaint with/without the delta override.
      this.surface?.invalidateElement({ force: true });
    }
  }

  /** Load historical candles from Binance to seed price action + absorption history. */
  loadHistoricalCandles(candles: CandleData[]) {
    if (!this.surface || candles.length === 0) return;
    this.historicalCandles = [...candles];
    this.candleData.clear();
    this.candleDelta.length = 0;
    for (const c of candles) {
      this.candleData.append(c.time, c.open, c.high, c.low, c.close);
      // Real aggressor delta from REST taker-buy volume (0 if the field is absent).
      this.candleDelta.push(c.delta ?? 0);
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
    this.bubbleHits = [];
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
    this.clearBubbles();
    for (let r = 0; r < PRICE_ROWS; r++) {
      this.rawZGrid[r].fill(0);
      this.displayZGrid[r].fill(0);
    }
    this.liveFollow = true;
    this.invalidateView();
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
   * Full rebuild of the Heavy Absorption bubbles from the candle history.
   */
  private rebuildHeavyAbsorptions() {
    if (!this.surface) return;
    this.clearBubbles();
    this.seenFootprintIds.clear();

    const points = detectHeavyAbsorptions(this.historicalCandles);
    for (const pt of points) {
      this.addBubble(
        pt.type === "buyers_absorbed" ? "buy" : "sell",
        pt.volRatio,
        pt.time,
        pt.price,
        `${pt.volRatio}`,
      );
      this.bubbleHits.push({ x: pt.time, y: pt.price, point: pt });
    }
  }

  /** Create a fixed-size absorption bubble annotation (size no longer scales). */
  private addBubble(
    side: "buy" | "sell",
    _volRatio: number,
    time: number,
    price: number,
    label: string,
  ) {
    const fill =
      side === "buy" ? "rgba(239, 68, 68, 0.40)" : "rgba(16, 185, 129, 0.40)";
    const stroke =
      side === "buy" ? "rgba(248, 113, 113, 0.95)" : "rgba(52, 211, 153, 0.95)";
    const bubble = new VolumeBubbleAnnotation({
      time,
      price,
      priceRadius: 0,
      fill,
      stroke,
      label,
    });
    bubble.isHidden = !this.layers.bubbles;
    this.surface.annotations.add(bubble);
    this.bubbleAnnotations.push(bubble);
    return bubble;
  }

  /** Remove all bubble annotations from the surface and reset hit records. */
  private clearBubbles() {
    for (const b of this.bubbleAnnotations) this.surface?.annotations.remove(b);
    this.bubbleAnnotations = [];
    this.bubbleHits = [];
    this.liveAbsGroups.clear();
  }

  /**
   * Incrementally append live order-flow absorption footprints, merged to ONE
   * bubble per (candle, side).
   *
   * The bridge re-evaluates its rolling absorption window on every trade and keys
   * each hit by (2-second bucket, avg price in cents). One sustained absorption
   * episode therefore emits many near-identical candidates a few cents apart, which
   * used to stack as overlapping "ABS" bubbles on the same candle. They are the
   * same event, so we merge them: the bubble sits at the volume-weighted price of
   * the episode and the label shows how many re-detections confirmed it ("A×n").
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
      const bar = Math.floor(t / this.tfSeconds) * this.tfSeconds;
      const key = `${side}-${bar}`;
      const qty = Math.max(Number(a.executedQuantity ?? 0) || 0, 1e-9);
      const g = this.liveAbsGroups.get(key);
      if (g) {
        g.count += 1;
        g.pxQty += px * qty;
        g.qty += qty;
        // Replace the existing bubble with the updated merged one.
        this.surface.annotations.remove(g.bubble);
        this.bubbleAnnotations = this.bubbleAnnotations.filter((b) => b !== g.bubble);
        g.hit.y = g.pxQty / g.qty;
        g.bubble = this.addBubble(side, 0, bar, g.hit.y, `A×${Math.min(g.count, 99)}`);
      } else {
        const hit: BubbleHit = { x: bar, y: px, point: null };
        this.bubbleHits.push(hit);
        const bubble = this.addBubble(side, 0, bar, px, "ABS");
        this.liveAbsGroups.set(key, { bubble, hit, count: 1, pxQty: px * qty, qty });
      }
    }
    if (this.seenFootprintIds.size > 2000) {
      const recent = Array.from(this.seenFootprintIds).slice(-500);
      this.seenFootprintIds = new Set(recent);
    }
  }

  private updateHeatmap(frame: ChartFrame, nowSec: number) {
    const mid = frame.mid_price;
    const span = PRICE_ROWS * this.cfg.tickSize;
    let dirty = false;

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
      dirty = true;
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
      this.recalculateDisplayGrid();
      dirty = true;
    } else {
      if (bucket !== this.lastHeatmapBucket) {
        const elapsed = Math.round(
          (bucket - this.lastHeatmapBucket) / this.tfSeconds,
        );
        if (elapsed > 0) {
          const shiftCount = Math.min(HEATMAP_COLS, elapsed);
          this.lastHeatmapBucket = bucket;
          for (let r = 0; r < PRICE_ROWS; r++) {
            if (shiftCount >= HEATMAP_COLS) {
              this.rawZGrid[r].fill(0);
            } else {
              this.rawZGrid[r] = this.rawZGrid[r]
                .slice(shiftCount)
                .concat(new Array(shiftCount).fill(0));
            }
          }
          dirty = true;
        } else {
          this.lastHeatmapBucket = bucket;
        }
      }

      for (let r = 0; r < PRICE_ROWS; r++) {
        if (this.rawZGrid[r][col] !== 0) {
          this.rawZGrid[r][col] = 0;
          dirty = true;
        }
      }
      // Dense Bookmap gradient: paint every binned depth level into the live
      // column so the map reads continuously at any timeframe, not just the
      // handful of thresholded zones. Zones then highlight on top via max().
      if (this.paintDenseColumn(frame.heatmap_column, col)) {
        dirty = true;
      }
      this.paintZones(zones, (r, qty) => {
        const v = Math.max(this.rawZGrid[r][col], qty);
        if (v !== this.rawZGrid[r][col]) {
          this.rawZGrid[r][col] = v;
          dirty = true;
        }
      });
      if (dirty) {
        this.recalculateDisplayGrid();
      }
    }

    if (dirty) {
      this.heatmapData.setZValues(this.displayZGrid);
    }
    this.heatmapData.yStart = this.priceFloor;
    this.heatmapData.yStep = this.cfg.tickSize;
    this.heatmapData.xStart = bucket - (HEATMAP_COLS - 1) * this.tfSeconds;
    this.heatmapData.xStep = this.tfSeconds;
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
      this.heatmapData?.setZValues(this.displayZGrid);
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
    // The engine only runs 5m/15m. On a 1m chart the pockets come from the 5m engine
    // (sized by 5m ATR, ~3x a 1m ATR), so tag them to avoid comparing against a 1m
    // TradingView chart.
    const srcTf = (vacFrame as { tf?: string } | undefined)?.tf;
    const tfTag = srcTf && srcTf !== this.cfg.timeframe ? ` [${srcTf}]` : "";
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
        text: `VAC${v.strength} ${v.price.toFixed(2)}${tfTag}`,
        textColor: color,
        fontSize: 10,
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: "bold",
      });
      this.surface.annotations.add(label);
      this.vacuumAnnotations.push(label);
    }

    if (magnet != null) {
      const dir = vacBand > 0 ? "↑" : "↓";
      const line = new HorizontalLineAnnotation({
        y1: magnet,
        stroke: "#00E5FF",
        strokeThickness: 1.5,
        strokeDashArray: [6, 3],
        showLabel: true,
        labelPlacement: ELabelPlacement.TopRight,
        axisLabelFill: "#00E5FF",
        axisLabelStroke: "#000000",
        labelValue: `MAGNET ${dir} ${magnet.toFixed(2)}${tfTag}`,
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
        text: s.dir > 0 ? "▲ SWEEP" : "▼ SWEEP",
        textColor: color,
        fontSize: 9,
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
    if (!this.layers.bubbles || notable.length === 0) return;

    const META: Record<string, { glyph: string; color: string }> = {
      institutional_absorption_open: { glyph: "🧱 ABSORB", color: "#22d3ee" },
      liquidation_exhaustion_flush: { glyph: "💥 LIQ", color: "#f43f5e" },
      vacuum_sweep_breakout: { glyph: "🚀 SWEEP", color: "#f59e0b" },
    };

    for (const b of notable.slice(-8)) {
      const meta = META[b.regime];
      if (!meta) continue;
      const tSec =
        b.timestamp > 1e11
          ? Math.floor(b.timestamp / 1000)
          : Math.floor(b.timestamp);
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
        text: `${isBuy ? "▲" : "▼"} ${meta.glyph}`,
        textColor: meta.color,
        fontSize: 9,
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
   * Click-to-inspect hit test.
   */
  hitTestBubble(
    clientX: number,
    clientY: number,
    tolerancePx = 16,
  ): BubbleHit | null {
    if (!this.surface || this.bubbleHits.length === 0 || !this.layers.bubbles)
      return null;
    const rect = this.surface.domCanvasWebGL?.getBoundingClientRect?.();
    if (!rect) return null;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const xCalc = this.xAxis.getCurrentCoordinateCalculator();
    const yCalc = this.yAxis.getCurrentCoordinateCalculator();
    let best: BubbleHit | null = null;
    let bestDist = tolerancePx;
    for (const hit of this.bubbleHits) {
      const hx = xCalc.getCoordinate(hit.x);
      const hy = yCalc.getCoordinate(hit.y);
      const d = Math.hypot(hx - px, hy - py);
      if (d < bestDist) {
        bestDist = d;
        best = hit;
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
    for (const b of this.bubbleAnnotations) this.surface?.annotations.remove(b);
    this.bubbleAnnotations = [];
    if (this.markPriceAnnotation) {
      this.surface?.annotations.remove(this.markPriceAnnotation);
      this.markPriceAnnotation = null;
    }
    this.surface?.delete();
    this.bubbleHits = [];
    this.lastFrame = null;
  }
}
