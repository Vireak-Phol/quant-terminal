/** Chart colour settings (candles + absorption bubbles), persisted to localStorage.
 *
 *  Pure module: validation, defaults and colour maths only, so it can be unit-tested
 *  without a DOM or SciChart. Colours are stored as `#rrggbb`; opacity separately. */

export interface ChartStyle {
  /** Candle body when close >= open. */
  candleUpBody: string;
  /** Candle body when close < open. */
  candleDownBody: string;
  /** Wick + outline for up candles. */
  candleUpWick: string;
  /** Wick + outline for down candles. */
  candleDownWick: string;
  /** Bubble colour for aggressive BUYERS absorbed (default DeepCharts blue). */
  bubbleBuy: string;
  /** Bubble colour for aggressive SELLERS absorbed (default DeepCharts pink). */
  bubbleSell: string;
  /** Fill opacity for normal / wall bubbles, 0.1–1. Battle tier is always brighter. */
  bubbleOpacity: number;
  /** Colour of the number printed inside bubbles. */
  bubbleText: string;
}

export const DEFAULT_CHART_STYLE: ChartStyle = {
  candleUpBody: "#26a69a",
  candleDownBody: "#ef5350",
  candleUpWick: "#26a69a",
  candleDownWick: "#ef5350",
  bubbleBuy: "#3b82f6",
  bubbleSell: "#ec4899",
  bubbleOpacity: 0.55,
  bubbleText: "#ffffff",
};

/** One-click palettes. "Classic" is the shipped look. */
export const STYLE_PRESETS: Array<{ name: string; style: ChartStyle }> = [
  { name: "Classic", style: DEFAULT_CHART_STYLE },
  {
    name: "Mono",
    style: {
      ...DEFAULT_CHART_STYLE,
      candleUpBody: "#d1d5db", candleDownBody: "#374151",
      candleUpWick: "#d1d5db", candleDownWick: "#9ca3af",
    },
  },
  {
    name: "Hollow-ish",
    style: {
      ...DEFAULT_CHART_STYLE,
      candleUpBody: "#0b1220", candleDownBody: "#ef5350",
      candleUpWick: "#26a69a", candleDownWick: "#ef5350",
    },
  },
  {
    // Blue/orange: distinguishable for the common red-green colour-vision deficiencies.
    name: "Colour-blind",
    style: {
      ...DEFAULT_CHART_STYLE,
      candleUpBody: "#2563eb", candleDownBody: "#f97316",
      candleUpWick: "#2563eb", candleDownWick: "#f97316",
      bubbleBuy: "#06b6d4", bubbleSell: "#facc15", bubbleText: "#0b1220",
    },
  },
];

export const STYLE_KEYS = Object.keys(DEFAULT_CHART_STYLE) as Array<keyof ChartStyle>;

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v);
}

/** Merge untrusted input (localStorage) onto defaults, dropping anything invalid. */
export function sanitizeStyle(raw: unknown): ChartStyle {
  const out: ChartStyle = { ...DEFAULT_CHART_STYLE };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const k of STYLE_KEYS) {
    if (k === "bubbleOpacity") {
      const n = Number(r[k]);
      if (Number.isFinite(n)) out.bubbleOpacity = Math.min(1, Math.max(0.1, n));
    } else if (isHexColor(r[k])) {
      out[k] = (r[k] as string).toLowerCase();
    }
  }
  return out;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

/** Linear blend toward `to` (t=0 → hex, t=1 → to). */
export function mixHex(hex: string, to: string, t: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(to);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export interface BubblePaint {
  fill: string;
  stroke: string;
  strokeThickness: number;
}

/** Derive all bubble tiers from one base colour per side:
 *  normal / wall = base at the user opacity with a lighter ring;
 *  battle        = near-opaque, slightly darker, with an almost-white ring. */
export function bubblePaint(style: ChartStyle, side: "buy" | "sell", battle: boolean): BubblePaint {
  const base = side === "buy" ? style.bubbleBuy : style.bubbleSell;
  if (battle) {
    return {
      fill: rgba(mixHex(base, "#000000", 0.12), 0.9),
      stroke: rgba(mixHex(base, "#ffffff", 0.9), 0.95),
      strokeThickness: 2,
    };
  }
  return {
    fill: rgba(base, style.bubbleOpacity),
    stroke: rgba(mixHex(base, "#ffffff", 0.25), 1),
    strokeThickness: 1.5,
  };
}

const STORAGE_KEY = "terminal.chartStyle.v1";

export function loadChartStyle(): ChartStyle {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeStyle(JSON.parse(raw)) : { ...DEFAULT_CHART_STYLE };
  } catch {
    return { ...DEFAULT_CHART_STYLE };
  }
}

export function saveChartStyle(style: ChartStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(style));
  } catch {
    /* private mode / quota: keep session-only */
  }
}
