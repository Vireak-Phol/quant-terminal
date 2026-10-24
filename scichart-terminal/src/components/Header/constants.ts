import type { Timeframe, ChartLayer } from "../../chart/TerminalChart";
import type { IconName } from "./Icon";
import type { Tone } from "./ToolbarButton";

export const CHART_DIV_ID = "scichart-root";

export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m"];

// How many historical klines to seed the chart with on mount / timeframe switch.
// Binance USDⓈ-M /fapi/v1/klines allows up to 1500 in a single request, and the
// chart retains up to MAX_CANDLES (see TerminalChart.ts) — keep this <= that cap.
export const HISTORY_LIMIT = 1000;

export interface LayerMeta {
  key: ChartLayer;
  label: string;
  icon: IconName;
  tone: Tone;
  description: string;
}

export const LAYER_META: LayerMeta[] = [
  { key: "heatmap", label: "Heatmap", icon: "heatmap", tone: "bear", description: "Resting-liquidity heatmap" },
  { key: "bubbles", label: "Absorb", icon: "absorb", tone: "bull", description: "Absorption bubbles & regime markers" },
  { key: "vacuum", label: "Vacuum", icon: "vacuum", tone: "info", description: "Liquidity vacuum pockets & magnet" },
  { key: "hopla", label: "Hopla", icon: "hopla", tone: "gold", description: "Hopla 3 / 50 / 97 range" },
  { key: "vwap", label: "VWAP", icon: "vwap", tone: "gold", description: "Institutional VWAP & Cornish-Fisher Fib Deviation Bands (REG v7.4)" },
  { key: "delta", label: "Delta", icon: "delta", tone: "accent", description: "Volume-delta candle colouring" },
];
