import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  IChartApi,
  ISeriesApi,
  IPriceLine,
  Time,
} from "lightweight-charts";
import {
  useLiveOrderBook,
  LiquidityZoneData,
  AbsorptionCandidateData,
} from "../../hooks/useLiveOrderBook";
import {
  fetchBinanceFuturesKlines,
  CandleData,
  TimeframeInterval,
} from "../../lib/klines";
import { price } from "../../lib/format";
import {
  DEFAULT_V74_LAYERS,
  V74_LAYER_LABELS,
  drawV74Layers,
  type V74LayerKey,
  type V74Layers,
} from "./v74ChartLayers";
import type { ChartTf } from "../../types/v74";

export const INTERVAL_SEC_MAP: Record<TimeframeInterval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

/**
 * Accurately maps an arbitrary epoch timestamp (in seconds) to a horizontal X pixel coordinate
 * on the TradingView Lightweight-Charts time scale.
 * Resolves sub-bar precision, intra-candle progress, and current active candle bounds.
 */
export function getTimestampXCoordinate(
  timestampSec: number,
  chart: IChartApi,
  candleData: CandleData[],
  intervalSec: number,
): number | null {
  if (!chart || candleData.length === 0) return null;

  // 1. Check if the exact timestamp maps directly to a registered candle
  const directX = chart.timeScale().timeToCoordinate(timestampSec as Time);
  if (directX !== null) return directX;

  // 2. Map timestampSec to the candle bar start time
  const barTime = Math.floor(timestampSec / intervalSec) * intervalSec;
  const barX = chart.timeScale().timeToCoordinate(barTime as Time);

  if (barX !== null) {
    // Try to get next bar or previous bar to calculate spacing and interpolate intra-bar
    const nextBarTime = (barTime + intervalSec) as Time;
    const nextBarX = chart.timeScale().timeToCoordinate(nextBarTime);

    if (nextBarX !== null) {
      const progress = Math.min(
        1.0,
        Math.max(0, (timestampSec - barTime) / intervalSec),
      );
      return barX + progress * (nextBarX - barX);
    }

    // Next bar is not on chart yet (e.g. current forming bar).
    const prevBarTime = (barTime - intervalSec) as Time;
    const prevBarX = chart.timeScale().timeToCoordinate(prevBarTime);
    const barSpacing = prevBarX !== null ? Math.abs(barX - prevBarX) : 14;
    const progress = Math.min(
      1.0,
      Math.max(0, (timestampSec - barTime) / intervalSec),
    );
    return barX + progress * (barSpacing * 0.75);
  }

  // 3. Fallback: Search loaded candles for closest anchor
  const firstCandle = candleData[0];
  const lastCandle = candleData[candleData.length - 1];

  if (timestampSec < firstCandle.time) return null;

  if (timestampSec >= lastCandle.time) {
    return chart.timeScale().timeToCoordinate(lastCandle.time as Time);
  }

  // Binary search for surrounding candles
  let low = 0;
  let high = candleData.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (candleData[mid].time === timestampSec) {
      return chart.timeScale().timeToCoordinate(candleData[mid].time as Time);
    }
    if (candleData[mid].time < timestampSec) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const idx = Math.max(0, high);
  const c0 = candleData[idx];
  const c1 = candleData[Math.min(idx + 1, candleData.length - 1)];

  const x0 = chart.timeScale().timeToCoordinate(c0.time as Time);
  const x1 = chart.timeScale().timeToCoordinate(c1.time as Time);

  if (x0 !== null && x1 !== null && c1.time > c0.time) {
    const progress = (timestampSec - c0.time) / (c1.time - c0.time);
    return x0 + progress * (x1 - x0);
  }

  return x0;
}

export interface HeavyAbsorptionPoint {
  id: string;
  time: number; // candle time in seconds
  type: "buyers_absorbed" | "sellers_absorbed";
  price: number; // anchor price (high or low)
  volRatio: number; // e.g. 80, 130, 187
  wickPercent: number;
  isBullishCandle: boolean;
  candle: CandleData;
}

/**
 * Detects Heavy Absorption across candlesticks (matching the TradingView Heavy Absorption indicator style).
 * Identifies high-volume wicks where aggressive buyers are absorbed at highs or aggressive sellers are absorbed at lows.
 */
export function detectHeavyAbsorptions(
  candles: CandleData[],
): HeavyAbsorptionPoint[] {
  if (candles.length < 15) return [];

  const points: HeavyAbsorptionPoint[] = [];
  const lookback = 20;
  const rollingAvgVol: number[] = new Array(candles.length);
  const rollingAvgTr: number[] = new Array(candles.length);
  let sumVol = 0;
  let sumTr = 0;

  for (let i = 0; i < candles.length; i++) {
    sumVol += candles[i].volume;
    const tr = Math.max(candles[i].high - candles[i].low, 0.01);
    sumTr += tr;

    if (i >= lookback) {
      sumVol -= candles[i - lookback].volume;
      const oldTr = Math.max(candles[i - lookback].high - candles[i - lookback].low, 0.01);
      sumTr -= oldTr;
      rollingAvgVol[i] = sumVol / lookback;
      rollingAvgTr[i] = sumTr / lookback;
    } else {
      rollingAvgVol[i] = sumVol / (i + 1);
      rollingAvgTr[i] = sumTr / (i + 1);
    }
  }

  for (let i = 15; i < candles.length; i++) {
    const c = candles[i];
    const avgVol = rollingAvgVol[i] || 1;
    const avgTr = rollingAvgTr[i] || 1;
    const volRatio = Math.round((c.volume / Math.max(avgVol, 1)) * 100);

    const tr = Math.max(c.high - c.low, 0.01);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperRatio = upperWick / tr;
    const lowerRatio = lowerWick / tr;
    const isBullishCandle = c.close >= c.open;

    // 1. Buyers Absorbed (Aggressive buying trapped at high -> upper wick rejection)
    const isBuyAbs =
      (upperRatio >= 0.35 && volRatio >= 70) ||
      (upperRatio >= 0.48 && volRatio >= 55) ||
      (volRatio >= 130 && upperRatio >= 0.28);

    // 2. Sellers Absorbed (Aggressive selling trapped at low -> lower wick rejection)
    const isSellAbs =
      (lowerRatio >= 0.35 && volRatio >= 70) ||
      (lowerRatio >= 0.48 && volRatio >= 55) ||
      (volRatio >= 130 && lowerRatio >= 0.28);

    // 3. High Volume Effort-vs-Result Spike (Absorption within candle body)
    const isVolumeSpike = volRatio >= 175 && tr <= avgTr * 1.15;

    if (isBuyAbs && (!isSellAbs || upperRatio >= lowerRatio)) {
      points.push({
        id: `abs-buy-${c.time}`,
        time: c.time,
        type: "buyers_absorbed",
        price: c.high,
        volRatio,
        wickPercent: Math.round(upperRatio * 100),
        isBullishCandle,
        candle: c,
      });
    } else if (isSellAbs) {
      points.push({
        id: `abs-sell-${c.time}`,
        time: c.time,
        type: "sellers_absorbed",
        price: c.low,
        volRatio,
        wickPercent: Math.round(lowerRatio * 100),
        isBullishCandle,
        candle: c,
      });
    } else if (isVolumeSpike) {
      points.push({
        id: `abs-spike-${c.time}`,
        time: c.time,
        type: isBullishCandle ? "buyers_absorbed" : "sellers_absorbed",
        price: (c.high + c.low) / 2,
        volRatio,
        wickPercent: Math.round((isBullishCandle ? upperRatio : lowerRatio) * 100),
        isBullishCandle,
        candle: c,
      });
    }
  }

  return points;
}

