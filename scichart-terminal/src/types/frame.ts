// Typed model of the `bookmap_update` frame broadcast by orderbook-bridge/bridge.py
// over ws://localhost:8765.

export interface DepthLevel {
  price: number;
  size: number;
}

export interface LiquidityZone {
  type: "liquidity_zone";
  id: string;
  symbol: string;
  side: "bid" | "ask";
  priceLow: string;
  priceHigh: string;
  centerPrice: number;
  displayedQuantity: string;
  peakDisplayedQuantity: string;
  notionalValue: number;
  firstSeenTimestamp: number;
  lastUpdatedTimestamp: number;
  persistenceDuration: number;
  status: "active" | "reduced" | "removed" | "replenished" | "uncertain";
  multipleOfMean: number;
  levelCount: number;
}

export interface AbsorptionCandidate {
  type: "absorption_candidate";
  id: string;
  symbol: string;
  side: "buy" | "sell";
  price: string;
  executedQuantity: string;
  tradeCount: number;
  priceResponse: number;
  expectedPriceResponse: number;
  confidence: number;
  status: "candidate" | "confirmed";
  timestamp: number;
  reason: string;
}

export interface VacuumZone {
  type: "vacuum_zone";
  side: "high" | "low";
  price: number;
  top: number;
  bot: number;
  strength: 1 | 2 | 3;
  birthBar: number;
}

export interface VacuumMagnet {
  direction: "up" | "down" | "none";
  abovePrice: number | null;
  belowPrice: number | null;
  aboveDistance: number | null;
  belowDistance: number | null;
  aboveStrength: number;
  belowStrength: number;
  atr: number;
}

export interface PricePoint {
  t: number;
  p: number;
  bid: number;
  ask: number;
}

export interface VacuumPocketV74 {
  side: "high" | "low";
  price: number;
  top: number;
  bottom: number;
  strength: number;
  birth_bar: number;
  birth_time: number;
}

export interface V74Structure {
  vacuum?: VacuumPocketV74[];
  vac_above?: number | null;
  vac_below?: number | null;
  vac_band?: number;
  [key: string]: unknown;
}

export interface V74TimeframeFrame {
  ready: boolean;
  tf?: string;
  structure?: V74Structure;
  [key: string]: unknown;
}

export interface V74State {
  status: string;
  version?: string;
  symbol?: string;
  frames?: Record<string, V74TimeframeFrame>;
  [key: string]: unknown;
}

export interface TradeCandle {
  t: number;      // bucket open time, epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;      // total volume (oz)
  d: number;      // delta (buy - sell, oz)
  bv: number;     // buy volume
  sv: number;     // sell volume
  closed: boolean;
}

export interface SessionFlags {
  london: boolean;
  ny_am: boolean;
  asia: boolean;
  london_fix: boolean;
  name: string;
}

export interface KeyLevels {
  pdh: number | null;
  pdl: number | null;
  pwh: number | null;
  pwl: number | null;
}

export interface SweepEvent {
  kind: "liq_sweep";
  time: number;
  price: number;
  dir: number;
  prob?: number | null;
}

export interface BookmapFrame {
  type: "bookmap_update";
  symbol: string;
  timestamp: number;
  mid_price: number;
  spread: number;
  best_bid: number;
  best_ask: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  imbalance: number;
  liquidity_zones: LiquidityZone[];
  absorption_candidates: AbsorptionCandidate[];
  price_history: PricePoint[];
  vacuum_zones: VacuumZone[];
  vacuum_magnet: VacuumMagnet;
  v74?: V74State;
  // --- Audit R1: trade-price candles + CVD ---
  trade_candle?: TradeCandle | null;
  cvd: number;
  // --- Audit R3: session/killzone + key levels + sweep events ---
  session: SessionFlags;
  key_levels: KeyLevels;
  sweep_events: SweepEvent[];
  status: string;
}

export function normalizeLevels(raw: unknown): DepthLevel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l): DepthLevel | null => {
      if (l && typeof l === "object" && "price" in l) {
        const o = l as Record<string, unknown>;
        return { price: Number(o.price), size: Number(o.size ?? 0) };
      }
      if (Array.isArray(l) && l.length >= 2) {
        return { price: Number(l[0]), size: Number(l[1]) };
      }
      return null;
    })
    .filter((x): x is DepthLevel => x !== null && Number.isFinite(x.price));
}
