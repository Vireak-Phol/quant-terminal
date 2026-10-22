/// SciChart controller (a.k.a. SciChartDeepEngine): owns the surface, axes,
/// candlestick series, and the institutional overlays:
///   1. Bookmap Liquidity Heatmap  (UniformHeatmapDataSeries)
///   2. Price Candlesticks          (FastCandlestickRenderableSeries)
///   3. Heavy Absorption Bubbles    (data-scaled CustomAnnotation circles)
///   4. Liquidity Vacuum Pockets    (v7.4 Pine Strategy structure; BoxAnnotations)
///   5. Vacuum Magnet Line          (HorizontalLineAnnotation + axis badge)
///   6. Hopla 3 / 50 / 97 range     (HorizontalLineAnnotation)
///   7. Mark Price Line on Axis     (HorizontalLineAnnotation with amber badge)
///
/// Every overlay group is independently toggleable via setLayerVisibility() and
/// every resource is released in delete() so React unmounts leave no WebGL leaks.
///
/// PERFORMANCE CONTRACT: update() is designed to be called at display refresh
/// (the cockpit coalesces websocket frames with requestAnimationFrame). Within a
/// frame it does the minimum work: candle O/H/L/C in place, heatmap pushed to the
/// GPU only when the grid changed, absorption bubbles rebuilt only on a new closed
/// candle (live footprints appended incrementally), and vacuum/hopla annotations
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
} from "scichart";
import type { CandleData } from "../lib/klines";
import { detectHeavyAbsorptions, type HeavyAbsorptionPoint } from "../lib/absorption";
import type { V74Frame, TimeframeFrame } from "../types/v74";

export type Timeframe = "1m" | "5m" | "15m";

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
};

/** Overlay groups the UI can switch on/off. */
export type ChartLayer = "heatmap" | "bubbles" | "vacuum" | "hopla";

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

// How often (ms) the Heavy Absorption detector may re-run against the FORMING
// (not-yet-closed) candle so a developing absorption appears in near real-time.
// A full sweep is O(history); bubbles rebuild only on a closed candle.

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

export class TerminalChart {
  private surface!: SciChartSurface;
  private cfg: ChartConfig;
  private tfSeconds: number;

  private xAxis!: DateTimeNumericAxis;
  private yAxis!: NumericAxis;

  private candleData!: OhlcDataSeries;
  private candlestickSeries!: FastCandlestickRenderableSeries;

  private heatmapData!: UniformHeatmapDataSeries;
  private heatmapSeries!: UniformHeatmapRenderableSeries;

  // Absorption bubbles are DeepChart-style: drawn in price (data) units so they
  // scale with the chart zoom, with radius proportional to volume. Each bubble
  // is a VolumeBubbleAnnotation; we keep them in one list for lifecycle mgmt.
  private bubbleAnnotations: VolumeBubbleAnnotation[] = [];

  private vacuumAnnotations: (BoxAnnotation | HorizontalLineAnnotation | TextAnnotation)[] = [];
  private hoplaAnnotations: HorizontalLineAnnotation[] = [];
  private markPriceAnnotation: HorizontalLineAnnotation | null = null;
  // --- Audit R3: key levels + sweep markers ---
  private keyLevelAnnotations: HorizontalLineAnnotation[] = [];
  private sweepAnnotations: (BoxAnnotation | TextAnnotation)[] = [];
  private bubbleRegimeAnnotations: TextAnnotation[] = [];
  private keyLevelsSig = "";
  private sweepsSig = "";
  private bubblesSig = "";

  // Candle history storage for the rolling absorption detector.
  private historicalCandles: CandleData[] = [];

  // Recorded bubble positions for click-to-inspect hit-testing.
  private bubbleHits: BubbleHit[] = [];

  // Heatmap rolling grids [PRICE_ROWS][HEATMAP_COLS] (ring-buffered on the X axis).
  // rawZGrid holds resting quantities; displayZGrid is what the GPU sees. The
  // BookMap time-decay fade is DISABLED by default (restored flat look) — when
  // off, displayZGrid simply mirrors rawZGrid. The fade machinery is retained so
  // it can be re-enabled via setHeatmapFade() without a code change.
  private rawZGrid: number[][] = [];
  private displayZGrid: number[][] = [];
  private heatmapFadeEnabled = false;
  private heatmapFadeStrength = 0.70;
  private priceFloor = 0;
  private lastHeatmapBucket = 0;
  private heatmapInitialized = false;

