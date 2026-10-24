/** Wire schema for the bridge `v74` frame (orderbook-bridge/engine/live.py + runtime.py).
 *
 *  Probability rule: the only number ever labelled "win rate" is `ProbabilityEstimate.stat`
 *  — a measured, cost-adjusted hit rate from the ledger. `score` fields are the internal
 *  OSC model score and must never be presented as a probability.
 */

export type Tier = 'A_PLUS' | 'STRUCTURAL' | 'TRAP'
export type Direction = 'LONG' | 'SHORT'
export type ChartTf = '5m' | '15m'

export interface Stat {
  n: number
  wins: number
  win_rate: number
  raw_rate: number
  ci_lo: number
  ci_hi: number
  expectancy_r: number
  profit_factor: number | null
  avg_win_r: number
  avg_loss_r: number
  gross_expectancy_r: number
  gross_win_rate: number
  avg_cost_r: number
}

export interface ProbabilityEstimate {
  status: 'measured' | 'warmup'
  source: 'live' | 'backtest' | null
  bucket: string
  level: 'setup_tier_bin' | 'setup_tier' | 'tier' | 'none'
  min_samples: number
  stat: Stat | null
  backtest: Stat | null
  live: Stat | null
}

export interface TradePlan {
  direction: Direction
  entry: number
  stop: number
  tp1: number
  tp2: number
  risk_per_unit: number
  cost_per_unit: number
  cost_r: number
  rr_tp1: number
  rr_tp2: number
  qty: number
  notional: number
  leverage: number
  risk_usd: number
  stop_basis: 'session_sigma' | 'atr' | 'wall'
  wall_price: number | null
  flags: string[]
}

export interface Factor {
  key: string
  label: string
  log_odds: number
}

export interface EngineSignal {
  id: string
  tf: ChartTf
  /** Bar close time (epoch seconds) — when the signal became actionable. */
  time: number
  direction: Direction
  tier: Tier
  setup: string
  score: number
  probability: ProbabilityEstimate
  plan: TradePlan
  tags: string[]
  factors: Factor[]
  orderflow: { tags: string[]; log_odds: number; details: Record<string, unknown>[] }
  status: 'open' | 'closed' | 'history'
  outcome: string | null
  r_net: number | null
}

export interface SignalBrief {
  id: string
  time: number
  direction: Direction
  tier: Tier
  setup: string
  score: number
  entry: number
  stop: number
  tp1: number
  tp2: number
  status: 'open' | 'closed' | 'history'
  outcome: string | null
  r_net: number | null
  prob_status: 'measured' | 'warmup'
  win_rate: number | null
  n: number | null
}

export interface SideView {
  score: number
  raw_score: number
  tier: Tier | null
  setup: string | null
  has_setup: boolean
  no_conflict: boolean
  weights: Record<string, number>
}

export interface VacuumPocket {
  side: 'high' | 'low'
  price: number
  top: number
  bottom: number
  strength: number
  birth_bar: number
  birth_time: number
}

export interface UnicornSetup {
  id: number
  tf: string
  side: 'bull' | 'bear'
  fvg_top: number
  fvg_bottom: number
  breaker_top: number
  breaker_bottom: number
  entry: number
  stop: number
  confluence: number
  score: number
}

export interface LiquidityLevel {
  price: number
  side: 'high' | 'low'
  created_bar?: number
  last_sweep_bar?: number
  touches?: number
}

export interface RegObZone {
  top: number
  bottom: number
  side: 'bull' | 'bear'
  created: number
  confirmed: boolean
}

export interface StructureEvent {
  kind: 'rpd_peak' | 'rpd_valley' | 'liq_sweep' | 'unicorn' | 'choch' | 'shock'
  time: number
  price: number
  dir: number
  prob?: number | null
}

export interface HoplaLevelsV74 {
  range: number
  box_low: number
  box_high: number
  line_3: number
  line_50: number
  line_97: number
  line_97_above: number
  line_3_below: number
  in_discount: boolean
  in_premium: boolean
  near_3: boolean
  near_97: boolean
}

export interface TimeframeFrame {
  tf: ChartTf
  ready: boolean
  bar_time?: number
  updated_at?: number
  context?: {
    regime: 'TRENDING' | 'RANGING' | 'NEUTRAL'
    er: number
    killzone: string
    active_killzone: boolean
    kz_confirmed: boolean
    shock_hard: boolean
    shock_soft: boolean
    htf_bull: boolean
    htf_bear: boolean
    htf_extension: number
    vwap_z: number
    smpi: number | null
    vol_z: number
    atr: number | null
    session_vol: number | null
    n_eff: number
    k_active: number
    r_bar: number
    dynamic_min: number
    eqs: number
    toxic_flow: boolean
    ltf_ok: boolean
    macro: string
    trend_dir: number
    rpd_trend: number | null
  }
  gates?: Record<string, boolean>
  long?: SideView
  short?: SideView
  active_signal?: EngineSignal | null
  signals?: SignalBrief[]
  latest?: EngineSignal[]
  structure?: {
    hopla: HoplaLevelsV74
    vacuum: VacuumPocket[]
    vac_above: number | null
    vac_below: number | null
    vac_band: number
    unicorn: UnicornSetup[]
    liquidity: LiquidityLevel[]
    key_levels: {
      pdh: number | null
      pdl: number | null
      pwh: number | null
      pwl: number | null
      globex_open?: number | null
      call_wall?: number | null
      put_wall?: number | null
      gamma_flip?: number | null
      net_gex?: string | null
    }
    regob: RegObZone[]
    regression: { mid: number | null; upper: number | null; lower: number | null }
    events: StructureEvent[]
  }
  pine_aplus?: Record<string, number>
}

export interface Guardrails {
  warnings: { code: string; message: string }[]
  trades_today: number
  r_today: number
  consecutive_losses: number
  trading_day?: string
}

export interface RiskConfigV74 {
  account_equity: number
  risk_pct: number
  taker_fee_rate: number
  slippage_ticks: number
  tick_size: number
  qty_step: number
  min_qty: number
  leverage_cap: number
  sl_mult: number
  tp1_mult: number
  tp2_mult: number
  min_risk_atr: number
  wall_anchor_atr: number
  wall_buffer_ticks: number
  horizon_bars: number
  max_trades_per_day: number
  daily_loss_limit_r: number
  max_consecutive_losses: number
  cost_heavy_r: number
}

export interface V74Frame {
  status: 'warming_up' | 'live' | 'degraded' | 'error'
  error: string | null
  version: number
  symbol: string
  frames: Partial<Record<ChartTf, TimeframeFrame>>
  guardrails: Guardrails
  risk: RiskConfigV74
  macro: string
  probability_basis: 'empirical'
}

export interface LedgerSummaryRow extends Stat {
  tf: string
  setup: string
  tier: Tier
  warmup: boolean
}

export interface LedgerRecord {
  id: string
  source: 'live' | 'backtest'
  tf: string
  setup: string
  direction: Direction
  tier: Tier
  score: number
  entry_time: number
  entry: number
  stop: number
  tp1: number
  status: 'open' | 'closed'
  outcome: string | null
  win: boolean | null
  r_net: number | null
  exit_time: number | null
}

export interface LedgerView {
  type: 'ledger'
  summary: { backtest: LedgerSummaryRow[]; live: LedgerSummaryRow[] }
  reliability: Record<string, (Stat & { score_bin: number })[]>
  recent: LedgerRecord[]
  counts: { backtest: number; live: number }
  min_samples: number
}
