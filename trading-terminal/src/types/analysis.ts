export type Direction = 'bullish' | 'bearish' | 'neutral' | 'ranging'

export interface LargeBlock {
  time: string
  size: number
  side: 'buy' | 'sell'
  significance: 'high' | 'medium' | 'low'
}

export interface InstitutionalFlow {
  accumulation_score: number
  distribution_score: number
  net_institutional_flow: 'positive' | 'negative' | 'neutral'
  large_blocks: LargeBlock[]
}

export interface OrderFlowImbalance {
  bid_ask_ratio: number
  delta_volume: number
  cumulative_delta: 'rising' | 'falling' | 'flat'
  imbalance_score: number
}

export interface LiquidityCluster {
  price: number
  type: 'support' | 'resistance'
  strength: 'strong' | 'moderate' | 'weak'
  volume_nodes: number
}

export interface FairValueGap {
  price_low: number
  price_high: number
  status: 'unfilled' | 'filled' | 'partially_filled'
}

export interface OrderBlock {
  price: number
  type: 'bullish' | 'bearish'
  strength: 'strong' | 'moderate' | 'weak'
}

export interface LiquiditySweep {
  time: string
  price: number
  type: 'buy_side' | 'sell_side'
  result: string
}

export interface SmartMoneyConcepts {
  market_structure: 'bullish' | 'bearish' | 'ranging'
  fair_value_gaps: FairValueGap[]
  order_blocks: OrderBlock[]
  liquidity_sweeps: LiquiditySweep[]
}

export interface KeyLevels {
  resistance_r1: number
  resistance_r2: number
  support_s1: number
  support_s2: number
}

export interface SessionBias {
  overall_bias: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  key_levels: KeyLevels
  narrative: string
}

export interface ProfessionalPositioning {
  put_call_ratio: number
  max_pain: number
  gamma_exposure: number
  dealer_positioning: 'long_gamma' | 'short_gamma' | 'neutral'
}

export interface BigMoneyAnalysis {
  institutional_flow: InstitutionalFlow
  order_flow_imbalance: OrderFlowImbalance
  liquidity_clusters: LiquidityCluster[]
  professional_positioning: ProfessionalPositioning
  smart_money_concepts: SmartMoneyConcepts
  session_bias: SessionBias
}

export interface TrendAnalysis {
  short_term: 'bullish' | 'bearish' | 'neutral' | 'ranging'
  medium_term: 'bullish' | 'bearish' | 'neutral' | 'ranging'
  long_term: 'bullish' | 'bearish' | 'neutral' | 'ranging'
}

export interface MomentumAnalysis {
  rsi: number
  macd: 'bullish_cross' | 'bearish_cross' | 'neutral'
  stochastic: number
}

export interface VolumeAnalysis {
  volume_trend: 'increasing' | 'decreasing' | 'flat'
  vwap_position: 'above' | 'below' | 'at'
  volume_profile: string
}

export interface SupportResistance {
  nearest_support: number
  nearest_resistance: number
}

export interface TechnicalConfluence {
  trend: TrendAnalysis
  momentum: MomentumAnalysis
  volume_analysis: VolumeAnalysis
  support_resistance: SupportResistance
}

export interface RiskAssessment {
  overall_risk: 'low' | 'moderate' | 'high'
  volatility_regime: 'low' | 'normal' | 'high'
  key_risks: string[]
  position_sizing: 'reduced' | 'standard' | 'increased'
}

/* ============================================================================
   V2 SCHEMA EXTENSION
   Everything below is OPTIONAL. Snapshots written against the original schema
   (public/xauusd-analysis.json has no `meta`, no `v6`) must keep rendering
   unchanged — panels that need new data show an empty state, never a crash.
   ========================================================================= */

/** Provenance. Unknown-age numbers are worthless on a desk, so every snapshot
 *  should carry when it was taken and what produced it. Shaped to match what
 *  the tradingview MCP `session_save` writes to ~/.tradingview-mcp/sessions/. */
export interface SnapshotMeta {
  /** ISO-8601 instant the analysis was captured. Drives the staleness pill. */
  as_of: string
  /** e.g. "TradingView Desktop (CDP)", "manual", "backfill" */
  source?: string
  /** e.g. "OSC-VIP V6.1 / REG-V6" */
  generator?: string
  /** Bumped when the same session is re-analysed. */
  revision?: number
  /** Capture round-trip in ms, if the producer measured it. */
  latency_ms?: number
  timeframe?: string
  /** Last traded price at capture. Anchors the ladder and the trade plan. */
  last_price?: number
}