  // Candle aggregation state (bucketStartSec -> ohlc).
  private curBucket = 0;
  private curOhlc: { o: number; h: number; l: number; c: number } | null = null;
  // Running max trade-volume accumulated into the CURRENT bucket. The trade_candle
  // is a 60s rolling aggregate whose `v` is monotonically increasing within its
  // minute and resets at each minute boundary; we take the per-frame max so the
  // closing bucket's FINAL volume is captured on the rollover frame (which the
  // same-bucket `else` branch never runs on). Without this, the just-closed
  // candle keeps a stale/partial volume and the Heavy Absorption detector drops
  // the newest bubble — which is why it only appeared after a browser reload
  // (reload re-seeds true volumes from Binance klines).
  private curBucketMaxVol = 0;

  // Live-follow control.
  private liveFollow = true;
  private suppressRangeEvents = false;

  // Layer visibility state (driven by the cockpit header).
  private layers: Record<ChartLayer, boolean> = {
    heatmap: true,
    bubbles: true,
    vacuum: true,
    hopla: true,
  };

  // Last frame kept so toggles can re-render overlays without a new tick.
  private lastFrame: ChartFrame | null = null;

  // --- Perf: signature caches so overlays only rebuild when data changes ---
  private vacuumSig = "";
  private hoplaSig = "";
  // Live-tape footprint dedup so identical carried-forward candidates are not
  // re-appended; bounded so a long session cannot grow it without limit.
  private seenFootprintIds = new Set<string>();
  // Throttle for re-running the Heavy Absorption detector on the FORMING candle
  // so a developing absorption surfaces in near real-time instead of only when
  // the bar finally closes. Full detector sweeps are O(history) and now run only
  // on a closed candle.
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
    const { sciChartSurface, wasmContext } = await SciChartSurface.create(rootElement, {
      theme: new SciChartJsNavyTheme(),
    });
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
    this.candlestickSeries = new FastCandlestickRenderableSeries(wasmContext, {
      dataSeries: this.candleData,
      strokeThickness: 1,
      brushUp: "#26a69a",
      brushDown: "#ef5350",
      strokeUp: "#26a69a",
      strokeDown: "#ef5350",
      dataPointWidth: 0.7,
      dataPointWidthMode: EDataPointWidthMode.Relative,
    });
    this.surface.renderableSeries.add(this.candlestickSeries);

    // --- Absorption Bubbles (Heavy Absorption Indicator, DeepChart-style) ---
    // Bubbles are drawn as VolumeBubbleAnnotations in price units (so they scale
    // with zoom); they are created on demand in rebuildHeavyAbsorptions() and
    // appendLiveFootprints(). Buyers-absorbed = crimson, sellers = emerald.

    // --- Interaction: wheel zoom, drag pan, double-click reset to live extents ---
    this.surface.chartModifiers.add(
      new ZoomPanModifier(),
      new MouseWheelZoomModifier(),
      new ZoomExtentsModifier({
        onZoomExtents: () => {
          this.resetView();
          return false;
        },
      })
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
    // The 🧱/💥/🚀 regime text markers share the `bubbles` toggle; hide them too,
    // otherwise they leak onto the canvas after the bubble layer is toggled off
    // until the next frame rebuild (Audit #6).
    for (const m of this.bubbleRegimeAnnotations) m.isHidden = !this.layers.bubbles;
  }