export interface TradingViewDeepChartProps {
  interval?: TimeframeInterval;
  showBubbles?: boolean;
  showWalls?: boolean;
  showZones?: boolean;
  showVolume?: boolean;
  showIndicators?: boolean;
  onIntervalChange?: (interval: TimeframeInterval) => void;
  onToggleBubbles?: () => void;
  onToggleWalls?: () => void;
  onToggleZones?: () => void;
  showHeader?: boolean;
  /** v7.4 engine timeframe whose signals/structure are drawn. */
  signalTf?: ChartTf;
  v74Layers?: V74Layers;
  onToggleV74Layer?: (key: V74LayerKey) => void;
}

interface InspectedItem {
  type: "zone" | "absorption" | "heavy_absorption";
  x: number;
  y: number;
  data: any;
}

export function TradingViewDeepChart({
  interval: externalInterval,
  showBubbles: externalShowBubbles,
  showWalls: externalShowWalls,
  showZones: externalShowZones,
  showVolume = true,
  showIndicators = true,
  onIntervalChange,
  onToggleBubbles,
  onToggleWalls,
  onToggleZones,
  showHeader = false,
  signalTf = "5m",
  v74Layers = DEFAULT_V74_LAYERS,
  onToggleV74Layer,
}: TradingViewDeepChartProps) {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  // Persistent Heavy Absorption points detected across candlestick history
  const heavyAbsorptionsRef = useRef<HeavyAbsorptionPoint[]>([]);

  // Institutional session absorption footprint cache (persists DeepChart absorption prints on candles)
  const historicalAbsorptionsRef = useRef<Map<string, AbsorptionCandidateData>>(
    new Map(),
  );

  const currentCandleRef = useRef<CandleData | null>(null);
  const candleDataRef = useRef<CandleData[]>([]);

  // Internal fallback state
  const [internalInterval, setInternalInterval] =
    useState<TimeframeInterval>("5m");
  const [internalShowBubbles, setInternalShowBubbles] = useState<boolean>(true);
  const [internalShowWalls, setInternalShowWalls] = useState<boolean>(true);
  const [internalShowZones, setInternalShowZones] = useState<boolean>(true);

  const interval = externalInterval ?? internalInterval;
  const showBubbles = externalShowBubbles ?? internalShowBubbles;
  const showWalls = externalShowWalls ?? internalShowWalls;
  const showZones = externalShowZones ?? internalShowZones;

  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  const showZonesRef = useRef(showZones);
  showZonesRef.current = showZones;

  const showBubblesRef = useRef(showBubbles);
  showBubblesRef.current = showBubbles;

  const showWallsRef = useRef(showWalls);
  showWallsRef.current = showWalls;

  const v74LayersRef = useRef(v74Layers);
  v74LayersRef.current = v74Layers;
  const signalTfRef = useRef<ChartTf>(signalTf);
  signalTfRef.current = signalTf;

  const requestRedrawRef = useRef<() => void>(() => {});
  const isInteractingRef = useRef<boolean>(false);
  const interactionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animFrameIdRef = useRef<number | null>(null);

  const handleSetInterval = (tf: TimeframeInterval) => {
    if (onIntervalChange) onIntervalChange(tf);
    else setInternalInterval(tf);
  };

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hoverCandle, setHoverCandle] = useState<CandleData | null>(null);
  const [latestCandle, setLatestCandle] = useState<CandleData | null>(null);
  const [inspectedItem, setInspectedItem] = useState<InspectedItem | null>(
    null,
  );

  const { data: liveBook, connectionState, latencyMs } = useLiveOrderBook();

  const liveBookRef = useRef(liveBook);
  useEffect(() => {
    liveBookRef.current = liveBook;
  }, [liveBook]);

  // Synchronize incoming absorption candidates into historical footprint cache
  useEffect(() => {
    if (
      liveBook?.absorption_candidates &&
      liveBook.absorption_candidates.length > 0
    ) {
      liveBook.absorption_candidates.forEach((cand) => {
        historicalAbsorptionsRef.current.set(cand.id, cand);
      });
      // Retain candidates for up to 25 minutes for persistent DeepChart footprints
      const cutoff = Date.now() - 25 * 60 * 1000;
      for (const [id, cand] of historicalAbsorptionsRef.current.entries()) {
        if (cand.timestamp < cutoff) {
          historicalAbsorptionsRef.current.delete(id);
        }
      }
    }
  }, [liveBook?.absorption_candidates]);

  // 1. Initialize Lightweight-Charts v5
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth || 800,
      height: container.clientHeight || 500,
      layout: {
        background: { type: ColorType.Solid, color: "#090d16" },
        textColor: "#94a3b8",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#131b2e" },
        horzLines: { color: "#131b2e" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "#38bdf8",
          width: 1,
          style: LineStyle.Dotted,
          labelBackgroundColor: "#0284c7",
        },
        horzLine: {
          color: "#38bdf8",
          width: 1,
          style: LineStyle.Dotted,
          labelBackgroundColor: "#0284c7",
        },
      },
      rightPriceScale: {
        borderColor: "#1e293b",
        scaleMargins: {
          top: 0.08,
          bottom: 0.22,
        },
      },
      timeScale: {
        borderColor: "#1e293b",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        axisDoubleClickReset: {
          time: true,
          price: true,
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
    });

    // Candlestick Series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    });

    // Volume Histogram Series
    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: "#38bdf8",
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: {
        top: 0.82,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Crosshair listener
    const handleCrosshairMove = (param: any) => {
      if (!param || !param.time || !param.seriesData) {
        setHoverCandle(null);
        return;
      }
      const c = param.seriesData.get(candleSeries);
      if (c && "open" in c) {
        setHoverCandle(c as CandleData);
      } else {
        setHoverCandle(null);
      }
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    // Chart click listener for inspecting zones or absorption bubbles (using logical CSS coordinates)
    const handleChartClick = (param: any) => {
      if (!param || !param.point) {
        setInspectedItem(null);
        return;
      }
      const clickX = param.point.x;
      const clickY = param.point.y;
      const currentLiveBook = liveBookRef.current;
      if (!chart || !candleSeries || !currentLiveBook) return;

      // Check absorption bubbles first (all coordinates in CSS logical pixels)
      if (showBubblesRef.current) {
        // 1. Check Heavy Absorption Points on Candlesticks
        for (const pt of heavyAbsorptionsRef.current) {
          const x = chart.timeScale().timeToCoordinate(pt.time as Time);
          const y = candleSeries.priceToCoordinate(pt.price);
          if (x !== null && y !== null) {
            const dist = Math.hypot(clickX - x, clickY - y);
            if (dist <= 22) {
              setInspectedItem({
                type: "heavy_absorption",
                x: clickX,
                y: clickY,
                data: pt,
              });
              return;
            }
          }
        }

        // 2. Check live order flow candidates
        const intervalSec = INTERVAL_SEC_MAP[intervalRef.current] || 300;
        const candidates = Array.from(historicalAbsorptionsRef.current.values());
        for (const cand of candidates) {
          const p = parseFloat(cand.price);
          const t = Math.floor(cand.timestamp / 1000);
          const x = getTimestampXCoordinate(
            t,
            chart,
            candleDataRef.current,
            intervalSec,
          );
          const y = candleSeries.priceToCoordinate(p);
          if (x !== null && y !== null) {
            const dist = Math.hypot(clickX - x, clickY - y);
            if (dist <= 26) {
              setInspectedItem({
                type: "absorption",
                x: clickX,
                y: clickY,
                data: cand,
              });
              return;
            }
          }
        }
      }

      // Check liquidity zones (all coordinates in CSS logical pixels)
      if (showZonesRef.current && currentLiveBook.liquidity_zones) {
        for (const zone of currentLiveBook.liquidity_zones) {
          const pLow = parseFloat(zone.priceLow);
          const pHigh = parseFloat(zone.priceHigh);
          const yTop = candleSeries.priceToCoordinate(pHigh);
          const yBottom = candleSeries.priceToCoordinate(pLow);
          if (yTop !== null && yBottom !== null) {
            const zTop = Math.min(yTop, yBottom);
            const zBottom = Math.max(yTop, yBottom);
            if (clickY >= zTop - 6 && clickY <= zBottom + 6) {
              setInspectedItem({
                type: "zone",
                x: clickX,
                y: clickY,
                data: zone,
              });
              return;
            }
          }
        }
      }

      setInspectedItem(null);
    };
    chart.subscribeClick(handleChartClick);

    // 1. Subscribe to horizontal time scale pan, zoom, fitContent, scroll
    const handleRangeChange = () => {
      requestRedrawRef.current();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleRangeChange);
    chart.timeScale().subscribeVisibleTimeRangeChange(handleRangeChange);
    chart.timeScale().subscribeSizeChange(handleRangeChange);

    // 2. Double-click reset scale listener
    const handleDblClick = () => {
      requestRedrawRef.current();
      requestAnimationFrame(() => requestRedrawRef.current());
      setTimeout(() => requestRedrawRef.current(), 60);
    };
    chart.subscribeDblClick(handleDblClick);

    // 3. Pointer & wheel listeners to smoothly sync vertical price scale dragging & chart interaction
    const handlePointerDown = () => {
      isInteractingRef.current = true;
      requestRedrawRef.current();
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (e.buttons > 0) {
        if (!isInteractingRef.current) {
          isInteractingRef.current = true;
        }
        requestRedrawRef.current();
      }
    };

    const handlePointerUp = () => {
      isInteractingRef.current = false;
      requestRedrawRef.current();
    };

    const handleWheel = () => {
      isInteractingRef.current = true;
      requestRedrawRef.current();
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
      }
      interactionTimeoutRef.current = setTimeout(() => {
        interactionTimeoutRef.current = null;
        isInteractingRef.current = false;
        requestRedrawRef.current();
      }, 200);
    };

    container.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    container.addEventListener("wheel", handleWheel, { passive: true });

    // ResizeObserver
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          chart.applyOptions({ width, height });
          const canvas = overlayCanvasRef.current;
          if (canvas) {
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
          }
          requestRedrawRef.current();
        }
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      container.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      container.removeEventListener("wheel", handleWheel);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleRangeChange);
      chart.timeScale().unsubscribeVisibleTimeRangeChange(handleRangeChange);
      chart.timeScale().unsubscribeSizeChange(handleRangeChange);
      chart.unsubscribeDblClick(handleDblClick);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.unsubscribeClick(handleChartClick);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      if (animFrameIdRef.current !== null) {
        cancelAnimationFrame(animFrameIdRef.current);
        animFrameIdRef.current = null;
      }
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
        interactionTimeoutRef.current = null;
      }
    };
  }, []);

  // 2. Fetch Klines on interval change
  const loadKlines = useCallback(async () => {
    setIsLoading(true);
    const klines = await fetchBinanceFuturesKlines("XAUUSDT", interval, 200);
    if (klines.length > 0 && candleSeriesRef.current && chartRef.current) {
      candleDataRef.current = klines;
      heavyAbsorptionsRef.current = detectHeavyAbsorptions(klines);

      // Format for candle series
      const candlesFormatted = klines.map((k) => ({
        time: k.time as Time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      }));
      candleSeriesRef.current.setData(candlesFormatted);

      // Volume format
      if (volumeSeriesRef.current && showVolume) {
        const volumesFormatted = klines.map((k) => ({
          time: k.time as Time,
          value: k.volume,
          color:
            k.close >= k.open
              ? "rgba(16, 185, 129, 0.4)"
              : "rgba(239, 68, 68, 0.4)",
        }));
        volumeSeriesRef.current.setData(volumesFormatted);
      }

      const last = klines[klines.length - 1];
      currentCandleRef.current = last;
      setLatestCandle(last);
      chartRef.current.timeScale().fitContent();
      requestRedrawRef.current();
    }
    setIsLoading(false);
  }, [interval, showVolume]);

  useEffect(() => {
    loadKlines();
  }, [loadKlines]);

  // 3. Real-Time Candle Updates from Live WebSocket
  useEffect(() => {
    if (!liveBook || liveBook.mid_price === 0 || !candleSeriesRef.current)
      return;

    const currentPrice = liveBook.mid_price;
    const current = currentCandleRef.current;
    if (!current) return;

    const intervalSec = INTERVAL_SEC_MAP[interval] || 300;
    const nowSec = Math.floor(Date.now() / 1000);
    const currentBarStart = Math.floor(nowSec / intervalSec) * intervalSec;

    let updatedCandle: CandleData;

    if (current.time === currentBarStart) {
      updatedCandle = {
        ...current,
        high: Math.max(current.high, currentPrice),
        low: Math.min(current.low, currentPrice),
        close: currentPrice,
      };
    } else {
      updatedCandle = {
        time: currentBarStart,
        open: currentPrice,
        high: currentPrice,
        low: currentPrice,
        close: currentPrice,
        volume: 0,
      };
    }

    currentCandleRef.current = updatedCandle;
    setLatestCandle(updatedCandle);

    if (candleDataRef.current.length > 0) {
      const updatedList = [...candleDataRef.current];
      updatedList[updatedList.length - 1] = updatedCandle;
      candleDataRef.current = updatedList;
      heavyAbsorptionsRef.current = detectHeavyAbsorptions(updatedList);
    }

    candleSeriesRef.current.update({
      time: updatedCandle.time as Time,
      open: updatedCandle.open,
      high: updatedCandle.high,
      low: updatedCandle.low,
      close: updatedCandle.close,
    });
    requestRedrawRef.current();
  }, [liveBook, interval]);

  // 4. Update Best Bid/Ask, Mark Price, and Execution Levels Lines
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    priceLinesRef.current.forEach((line) => {
      try {
        series.removePriceLine(line);
      } catch {
        // ignore
      }
    });
    priceLinesRef.current = [];

    if (!liveBook) return;

    // Best Bid & Best Ask Lines (Clean titles without redundant repeated prices)
    if (liveBook.best_bid > 0 && liveBook.best_ask > 0) {
      const bidLine = series.createPriceLine({
        price: liveBook.best_bid,
        color: "rgba(16, 185, 129, 0.8)",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "BID",
      });
      priceLinesRef.current.push(bidLine);

      const askLine = series.createPriceLine({
        price: liveBook.best_ask,
        color: "rgba(239, 68, 68, 0.8)",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "ASK",
      });
      priceLinesRef.current.push(askLine);
    }

    // Mark Price Line (if available)
    if (liveBook.mark_price && liveBook.mark_price > 0) {
      const markLine = series.createPriceLine({
        price: liveBook.mark_price,
        color: "#f59e0b",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "MARK",
      });
      priceLinesRef.current.push(markLine);
    }

    // Active v7.4 trade levels: axis badges only (box + labelled lines drawn by the Trade layer)
    const v74Active = liveBook.v74?.frames?.[signalTfRef.current]?.active_signal;
    if (v74LayersRef.current.tradeBox && v74Active && v74Active.status === "open") {
      const p = v74Active.plan;
      const mk = (px: number, color: string, title: string) =>
        series.createPriceLine({
          price: px,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          lineVisible: false,
          axisLabelVisible: true,
          title,
        });
      priceLinesRef.current.push(mk(p.entry, "#fbbf24", "ENTRY"));
      priceLinesRef.current.push(mk(p.stop, "#ef4444", "SL"));
      priceLinesRef.current.push(mk(p.tp1, "#10b981", "TP1"));
    }
    requestRedrawRef.current();
  }, [liveBook, v74Layers, signalTf]);

  // 5. Canvas Microstructure Overlays: High-Performance Event-Driven Render Pipeline
  const renderOverlays = useCallback((): boolean => {
    const canvas = overlayCanvasRef.current;
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!canvas || !chart || !series) return false;

    const ctx = canvas.getContext("2d");
    if (!ctx) return false;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || canvas.width / dpr;
    const height = canvas.clientHeight || canvas.height / dpr;

    // Scale context by DPR so all coordinates/dimensions map 1:1 with logical CSS pixels
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const liveBook = liveBookRef.current;
    if (!liveBook || liveBook.mid_price === 0) {
      ctx.restore();
      return false;
    }

    let hasActivePulseAnimations = false;
    const now = Date.now();
    const showZones = showZonesRef.current;
    const showBubbles = showBubblesRef.current;
    const intervalVal = intervalRef.current;

    // --- v7.4 ENGINE LAYERS (drawn first so microstructure bubbles stay on top) ---
    const v74Frame = liveBook.v74?.frames?.[signalTfRef.current];
    if (v74Frame) {
      const xSec = INTERVAL_SEC_MAP[intervalVal] || 300;
      drawV74Layers(
        ctx,
        chart,
        series,
        (t: number) => getTimestampXCoordinate(t, chart, candleDataRef.current, xSec),
        width,
        height,
        v74Frame,
        v74LayersRef.current,
        liveBook.mid_price,
      );
    }

    // --- FEATURE A: RESTING LIQUIDITY ZONES (INSTITUTIONAL HEAT DEPTH PROFILE) ---
    if (
      showZones &&
      liveBook.liquidity_zones &&
      liveBook.liquidity_zones.length > 0
    ) {
        // Safe chart plot boundaries (lightweight-charts price scale is ~72 CSS px)
        const priceScaleWidth = 72;
        const plotRight = Math.max(120, width - priceScaleWidth);
        const zoneRight = plotRight - 4; // Safe right margin before price scale badges

        const bestBidY =
          liveBook.best_bid > 0
            ? series.priceToCoordinate(liveBook.best_bid)
            : null;
        const bestAskY =
          liveBook.best_ask > 0
            ? series.priceToCoordinate(liveBook.best_ask)
            : null;

        interface PreparedZone {
          zone: LiquidityZoneData;
          isBid: boolean;
          mult: number;
          qty: number;
          zoneTop: number;
          zoneHeight: number;
          yCenter: number;
          barLeft: number;
          baseAlpha: number;
          isMegaWall: boolean;
          significance: number;
        }

        const preparedZones: PreparedZone[] = [];

        liveBook.liquidity_zones.forEach((zone: LiquidityZoneData) => {
          if (zone.status === "removed") return;

          const pLow = parseFloat(zone.priceLow);
          const pHigh = parseFloat(zone.priceHigh);
          const yTop = series.priceToCoordinate(pHigh);
          const yBottom = series.priceToCoordinate(pLow);

          if (yTop === null || yBottom === null) return;

          const zoneTop = Math.min(yTop, yBottom);
          const zoneHeight = Math.max(Math.abs(yBottom - yTop), 4);
          const yCenter = zoneTop + zoneHeight / 2;

          // Skip if completely outside canvas viewport
          if (yCenter < -20 || yCenter > height + 20) return;

          const isBid = zone.side === "bid";
          const mult = zone.multipleOfMean || 1.0;
          const qty = parseFloat(zone.displayedQuantity) || 0;
          const isMegaWall = mult >= 100 || qty >= 800;

          // Dynamic depth profile width (log scale mapped smoothly from 42px to 240px)
          const maxBarWidth = Math.min(plotRight * 0.42, 240);
          const minBarWidth = 42;
          const normRatio = Math.min(
            1.0,
            Math.log10(Math.max(1, mult)) / Math.log10(450),
          );
          const barWidth =
            minBarWidth + normRatio * (maxBarWidth - minBarWidth);
          const barLeft = Math.max(20, zoneRight - barWidth);

          // Subtle base opacity so candlesticks remain 100% visible
          const baseAlpha = Math.min(0.08 + Math.min(mult, 200) * 0.0012, 0.35);
          const significance = mult * Math.sqrt(Math.max(qty, 1));

          preparedZones.push({
            zone,
            isBid,
            mult,
            qty,
            zoneTop,
            zoneHeight,
            yCenter,
            barLeft,
            baseAlpha,
            isMegaWall,
            significance,
          });
        });

        // 1. Identify which zones receive placed labels (de-collision + significance filter)
        const labelCandidates = [...preparedZones].sort(
          (a, b) => b.significance - a.significance,
        );

        const placedLabelYCenters: number[] = [];
        const labeledZoneIds = new Set<string>();
        const minVerticalGap = 16;
        const maxVisibleLabels = 8;
        let visibleCount = 0;

        for (const cand of labelCandidates) {
          if (visibleCount >= maxVisibleLabels) break;

          let targetY = cand.yCenter;
          let collides = false;
          for (const placedY of placedLabelYCenters) {
            if (Math.abs(targetY - placedY) < minVerticalGap) {
              collides = true;
              break;
            }
          }

          if (collides && !cand.isMegaWall) {
            continue;
          }

          if (collides && cand.isMegaWall) {
            const nudgedUp = targetY - 14;
            const nudgedDown = targetY + 14;
            const upFree = placedLabelYCenters.every(
              (y) => Math.abs(nudgedUp - y) >= minVerticalGap,
            );
            const downFree = placedLabelYCenters.every(
              (y) => Math.abs(nudgedDown - y) >= minVerticalGap,
            );

            if (upFree) {
              targetY = nudgedUp;
            } else if (downFree) {
              targetY = nudgedDown;
            } else {
              continue;
            }
          }

          placedLabelYCenters.push(targetY);
          labeledZoneIds.add(cand.zone.id);
          visibleCount++;
        }

        // 2. Draw Depth Bars & Sleek Background Guides (ONLY draw historical guide line if zone is labeled)
        preparedZones.forEach((pz) => {
          const {
            isBid,
            zoneTop,
            zoneHeight,
            barLeft,
            baseAlpha,
            isMegaWall,
            zone,
          } = pz;
          const statusAlpha =
            zone.status === "replenished" ? baseAlpha * 1.25 : baseAlpha;

          const isLabeled = labeledZoneIds.has(zone.id) || isMegaWall;

          // 2a. Level guide line across historical chart ONLY if zone has a visible badge
          // (Completely eliminates unlabeled "mystery lines" cutting across candlesticks)
          if (isLabeled) {
            ctx.beginPath();
            ctx.strokeStyle = isBid
              ? `rgba(16, 185, 129, ${statusAlpha * 0.26})`
              : `rgba(244, 63, 94, ${statusAlpha * 0.26})`;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 6]);
            ctx.moveTo(0, zoneTop + zoneHeight / 2);
            ctx.lineTo(barLeft, zoneTop + zoneHeight / 2);
            ctx.stroke();
            ctx.setLineDash([]);
          }

          // 2b. Depth bar with horizontal linear gradient (transparent left -> glowing right)
          const grad = ctx.createLinearGradient(barLeft, 0, zoneRight, 0);
          if (isBid) {
            grad.addColorStop(0, "rgba(16, 185, 129, 0)");
            grad.addColorStop(
              0.25,
              `rgba(16, 185, 129, ${statusAlpha * 0.35})`,
            );
            grad.addColorStop(1, `rgba(16, 185, 129, ${statusAlpha})`);
          } else {
            grad.addColorStop(0, "rgba(244, 63, 94, 0)");
            grad.addColorStop(0.25, `rgba(244, 63, 94, ${statusAlpha * 0.35})`);
            grad.addColorStop(1, `rgba(244, 63, 94, ${statusAlpha})`);
          }

          ctx.fillStyle = grad;
          if (typeof ctx.roundRect === "function") {
            ctx.beginPath();
            ctx.roundRect(
              barLeft,
              zoneTop,
              zoneRight - barLeft,
              zoneHeight,
              [4, 0, 0, 4],
            );
            ctx.fill();
          } else {
            ctx.fillRect(barLeft, zoneTop, zoneRight - barLeft, zoneHeight);
          }

          // 2c. Top and bottom accent gradient lines
          const borderGrad = ctx.createLinearGradient(barLeft, 0, zoneRight, 0);
          const strokeAlpha = Math.min(statusAlpha * 1.8, 0.65);
          if (isBid) {
            borderGrad.addColorStop(0, "rgba(52, 211, 153, 0)");
            borderGrad.addColorStop(
              0.4,
              `rgba(52, 211, 153, ${strokeAlpha * 0.4})`,
            );
            borderGrad.addColorStop(1, `rgba(52, 211, 153, ${strokeAlpha})`);
          } else {
            borderGrad.addColorStop(0, "rgba(251, 113, 133, 0)");
            borderGrad.addColorStop(
              0.4,
              `rgba(251, 113, 133, ${strokeAlpha * 0.4})`,
            );
            borderGrad.addColorStop(1, `rgba(251, 113, 133, ${strokeAlpha})`);
          }

          ctx.strokeStyle = borderGrad;
          ctx.lineWidth = isMegaWall ? 1.5 : 1;

          ctx.beginPath();
          ctx.moveTo(barLeft, zoneTop);
          ctx.lineTo(zoneRight, zoneTop);
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(barLeft, zoneTop + zoneHeight);
          ctx.lineTo(zoneRight, zoneTop + zoneHeight);
          ctx.stroke();

          // 2d. Leading edge accent cap on mega walls
          if (isMegaWall) {
            ctx.beginPath();
            ctx.strokeStyle = isBid ? "#34d399" : "#fb7185";
            ctx.lineWidth = 2;
            ctx.moveTo(barLeft, zoneTop);
            ctx.lineTo(barLeft, zoneTop + zoneHeight);
            ctx.stroke();
          }
        });

        // 3. Render Zone Badges & Microcopy for Labeled Zones
        for (const cand of labelCandidates) {
          if (!labeledZoneIds.has(cand.zone.id)) continue;

          let targetY = cand.yCenter;
          const nearBestBid =
            bestBidY !== null && Math.abs(targetY - bestBidY) < 11;
          const nearBestAsk =
            bestAskY !== null && Math.abs(targetY - bestAskY) < 11;

          const formattedQty =
            cand.qty >= 1000
              ? `${(cand.qty / 1000).toFixed(1)}k oz`
              : `${cand.qty.toFixed(0)} oz`;

          const labelText = cand.isMegaWall
            ? `⚡ ${formattedQty} (${cand.mult.toFixed(0)}x)`
            : `${formattedQty} (${cand.isBid ? "BID" : "ASK"} · ${cand.mult.toFixed(0)}x)`;

          ctx.font = "bold 8.5px 'JetBrains Mono', monospace";
          const textMetrics = ctx.measureText(labelText);
          const textW = textMetrics.width;
          const badgeW = textW + 10;
          const badgeH = 14;

          let badgeX = zoneRight - badgeW - 6;
          if (nearBestBid || nearBestAsk) {
            badgeX = Math.max(cand.barLeft, zoneRight - badgeW - 55);
          }
          const badgeY = targetY - badgeH / 2;

          ctx.fillStyle = "rgba(9, 13, 22, 0.88)";
          ctx.strokeStyle = cand.isBid
            ? cand.isMegaWall
              ? "rgba(52, 211, 153, 0.8)"
              : "rgba(52, 211, 153, 0.4)"
            : cand.isMegaWall
              ? "rgba(251, 113, 133, 0.8)"
              : "rgba(251, 113, 133, 0.4)";
          ctx.lineWidth = cand.isMegaWall ? 1.5 : 1;

          if (typeof ctx.roundRect === "function") {
            ctx.beginPath();
            ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3);
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
            ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);
          }

          ctx.fillStyle = cand.isBid ? "#34d399" : "#fb7185";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(labelText, badgeX + badgeW / 2, targetY + 0.5);
        }
      }

      // --- FEATURE B: ABSORPTION BUBBLES (TRADINGVIEW HEAVY ABSORPTION & DEEPCHART FOOTPRINTS) ---
      if (showBubbles) {
        // 1. Plot Heavy Absorption Candlestick Bubbles (from historical kline analysis)
        const heavyPoints = heavyAbsorptionsRef.current;
        for (const pt of heavyPoints) {
          const x = chart.timeScale().timeToCoordinate(pt.time as Time);
          const y = series.priceToCoordinate(pt.price);

          if (
            x === null ||
            y === null ||
            x < -25 ||
            x > width + 25 ||
            y < -25 ||
            y > height + 25
          ) {
            continue;
          }

          const radius = 15;
          const isBull = pt.isBullishCandle;

          ctx.save();

          // Translucent fill
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fillStyle = isBull
            ? "rgba(16, 185, 129, 0.40)"
            : "rgba(239, 68, 68, 0.40)";
          ctx.fill();

          // Crisp outline stroke
          ctx.strokeStyle = isBull
            ? "rgba(52, 211, 153, 0.95)"
            : "rgba(248, 113, 113, 0.95)";
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // Centered Volume Ratio Number inside bubble (matching 80, 130, 187, 99 in TradingView)
          ctx.font = "bold 10px 'JetBrains Mono', -apple-system, monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
          ctx.shadowBlur = 3;
          ctx.fillText(`${pt.volRatio}`, x, y);

          ctx.restore();
        }

        // 3. Real-time Incoming Order Flow Absorption Candidates (DeepChart Live Tape)
        const intervalSec = INTERVAL_SEC_MAP[intervalVal] || 300;
        const candidates = Array.from(historicalAbsorptionsRef.current.values());

        candidates.forEach((cand: AbsorptionCandidateData) => {
          const ageMs = now - cand.timestamp;
          if (ageMs > 25 * 60 * 1000) return; // Retain active session footprint up to 25 mins

          const candPrice = parseFloat(cand.price);
          const candTimeSec = Math.floor(cand.timestamp / 1000);

          const x = getTimestampXCoordinate(
            candTimeSec,
            chart,
            candleDataRef.current,
            intervalSec,
          );
          const y = series.priceToCoordinate(candPrice);

          if (
            x === null ||
            y === null ||
            x < 0 ||
            x > width ||
            y < 0 ||
            y > height
          ) {
            return;
          }

          // Alpha decay: solid (1.0) for first 2 minutes, then gradual fade to 0.4
          const alpha =
            ageMs < 120000
              ? 1.0
              : Math.max(0.4, 1.0 - (ageMs - 120000) / (23 * 60 * 1000));

          const execQty = parseFloat(cand.executedQuantity) || 0;
          // DeepChart dynamic bubble radius
          const radius = Math.max(
            7,
            Math.min(26, Math.sqrt(Math.max(execQty, 1)) * 4.5),
          );

          // DeepChart order flow absorption semantics:
          // Aggressive Buy absorbed at Ask = Bearish Ask Absorption (Rose/Crimson)
          // Aggressive Sell absorbed at Bid = Bullish Bid Absorption (Emerald/Cyan)
          const isBuyAggressor = cand.side === "buy";
          const isFresh = ageMs < 15000;

          // 1. Fresh Pulse Aura Animation (< 15s)
          if (isFresh) {
            hasActivePulseAnimations = true;
            const pulse = 1.0 + Math.sin(now / 180) * 0.18;
            ctx.beginPath();
            ctx.arc(x, y, (radius + 5) * pulse, 0, Math.PI * 2);
            ctx.fillStyle = isBuyAggressor
              ? `rgba(244, 63, 94, ${alpha * 0.22})`
              : `rgba(16, 185, 129, ${alpha * 0.22})`;
            ctx.fill();
          }

          // 2. Outer Radiant Glow
          ctx.beginPath();
          ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
          ctx.fillStyle = isBuyAggressor
            ? `rgba(244, 63, 94, ${alpha * 0.3})`
            : `rgba(16, 185, 129, ${alpha * 0.3})`;
          ctx.fill();

          // 3. Core Bubble with Institutional Radial Gradient
          const coreGrad = ctx.createRadialGradient(
            x - radius * 0.3,
            y - radius * 0.3,
            radius * 0.1,
            x,
            y,
            radius,
          );

          if (isBuyAggressor) {
            coreGrad.addColorStop(0, `rgba(251, 113, 133, ${alpha * 0.95})`);
            coreGrad.addColorStop(0.7, `rgba(225, 29, 72, ${alpha * 0.85})`);
            coreGrad.addColorStop(1, `rgba(136, 19, 55, ${alpha * 0.95})`);
          } else {
            coreGrad.addColorStop(0, `rgba(52, 211, 153, ${alpha * 0.95})`);
            coreGrad.addColorStop(0.7, `rgba(16, 185, 129, ${alpha * 0.85})`);
            coreGrad.addColorStop(1, `rgba(6, 95, 70, ${alpha * 0.95})`);
          }

          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fillStyle = coreGrad;
          ctx.fill();

          ctx.strokeStyle = isBuyAggressor
            ? `rgba(255, 228, 230, ${alpha * 0.9})`
            : `rgba(209, 250, 229, ${alpha * 0.9})`;
          ctx.lineWidth = cand.confidence >= 0.75 ? 2.0 : 1.2;
          ctx.stroke();

          // 4. Institutional Reticle Rings for High-Confidence Absorptions
          if (cand.confidence >= 0.7) {
            ctx.beginPath();
            ctx.arc(x, y, radius + 3.5, 0, Math.PI * 2);
            ctx.strokeStyle = isBuyAggressor
              ? `rgba(244, 63, 94, ${alpha * 0.6})`
              : `rgba(16, 185, 129, ${alpha * 0.6})`;
            ctx.setLineDash([2, 3]);
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.setLineDash([]);
          }

          // 5. Centered DeepChart Quantity Tag
          if (radius >= 9) {
            ctx.font = `bold ${radius >= 14 ? "9px" : "8px"} 'JetBrains Mono', monospace`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = "#ffffff";
            ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
            ctx.shadowBlur = 3;
            const textStr =
              execQty >= 100
                ? `${execQty.toFixed(0)}`
                : `${execQty.toFixed(1)}`;
            ctx.fillText(textStr, x, y);
            ctx.shadowBlur = 0;
          }
        });
      }

      ctx.restore();
      return hasActivePulseAnimations;
    }, []);

  const requestRedraw = useCallback(() => {
    if (animFrameIdRef.current !== null) return;

    animFrameIdRef.current = requestAnimationFrame(() => {
      animFrameIdRef.current = null;
      const hasActiveAnimations = renderOverlays();

      // Continue animation loop ONLY if user is actively interacting (pan, zoom, drag)
      // OR if fresh pulse animations (<15s) are active
      if (isInteractingRef.current || hasActiveAnimations) {
        requestRedraw();
      }
    });
  }, [renderOverlays]);

  useEffect(() => {
    requestRedrawRef.current = requestRedraw;
  }, [requestRedraw]);

  // Synchronize on real-time data or toggle state changes
  useEffect(() => {
    requestRedraw();
  }, [liveBook, showZones, showBubbles, showWalls, interval, v74Layers, signalTf, requestRedraw]);

  const displayCandle = hoverCandle || latestCandle;
  const candleDiff = displayCandle
    ? displayCandle.close - displayCandle.open
    : 0;
  const candleDiffPct =
    displayCandle && displayCandle.open > 0
      ? (candleDiff / displayCandle.open) * 100
      : 0;
  const candleColorClass =
    candleDiff >= 0 ? "text-terminal-bull" : "text-terminal-bear";

  return (
    <div className="relative w-full h-full flex flex-col min-h-0 bg-[#090d16] overflow-hidden select-none">
      {/* Optional Top Header Bar */}
      {showHeader && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 border-b border-terminal-border/60 bg-terminal-panel/95 font-mono text-xs shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="font-extrabold tracking-wider text-terminal-gold uppercase text-sm">
                XAUUSDT {interval}
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-terminal-surface border border-terminal-border text-terminal-text-dim">
                Binance USDⓈ-M Futures
              </span>
            </div>

            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold bg-terminal-surface border border-terminal-border">
              <span
                className={`w-2 h-2 rounded-full ${
                  connectionState === "connected"
                    ? "bg-terminal-bull animate-pulse"
                    : "bg-terminal-bear"
                }`}
              />
              <span className="text-terminal-text-dim uppercase">
                {connectionState === "connected"
                  ? `LIVE (${latencyMs}ms)`
                  : "OFFLINE"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-2xs">
            <div className="flex items-center bg-terminal-surface rounded border border-terminal-border p-0.5">
              {(["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const).map(
                (tf) => (
                  <button
                    key={tf}
                    onClick={() => handleSetInterval(tf)}
                    className={`px-2 py-0.5 rounded font-bold ${
                      interval === tf
                        ? "bg-terminal-panel text-terminal-gold"
                        : "text-terminal-text-dim hover:text-terminal-text"
                    }`}
                  >
                    {tf}
                  </button>
                ),
              )}
            </div>

            <button
              onClick={() =>
                onToggleZones
                  ? onToggleZones()
                  : setInternalShowZones(!internalShowZones)
              }
              className={`px-2 py-1 rounded border font-semibold ${
                showZones
                  ? "bg-terminal-gold/20 text-terminal-gold border-terminal-gold/40"
                  : "bg-terminal-surface text-terminal-text-dim border-terminal-border"
              }`}
            >
              {showZones ? "⚡ ZONES ON" : "○ ZONES OFF"}
            </button>

            <button
              onClick={() =>
                onToggleBubbles
                  ? onToggleBubbles()
                  : setInternalShowBubbles(!internalShowBubbles)
              }
              className={`px-2 py-1 rounded border font-semibold ${
                showBubbles
                  ? "bg-terminal-bull/15 text-terminal-bull border-terminal-bull/40"
                  : "bg-terminal-surface text-terminal-text-dim border-terminal-border"
              }`}
            >
              {showBubbles ? "● ABSORPTION ON" : "○ ABSORPTION OFF"}
            </button>
          </div>
        </div>
      )}

      {/* Floating TradingView Top-Left Info Legend */}
      <div className="absolute top-2.5 left-3.5 z-20 flex items-center gap-3 font-mono text-[11px] pointer-events-none bg-terminal-panel/85 backdrop-blur-md px-3 py-1.5 rounded border border-terminal-border/70 shadow-xl">
        <div className="flex items-center gap-1.5 font-bold">
          <span className="text-terminal-gold">XAUUSDT</span>
          <span className="text-terminal-text-dim px-1.5 py-0.2 rounded bg-terminal-surface text-[10px] border border-terminal-border/40">
            {interval}
          </span>
          <span className="text-terminal-text-dim text-[10px] hidden sm:inline">
            USDⓈ-M FUTURES
          </span>
        </div>

        {displayCandle && (
          <div className="flex items-center gap-2.5 text-[11px] tabular-nums">
            <span>
              <span className="text-terminal-text-dim mr-0.5">O</span>
              <span className={candleColorClass}>
                {price(displayCandle.open)}
              </span>
            </span>
            <span>
              <span className="text-terminal-text-dim mr-0.5">H</span>
              <span className={candleColorClass}>
                {price(displayCandle.high)}
              </span>
            </span>
            <span>
              <span className="text-terminal-text-dim mr-0.5">L</span>
              <span className={candleColorClass}>
                {price(displayCandle.low)}
              </span>
            </span>
            <span>
              <span className="text-terminal-text-dim mr-0.5">C</span>
              <span className={candleColorClass}>
                {price(displayCandle.close)}
              </span>
            </span>
            <span
              className={`${candleColorClass} font-semibold hidden md:inline`}
            >
              {candleDiff >= 0 ? "+" : ""}
              {candleDiff.toFixed(2)} ({candleDiffPct >= 0 ? "+" : ""}
              {candleDiffPct.toFixed(2)}%)
            </span>
          </div>
        )}
      </div>

      {/* Main Full-Bleed Chart Container */}
      <div className="relative w-full flex-1 min-h-0 bg-[#090d16]">
        {isLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 font-mono text-terminal-text-dim text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-terminal-gold animate-ping" />
              <span>Loading Binance Futures {interval} Candlesticks...</span>
            </div>
          </div>
        )}

        {/* Lightweight Charts Instance */}
        <div ref={chartContainerRef} className="w-full h-full" />

        {/* Microstructure Resting Zones & Absorption Bubbles Canvas Overlay */}
        <canvas
          ref={overlayCanvasRef}
          className="absolute inset-0 pointer-events-none z-10"
        />

        {/* v7.4 layer toggles */}
        {onToggleV74Layer && (
          <div
            className="absolute top-9 left-2 z-20 flex flex-wrap items-center gap-0.5 rounded border border-terminal-border/70 bg-[#090d16]/85 p-0.5 font-mono text-[10px]"
            role="group"
            aria-label={`v7.4 chart layers (${signalTf})`}
          >
            <span className="px-1 text-terminal-text-dim">v7.4 {signalTf}</span>
            {(Object.keys(V74_LAYER_LABELS) as V74LayerKey[]).map((k) => (
              <button
                key={k}
                onClick={() => onToggleV74Layer(k)}
                aria-pressed={v74Layers[k]}
                className={`px-1.5 py-0.5 rounded font-bold transition-colors ${
                  v74Layers[k]
                    ? "bg-terminal-gold/20 text-terminal-gold"
                    : "text-terminal-text-dim hover:text-terminal-text"
                }`}
              >
                {V74_LAYER_LABELS[k]}
              </button>
            ))}
          </div>
        )}

        {/* Inspection Tooltip Popup */}
        {inspectedItem && (
          <div
            className="absolute z-30 font-mono text-xs bg-terminal-panel/95 backdrop-blur-md border border-terminal-border rounded-lg p-3 shadow-2xl text-terminal-text max-w-xs animate-in fade-in"
            style={{
              left: Math.min(
                inspectedItem.x + 15,
                (chartContainerRef.current?.clientWidth || 500) - 280,
              ),
              top: Math.max(10, inspectedItem.y - 40),
            }}
          >
            <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-terminal-border/60">
              <span className="font-bold text-terminal-gold uppercase text-2xs">
                {inspectedItem.type === "zone"
                  ? "⚡ Liquidity Zone Inspector"
                  : inspectedItem.type === "heavy_absorption"
                    ? "🎯 Heavy Absorption Detector"
                    : "🫧 Order Flow Absorption"}
              </span>
              <button
                onClick={() => setInspectedItem(null)}
                className="text-terminal-text-dim hover:text-terminal-text text-2xs font-bold"
              >
                ✕
              </button>
            </div>

            {inspectedItem.type === "zone" ? (
              <div className="space-y-1 text-2xs">
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Side:</span>
                  <span
                    className={`font-bold uppercase ${inspectedItem.data.side === "bid" ? "text-terminal-bull" : "text-terminal-bear"}`}
                  >
                    {inspectedItem.data.side}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Range:</span>
                  <span className="font-bold">
                    ${inspectedItem.data.priceLow} - $
                    {inspectedItem.data.priceHigh}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Displayed:</span>
                  <span className="font-bold text-terminal-gold">
                    {inspectedItem.data.displayedQuantity} oz
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Notional:</span>
                  <span className="font-bold">
                    ${(inspectedItem.data.notionalValue / 1000).toFixed(1)}k
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Status:</span>
                  <span className="font-bold uppercase px-1 rounded bg-terminal-surface">
                    {inspectedItem.data.status}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Mean Mult:</span>
                  <span className="font-bold">
                    {inspectedItem.data.multipleOfMean}x
                  </span>
                </div>
              </div>
            ) : inspectedItem.type === "heavy_absorption" ? (
              <div className="space-y-1 text-2xs">
                <div className="flex justify-between items-center">
                  <span className="text-terminal-text-dim">Condition:</span>
                  <span
                    className={`font-bold uppercase ${
                      inspectedItem.data.type === "buyers_absorbed"
                        ? "text-rose-400"
                        : "text-emerald-400"
                    }`}
                  >
                    {inspectedItem.data.type === "buyers_absorbed"
                      ? "Buyers Absorbed"
                      : "Sellers Absorbed"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Price Anchor:</span>
                  <span className="font-bold text-terminal-gold">
                    ${inspectedItem.data.price.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Vol vs 20-SMA:</span>
                  <span className="font-bold text-white">
                    {inspectedItem.data.volRatio}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Wick Rejection:</span>
                  <span className="font-bold">
                    {inspectedItem.data.wickPercent}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Candle Bias:</span>
                  <span
                    className={`font-bold ${
                      inspectedItem.data.isBullishCandle
                        ? "text-terminal-bull"
                        : "text-terminal-bear"
                    }`}
                  >
                    {inspectedItem.data.isBullishCandle
                      ? "Bullish Bar (Close ≥ Open)"
                      : "Bearish Bar (Close < Open)"}
                  </span>
                </div>
                <p className="text-[10px] text-terminal-text-dim pt-1 border-t border-terminal-border/40 leading-snug">
                  {inspectedItem.data.type === "buyers_absorbed"
                    ? "Passive institutional sellers absorbed aggressive buyers at this candle high, exhausting upward momentum."
                    : "Passive institutional buyers absorbed aggressive sellers at this candle low, establishing local floor."}
                </p>
              </div>
            ) : (
              <div className="space-y-1 text-2xs">
                <div className="flex justify-between items-center">
                  <span className="text-terminal-text-dim">Mechanism:</span>
                  <span
                    className={`font-bold uppercase ${inspectedItem.data.side === "buy" ? "text-rose-400" : "text-emerald-400"}`}
                  >
                    {inspectedItem.data.side === "buy"
                      ? "Ask Abs (Bearish)"
                      : "Bid Abs (Bullish)"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Level:</span>
                  <span className="font-bold">${inspectedItem.data.price}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Absorbed Vol:</span>
                  <span className="font-bold text-terminal-gold">
                    {inspectedItem.data.executedQuantity} oz
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">
                    Price Response:
                  </span>
                  <span className="font-bold">
                    {inspectedItem.data.priceResponse >= 0 ? "+" : ""}
                    {inspectedItem.data.priceResponse} USD
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-terminal-text-dim">Confidence:</span>
                  <span className="font-bold text-emerald-400">
                    {(inspectedItem.data.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="text-[10px] text-terminal-text-dim pt-1 border-t border-terminal-border/40">
                  {inspectedItem.data.reason}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Minimalist Visual Legend */}
        <div className="absolute bottom-2 left-3 z-10 hidden sm:flex items-center gap-3 text-[10px] font-mono text-terminal-text-dim pointer-events-none bg-terminal-surface/65 backdrop-blur-xs px-2.5 py-1 rounded border border-terminal-border/40">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-xs bg-terminal-bull" />
            <span>Bull</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-xs bg-terminal-bear" />
            <span>Bear</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-1 bg-emerald-500/40 border border-emerald-400" />
            <span className="text-emerald-400 font-bold">⚡ Bid Zone</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-1 bg-rose-500/40 border border-rose-400" />
            <span className="text-rose-400 font-bold">⚡ Ask Zone</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded-full border border-emerald-400 bg-emerald-500/40 text-[8px] text-white flex items-center justify-center font-bold">
              80
            </span>
            <span className="text-emerald-400 font-bold">Bull Abs</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded-full border border-rose-400 bg-rose-500/40 text-[8px] text-white flex items-center justify-center font-bold">
              130
            </span>
            <span className="text-rose-400 font-bold">Bear Abs</span>
          </div>
        </div>
      </div>
    </div>
  );
}
