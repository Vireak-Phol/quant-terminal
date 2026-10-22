import type { Timeframe, ChartLayer } from "../../chart/TerminalChart";

export const CHART_DIV_ID = "scichart-root";

export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m"];

// How many historical klines to seed the chart with on mount / timeframe switch.
// Binance USDⓈ-M /fapi/v1/klines allows up to 1500 in a single request, and the
// chart retains up to MAX_CANDLES (see TerminalChart.ts) — keep this <= that cap.
export const HISTORY_LIMIT = 1000;

export interface LayerMeta {
  key: ChartLayer;
  label: string;
  glyph: string;
  on: string;
}

export const LAYER_META: LayerMeta[] = [
  {
    key: "heatmap",
    label: "HEATMAP",
    glyph: "🔥",
    on: "bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-glow",
  },
  {
    key: "bubbles",
    label: "ABSORPTION",
    glyph: "🫧",
    on: "bg-terminal-bull/20 text-terminal-bull border border-terminal-bull/40 shadow-glow",
  },
  {
    key: "vacuum",
    label: "VACUUM",
    glyph: "🧲",
    on: "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-glow",
  },
  {
    key: "hopla",
    label: "HOPLA",
    glyph: "📐",
    on: "bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/50 shadow-glow",
  },
];