  /** Load historical candles from Binance to seed price action + absorption history. */
  loadHistoricalCandles(candles: CandleData[]) {
    if (!this.surface || candles.length === 0) return;
    this.historicalCandles = [...candles];
    this.candleData.clear();
    for (const c of candles) {
      this.candleData.append(c.time, c.open, c.high, c.low, c.close);
    }
    const last = candles[candles.length - 1];
    this.curBucket = last.time;
    this.curOhlc = { o: last.open, h: last.high, l: last.low, c: last.close };
    this.curBucketMaxVol = last.volume;

    if (this.priceFloor === 0) {
      const span = PRICE_ROWS * this.cfg.tickSize;
      this.priceFloor = Math.round((last.close - span / 2) / this.cfg.tickSize) * this.cfg.tickSize;
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
    this.heatmapInitialized = false;
    this.lastHeatmapBucket = 0;
    this.historicalCandles = [];
    this.bubbleHits = [];
    this.seenFootprintIds.clear();
    this.vacuumSig = "";
    this.hoplaSig = "";
    // Reset key-level + sweep caches too, and detach their annotations — else a
    // matching signature on the new timeframe would skip re-rendering onto the
    // freshly cleared surface, and stale lines/markers would leak. (Audit #7)
    this.keyLevelsSig = "";
    this.sweepsSig = "";
    for (const a of this.keyLevelAnnotations) this.surface?.annotations.remove(a);
    this.keyLevelAnnotations = [];
    for (const a of this.sweepAnnotations) this.surface?.annotations.remove(a);
    this.sweepAnnotations = [];
    this.bubblesSig = "";
    for (const a of this.bubbleRegimeAnnotations) this.surface?.annotations.remove(a);
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
    // NOTE: the throttled forming-candle re-detect was rolled back — it called
    // clearBubbles() + re-added every bubble on each tick, which made the whole
    // bubble layer re-render constantly (flicker). Heavy Absorption bubbles now
    // rebuild only when a candle closes; new live tape footprints still appear
    // incrementally via appendLiveFootprints() below (O(new points), no churn).
    this.updateHeatmap(frame, nowSec);
    if (frame.absorption_candidates && frame.absorption_candidates.length > 0) {
      this.appendLiveFootprints(frame.absorption_candidates);
    }
    this.updateVacuum(frame);
    this.updateHopla(frame);
    this.updateMarkPrice(frame.mid_price);
    // --- Audit R3: key levels + sweep markers ---
    this.updateKeyLevels(frame);
    this.updateSweeps(frame);
    this.updateBubbleRegimes(frame);
    if (this.liveFollow) {
      this.applyLiveView();
    }
    // Force a redraw this frame. SciChart's internal render loop is rAF-driven
    // and therefore paused while the tab is hidden; an explicit forced draw
    // guarantees the active candle, heatmap and absorption bubbles advance even
    // off-screen (the App drives update() from a timer when document.hidden).
    this.surface.invalidateElement({ force: true });
  }

  /** Returns true when a new candle bucket was opened (caller rebuilds bubbles).
   *
   *  Price action still comes from the mid-price tick (sub-second, smooth), but
   *  VOLUME + DELTA are seeded from `frame.trade_candle` — the trade-price
   *  aggregator in the bridge. Previously volume was hardcoded to 0, which left
   *  the Heavy Absorption detector permanently blind (every bar had volRatio 0).
   *  (Audit #3) The trade candle uses a fixed 60s interval and epoch-ms `t`; we
   *  keep the chart's own timeframe bucketing for the X axis and fold the
   *  trade-candle volume into the current chart bucket. */
  private updateCandles(frame: ChartFrame, nowSec: number): boolean {
    const price = frame.mid_price;
    const tc = frame.trade_candle;
    const bucket = Math.floor(nowSec / this.tfSeconds) * this.tfSeconds;
    if (this.curOhlc === null || bucket > this.curBucket) {
      // A bucket just rolled. Flush the CLOSING candle's final volume before
      // opening the new one: the same-bucket `else` below never runs on this
      // frame, so without this flush the closed candle keeps a stale/partial
      // volume and the Heavy Absorption detector drops the newest bubble (the
      // exact reason it only surfaced after a browser reload). `curBucketMaxVol`
      // holds the running max trade-volume accumulated into the closing bucket.
      if (this.historicalCandles.length > 0 && this.curOhlc !== null) {
        const closing = this.historicalCandles[this.historicalCandles.length - 1];
        if (closing.time === this.curBucket) {
          closing.volume = Math.max(closing.volume, this.curBucketMaxVol);
        }
      }

      this.curBucket = bucket;
      this.curOhlc = { o: price, h: price, l: price, c: price };
      // The new bucket's running volume starts from the current trade_candle's
      // reading (tc.v resets each minute; for a 1m chart it's this bucket's start).
      this.curBucketMaxVol = tc ? tc.v : 0;
      this.candleData.append(bucket, price, price, price, price);
      while (this.candleData.count() > MAX_CANDLES) {
        this.candleData.removeAt(0);
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
      this.candleData.update(idx, this.curOhlc.o, this.curOhlc.h, this.curOhlc.l, this.curOhlc.c);
    }
    if (this.historicalCandles.length > 0) {
      const last = this.historicalCandles[this.historicalCandles.length - 1];
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      // The trade_candle is a 60s running aggregate of transacted volume. Within
      // a chart bucket its `v` is monotonically increasing for the same minute
      // and resets each minute, so accumulate the max seen per minute boundary.
      // For charts at the 1m timeframe this is the exact bucket volume; for
      // higher timeframes it approximates the folded total (good enough to keep
      // the absorption detector live rather than blind). Keep curBucketMaxVol in
      // sync so the rollover flush above can commit the final volume.
      if (tc) {
        this.curBucketMaxVol = Math.max(this.curBucketMaxVol, tc.v);
        last.volume = Math.max(last.volume, tc.v);
      }
    }
    return false;
  }

  /**
   * Full rebuild of the Heavy Absorption bubbles from the candle history.
   * Expensive (runs the detector over up to 500 candles), so it only runs on a
   * new closed candle or a historical (re)load — NOT on every websocket frame.
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
    const fill = side === "buy" ? "rgba(239, 68, 68, 0.40)" : "rgba(16, 185, 129, 0.40)";
    const stroke = side === "buy" ? "rgba(248, 113, 113, 0.95)" : "rgba(52, 211, 153, 0.95)";
    const bubble = new VolumeBubbleAnnotation({ time, price, priceRadius: 0, fill, stroke, label });
    bubble.isHidden = !this.layers.bubbles;
    this.surface.annotations.add(bubble);
    this.bubbleAnnotations.push(bubble);
  }

  /** Remove all bubble annotations from the surface and reset hit records. */
  private clearBubbles() {
    for (const b of this.bubbleAnnotations) this.surface?.annotations.remove(b);
    this.bubbleAnnotations = [];
    this.bubbleHits = [];
  }

  /**
   * Incrementally append only NEW live order-flow tape footprints. Deduped by a
   * synthetic id so a frame carrying the same (carried-forward) candidates does
   * not re-append. No clear(), so this is O(new points) per frame, not O(all).
   */
  private appendLiveFootprints(candidates: ChartFrame["absorption_candidates"]) {
    if (!this.surface || !candidates) return;
    for (const a of candidates) {
      const t = Math.floor(a.timestamp / 1000);
      const px = Number(a.price);
      if (!Number.isFinite(px)) continue;
      const id = `${a.side}-${t}-${px}`;
      if (this.seenFootprintIds.has(id)) continue;
      this.seenFootprintIds.add(id);

      this.addBubble(a.side === "buy" ? "buy" : "sell", 0, t, px, "ABS");
      this.bubbleHits.push({ x: t, y: px, point: null });
    }
    if (this.seenFootprintIds.size > 2000) {
      // Retain the most recent ids (insertion order) so carried-forward
      // candidates are still recognised as seen — avoids a duplicate-append
      // window. The next closed-bar rebuild fully re-seeds the set anyway.
      const recent = Array.from(this.seenFootprintIds).slice(-500);
      this.seenFootprintIds = new Set(recent);
    }
  }

  private updateHeatmap(frame: ChartFrame, nowSec: number) {
    const mid = frame.mid_price;
    const span = PRICE_ROWS * this.cfg.tickSize;
    let dirty = false;

    // 1. Manage priceFloor and vertically translate existing rows when price floor moves.
    // Without this row translation, historical resting levels get shifted to wrong prices
    // whenever price wanders beyond the margin, causing broken pixels and disjointed steps.
    if (this.priceFloor === 0 || mid < this.priceFloor + 15 || mid > this.priceFloor + span - 15) {
      const oldPriceFloor = this.priceFloor;
      const newPriceFloor = Math.round((mid - span / 2) / this.cfg.tickSize) * this.cfg.tickSize;
      if (oldPriceFloor !== 0 && oldPriceFloor !== newPriceFloor) {
        const rowDelta = Math.round((newPriceFloor - oldPriceFloor) / this.cfg.tickSize);
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

      // Seed historical columns based on each zone's actual firstSeenTimestamp (or recent columns),
      // so we don't paint a giant artificial flat brick across all 160 historical columns!
      for (const z of zones) {
        const lo = Number(z.priceLow);
        const hi = Number(z.priceHigh);
        const qty = Number(z.displayedQuantity);
        if (!Number.isFinite(lo) || !Number.isFinite(qty)) continue;
        const rLo = Math.floor((lo - this.priceFloor) / this.cfg.tickSize);
        const rHi = Math.floor((hi - this.priceFloor) / this.cfg.tickSize);
        if (rLo > PRICE_ROWS - 1 || rHi < 0) continue;

        const firstSeen = z.firstSeenTimestamp
          ? (z.firstSeenTimestamp > 1e11 ? Math.floor(z.firstSeenTimestamp / 1000) : z.firstSeenTimestamp)
          : null;

        for (let c = 0; c < HEATMAP_COLS; c++) {
          const colTime = bucket - (HEATMAP_COLS - 1 - c) * this.tfSeconds;
          const shouldPaint = firstSeen != null
            ? colTime >= firstSeen
            : c >= HEATMAP_COLS - 20;
          if (shouldPaint) {
            for (let r = Math.max(0, rLo); r <= Math.min(PRICE_ROWS - 1, rHi); r++) {
              this.rawZGrid[r][c] = Math.max(this.rawZGrid[r][c], qty);
            }
          }
        }
      }
      this.recalculateDisplayGrid();
      dirty = true;
    } else {
      // 2. Handle bucket advancement (including multi-bucket jumps when web tab was idle/backgrounded).
      if (bucket !== this.lastHeatmapBucket) {
        const elapsed = Math.round((bucket - this.lastHeatmapBucket) / this.tfSeconds);
        if (elapsed > 0) {
          const shiftCount = Math.min(HEATMAP_COLS, elapsed);
          this.lastHeatmapBucket = bucket;
          for (let r = 0; r < PRICE_ROWS; r++) {
            if (shiftCount >= HEATMAP_COLS) {
              this.rawZGrid[r].fill(0);
            } else {
              this.rawZGrid[r] = this.rawZGrid[r].slice(shiftCount).concat(new Array(shiftCount).fill(0));
            }
          }
          dirty = true;
        } else {
          // Negative or zero elapsed (clock skew, replay, or out-of-order tick):
          // do NOT shift existing resting history forward.
          this.lastHeatmapBucket = bucket;
        }
      }

      // Rebuild only the newest column from the current resting liquidity, and
      // only push to the GPU if that column actually differs from last frame.
      for (let r = 0; r < PRICE_ROWS; r++) {
        if (this.rawZGrid[r][col] !== 0) {
          this.rawZGrid[r][col] = 0;
          dirty = true;
        }
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

    // setZValues marshals the whole 240×160 tensor across the WASM boundary, so
    // only do it when something in the grid actually changed this frame.
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
        // BookMap time-decay: older columns (left) attenuate smoothly into the dark canvas.
        const t = c / maxCol; // 0.0 at oldest column, 1.0 at live front
        factor = (1 - this.heatmapFadeStrength) + this.heatmapFadeStrength * Math.pow(t, 1.35);
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
        for (const a of this.vacuumAnnotations) this.surface.annotations.remove(a);
        this.vacuumAnnotations = [];
      }
      this.vacuumSig = "__off__";
      return;
    }

    const structure = this.pickV74Frame(frame)?.structure;
    const pockets = structure?.vacuum ?? [];
    const vacBand = structure?.vac_band ?? 0;
    const magnet = vacBand > 0 ? structure?.vac_above : vacBand < 0 ? structure?.vac_below : null;

    // Signature: the only things that affect the drawn annotations.
    const sig =
      pockets.map((v) => `${v.strength}:${v.top}:${v.bottom}:${v.price}`).join("|") +
      `#${vacBand}:${magnet ?? ""}`;
    if (sig === this.vacuumSig) return; // unchanged → no annotation churn
    this.vacuumSig = sig;

    for (const a of this.vacuumAnnotations) this.surface.annotations.remove(a);
    this.vacuumAnnotations = [];
    if (pockets.length === 0 && magnet == null) return;

    const strengthColor = (s: number) => (s === 3 ? "#FF5252" : s === 2 ? "#FFA726" : "#8B9BB4");

    for (const v of pockets) {
      const color = strengthColor(v.strength);
      const top = Math.max(v.top, v.bottom);
      const bot = Math.min(v.top, v.bottom);

      const box = new BoxAnnotation({
        x1: 0,
        x2: 1,
        xCoordinateMode: ECoordinateMode.Relative,
        yCoordinateMode: ECoordinateMode.DataValue,
        y1: top,
        y2: bot,
        fill: color + "1a",
        stroke: color + "88",
        strokeThickness: 1,
      });
      this.surface.annotations.add(box);
      this.vacuumAnnotations.push(box);

      const label = new TextAnnotation({
        x1: 0.98,
        xCoordinateMode: ECoordinateMode.Relative,
        horizontalAnchorPoint: EHorizontalAnchorPoint.Right,
        y1: (top + bot) / 2,
        yCoordinateMode: ECoordinateMode.DataValue,
        text: `VAC${v.strength} ${v.price.toFixed(2)}`,
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
        labelValue: `MAGNET ${dir} ${magnet.toFixed(2)}`,
      });
      this.surface.annotations.add(line);
      this.vacuumAnnotations.push(line);
    }
  }

  /** Render the Hopla 3 / 50 / 97 lines — only when the signature changes. */
  private updateHopla(frame: ChartFrame) {
    if (!this.layers.hopla) {
      if (this.hoplaAnnotations.length) {
        for (const a of this.hoplaAnnotations) this.surface.annotations.remove(a);
        this.hoplaAnnotations = [];
      }
      this.hoplaSig = "__off__";
      return;
    }

    const h = this.pickV74Frame(frame)?.structure?.hopla;
    const sig = h ? `${h.line_3}:${h.line_50}:${h.line_97}` : "";
    if (sig === this.hoplaSig) return; // unchanged → no annotation churn
    this.hoplaSig = sig;

    for (const a of this.hoplaAnnotations) this.surface.annotations.remove(a);
    this.hoplaAnnotations = [];
    if (!h) return;

    const mk = (price: number, color: string, label: string, dash: number[]) => {
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

    if (Number.isFinite(h.line_97)) mk(h.line_97, "#ff3b30", `97% ${h.line_97.toFixed(2)}`, [4, 4]);
    if (Number.isFinite(h.line_50)) mk(h.line_50, "#94a3b8", `EQ ${h.line_50.toFixed(2)}`, [1, 4]);
    if (Number.isFinite(h.line_3)) mk(h.line_3, "#00b4d8", `3% ${h.line_3.toFixed(2)}`, [4, 4]);
  }

  /** Render prior-day/week high/low key levels — only when signature changes. */
  private updateKeyLevels(frame: ChartFrame) {
    const kl = frame.key_levels;
    const sig = kl ? `${kl.pdh}:${kl.pdl}:${kl.pwh}:${kl.pwl}` : "";
    if (sig === this.keyLevelsSig) return;
    this.keyLevelsSig = sig;

    for (const a of this.keyLevelAnnotations) this.surface.annotations.remove(a);
    this.keyLevelAnnotations = [];
    if (!kl) return;

    // Format the label INSIDE the helper, after the null/finite guard. Passing
    // `price.toFixed(2)` at the call site would evaluate before the guard runs
    // (JS evaluates arguments eagerly), throwing TypeError on a null level and
    // crashing the whole render loop on the first (null) frame. (Audit #1)
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

    for (const s of sweeps.slice(-10)) { // keep last 10 visible
      // runtime.py sets StructureEvent.time = k.t, which is epoch SECONDS
      // (data.py Kline.t). A blind /1000 would collapse it to ~1970 and push
      // the marker 55 years off the left edge. Normalise defensively: treat
      // values above 1e11 as epoch ms, otherwise as epoch seconds. (Audit #2)
      const tSec = s.time > 1e11 ? Math.floor(s.time / 1000) : Math.floor(s.time);
      const color = s.dir > 0 ? "#22c55e" : "#ef4444"; // bullish sweep up, bearish down
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
        // Float the label clear of the rejection wick: a bullish sweep prints at
        // the swept low (anchor Top -> text sits below), a bearish sweep at the
        // swept high (anchor Bottom -> text sits above). (Audit #8)
        verticalAnchorPoint: s.dir > 0 ? EVerticalAnchorPoint.Top : EVerticalAnchorPoint.Bottom,
      });
      this.surface.annotations.add(marker);
      this.sweepAnnotations.push(marker);
    }
  }

  /** Bubble Regime markers: OI + liquidation classified aggressive sweeps from
   *  the BubbleRegimeEngine. Only the "interesting" regimes are drawn (standard
   *  flow is suppressed to avoid chart clutter). Shares the `bubbles` layer
   *  toggle with the absorption footprints. Mirrors updateSweeps' lifecycle:
   *  signature-gated rebuild, full detach/reattach, bounded to the last few. */
  private updateBubbleRegimes(frame: ChartFrame) {
    if (!this.surface) return;

    const all = frame.bubbles || [];
    // Only non-standard regimes carry a chart-worthy signal.
    const notable = all.filter((b) => b.regime !== "standard_flow");
    const sig = notable
      .slice(-8)
      .map((b) => `${b.timestamp}:${b.regime}:${b.priceCenter}`)
      .join("|");
    if (sig === this.bubblesSig) return;
    this.bubblesSig = sig;

    for (const a of this.bubbleRegimeAnnotations) this.surface.annotations.remove(a);
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
      // timestamp is epoch ms from the bridge; the x-axis is epoch seconds.
      const tSec = b.timestamp > 1e11 ? Math.floor(b.timestamp / 1000) : Math.floor(b.timestamp);
      const price = typeof b.priceCenter === "string" ? parseFloat(b.priceCenter) : b.priceCenter;
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
        // Buy aggression prints below the level, sell aggression above, so the
        // marker clears the candle body like the sweep markers do.
        verticalAnchorPoint: isBuy ? EVerticalAnchorPoint.Top : EVerticalAnchorPoint.Bottom,
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
      // Mutate in place — never recreate the annotation per frame.
      this.markPriceAnnotation.y1 = midPrice;
      this.markPriceAnnotation.labelValue = `MARK ${midPrice.toFixed(2)}`;
    }
  }

  /**
   * Click-to-inspect hit test. Given a click point in pixel coordinates relative
   * to the chart canvas, return the nearest absorption bubble within a pixel
   * tolerance, or null. Used by the cockpit to open the Absorption modal.
   */
  hitTestBubble(clientX: number, clientY: number, tolerancePx = 16): BubbleHit | null {
    if (!this.surface || this.bubbleHits.length === 0 || !this.layers.bubbles) return null;
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

  /** Snap the view to the latest VISIBLE_CANDLES and fit price to visible highs/lows.
   *  Skips the axis writes when the computed range is unchanged (avoids per-frame
   *  full relayout while price ticks inside the same window). */
  applyLiveView() {
    const n = this.candleData.count();
    if (n === 0) return;
    const xVals = this.candleData.getNativeXValues();
    const lastX = xVals.get(n - 1);
    const firstIdx = Math.max(0, n - VISIBLE_CANDLES);
    const firstX = xVals.get(firstIdx);

    // Convert the desired RIGHT_OFFSET_PX whitespace into time (data) units so
    // the active candle sits a constant ~200px clear of the right edge.
    // Require at least 120px room for candles beyond the 200px offset so the
    // denominator cannot collapse to zero / near-zero when side panels open.
    const candleSpan = Math.max(lastX - firstX, this.tfSeconds);
    let pad = this.tfSeconds * 4;
    const plotWidthPx = this.surface?.seriesViewRect?.width ?? 0;
    const minSafePlot = RIGHT_OFFSET_PX + 120;
    if (plotWidthPx > minSafePlot) {
      const computedPad = (candleSpan * RIGHT_OFFSET_PX) / (plotWidthPx - RIGHT_OFFSET_PX);
      // Cap pad to at most 1.5x candleSpan so candles never compress to hairlines
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
    const xChanged = firstX !== this.lastViewFirstX || lastX !== this.lastViewLastX || widthChanged || padChanged;
    const yOk = Number.isFinite(hi) && Number.isFinite(lo) && hi > lo;
    const yChanged = yOk && (lo !== this.lastViewLo || hi !== this.lastViewHi);

    if (!xChanged && !yChanged) return; // nothing moved → no axis write, no relayout

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
    for (const a of this.keyLevelAnnotations) this.surface?.annotations.remove(a);
    this.keyLevelAnnotations = [];
    for (const a of this.sweepAnnotations) this.surface?.annotations.remove(a);
    this.sweepAnnotations = [];
    for (const a of this.bubbleRegimeAnnotations) this.surface?.annotations.remove(a);
    this.bubbleRegimeAnnotations = [];
    for (const b of this.bubbleAnnotations) this.surface?.annotations.remove(b);
    this.bubbleAnnotations = [];
    if (this.markPriceAnnotation) {
      this.surface?.annotations.remove(this.markPriceAnnotation);
      this.markPriceAnnotation = null;
    }
    // Surface.delete() tears down renderable series, data series, point markers,
    // modifiers, the WebGL context and the WASM-backed buffers in one pass.
    this.surface?.delete();
    this.bubbleHits = [];
    this.lastFrame = null;
  }
}