export type KillzoneName = 'london' | 'ny_am' | 'asia' | 'none'
export type V6Tier = 'a_plus' | 'structural' | 'trap' | 'none'
export type HtfTrend = 'bull' | 'bear' | 'neutral'

/** REG-V6 structural confluence flags (see .agents/AGENTS.md §5). */
export interface RegV6Confluence {
  /** Fair Value Gap + Breaker block overlap. */
  unicorn?: boolean
  /** Linear-regression order block break/bounce. */
  reg_ob?: boolean
  /** Reversal Pattern Detection peak/valley. */
  rpd?: boolean
  /** 20-bar high/low sweep followed by directional rejection. */
  sweep?: boolean
}

/** OSC-VIP V6 Bayesian execution engine state.
 *  Tier classification is NOT stored here — it is derived in src/lib/v6.ts from
 *  these inputs so the rule set lives in exactly one auditable place. */
export interface V6Engine {
  long_win_prob: number
  short_win_prob: number
  /** Signals on unconfirmed bars are not tradeable. */
  bar_confirmed: boolean
  killzone: KillzoneName
  /** Macro shock guard: tr > 3.5 * atr100 within 15 bars. Mutes everything. */
  shock_guard: boolean
  /** Volume gate. A+ elevation requires vol_z > 0. */
  vol_z: number
  /** ATR used for the 1.5x SL / 2.0x TP1 / 3.5x TP2 plan. */
  atr: number
  /** Kaufman Efficiency Ratio: >0.45 trending, <0.20 ranging. */
  er_val: number
  /** Smart Money Pressure Index. >0 long, <0 short. */
  smpi: number
  /** Alignment against the 4H 200 EMA. */
  htf_trend: HtfTrend
  vwap_z?: number
  reg_v6?: RegV6Confluence
}

/** A row in the cross-asset watchlist. `history` powers the sparkline. */
export interface WatchlistRow {
  symbol: string
  market?: string
  bias: Direction
  confidence: number
  imbalance?: number
  change_pct?: number
  last?: number
  /** Long/short win probs, so the blotter can show a V6 tier per symbol. */
  v6?: Pick<V6Engine, 'long_win_prob' | 'short_win_prob'>
  /** Oldest-first confidence series. */
  history?: number[]
}

export interface CvdPoint {
  /** Bar time, "HH:MM". */
  t: string
  /** Cumulative delta at this bar. */
  cvd: number
  /** Per-bar delta. */
  delta: number
  price?: number
}

/** One level of the depth ladder. */
export interface DomLevel {
  price: number
  bid_size?: number
  ask_size?: number
}

export interface Microstructure {
  cvd_series?: CvdPoint[]
  dom?: DomLevel[]
}

export interface GexStrike {
  strike: number
  /** Signed dealer gamma at this strike. */
  gex: number
}

/** Options positioning detail. Complements the scalar fields on
 *  ProfessionalPositioning rather than replacing them. */
export interface PositioningDetail {
  gex_by_strike?: GexStrike[]
  /** Strike where dealer gamma flips sign — the volatility regime pivot. */
  zero_gamma?: number
}

export interface EconEvent {
  /** ISO-8601, or "HH:MM" for same-session events. */
  time: string
  event: string
  impact: 'high' | 'medium' | 'low'
  currency?: string
  actual?: string
  forecast?: string
}

export interface DailyAnalysis {
  date: string
  market: string
  symbol: string
  big_money_analysis: BigMoneyAnalysis
  technical_confluence: TechnicalConfluence
  risk_assessment: RiskAssessment

  // --- v2 extension, all optional ---
  meta?: SnapshotMeta
  v6?: V6Engine
  watchlist?: WatchlistRow[]
  micro?: Microstructure
  positioning_detail?: PositioningDetail
  calendar?: EconEvent[]
}

/** Manifest entry in public/snapshots/index.json. */
export interface SnapshotRef {
  date: string
  symbol: string
  /** Path relative to the site root, e.g. "/snapshots/2026-07-29-xauusd.json". */
  file: string
  market?: string
}

export type TabId =
  | 'overview'
  | 'v6'
  | 'institutional'
  | 'orderflow'
  | 'smartmoney'
  | 'charts'
  | 'watchlist'
  | 'risk'
  | 'alerts'
  | 'workspace'

