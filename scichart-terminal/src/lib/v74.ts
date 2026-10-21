/** Pure helpers for the v7.4 signal UI. Kept free of React so they are unit-tested. */

import type { EngineSignal, ProbabilityEstimate, Stat, Tier, TimeframeFrame } from '../types/v74'

export const TIER_LABEL: Record<Tier, string> = {
  A_PLUS: 'A+ Execution',
  STRUCTURAL: 'Structural',
  TRAP: 'Trap / Friction',
}

export const TIER_SHORT: Record<Tier, string> = { A_PLUS: 'A+', STRUCTURAL: 'S', TRAP: 'T' }

const SETUP_LABEL: Record<string, string> = {
  FVG_Bull: 'Bullish FVG',
  FVG_Bear: 'Bearish FVG',
  OB_Bull: 'Bullish Order Block',
  OB_Bear: 'Bearish Order Block',
  LIQ_Bull: 'Sell-side Sweep',
  LIQ_Bear: 'Buy-side Sweep',
  CH_Bull: 'Bullish CHoCH',
  CH_Bear: 'Bearish CHoCH',
  TRAP_Bull: 'Bull Liquidity Trap',
  TRAP_Bear: 'Bear Liquidity Trap',
}

export function setupLabel(s: string | null | undefined): string {
  if (!s) return '—'
  return SETUP_LABEL[s] ?? s
}

const TAG_LABEL: Record<string, string> = {
  htf_aligned: '4H trend aligned',
  killzone_volume: 'Killzone + volume',
  vacuum_aligned: 'Vacuum magnet aligned',
  hopla_discount: 'Hopla 3% discount',
  hopla_premium: 'Hopla 97% premium',
  reg_unicorn: 'Unicorn FVG+Breaker',
  reg_rpd: 'RPD reversal',
  reg_liq_sweep: 'Liquidity sweep',
  reg_regob: 'Regression OB',
  of_wall_support: 'Resting wall behind entry',
  of_wall_against: 'Resting wall in the way',
  of_absorption: 'Absorption confirmed',
  of_imbalance_with: 'Book imbalance with',
  of_imbalance_against: 'Book imbalance against',
}

export function tagLabel(t: string): string {
  if (TAG_LABEL[t]) return TAG_LABEL[t]
  if (t.startsWith('session_')) return `Session: ${t.slice(8).replace('_', ' ').toUpperCase()}`
  if (t.startsWith('regime_')) return `Regime: ${t.slice(7)}`
  return t
}

/** Order-flow tags only exist live; they are unmeasured until the live ledger has samples. */
export function isOrderflowTag(t: string): boolean {
  return t.startsWith('of_')
}

export interface ProbabilityView {
  kind: 'measured' | 'warmup' | 'none'
  headline: string
  sub: string
  /** 0–100 for the bar, null when not measured */
  value: number | null
  ciLo: number | null
  ciHi: number | null
  n: number
  expectancy: number | null
  /** expectancy <= 0 after costs: the setup has no measured edge */
  negativeEdge: boolean
  source: string | null
}

export function probabilityView(p: ProbabilityEstimate | null | undefined): ProbabilityView {
  if (!p) {
    return { kind: 'none', headline: '—', sub: 'No estimate', value: null, ciLo: null, ciHi: null, n: 0, expectancy: null, negativeEdge: false, source: null }
  }
  const s = p.stat
  if (p.status === 'measured' && s) {
    return {
      kind: 'measured',
      headline: `${s.win_rate.toFixed(1)}%`,
      sub: `95% CI ${s.ci_lo.toFixed(0)}–${s.ci_hi.toFixed(0)}% · n=${s.n} · ${p.source}`,
      value: s.win_rate,
      ciLo: s.ci_lo,
      ciHi: s.ci_hi,
      n: s.n,
      expectancy: s.expectancy_r,
      negativeEdge: s.expectancy_r <= 0,
      source: p.source,
    }
  }
  const n = s?.n ?? 0
  return {
    kind: 'warmup',
    headline: 'Warm-up',
    sub: `n=${n}/${p.min_samples} — not yet measured`,
    value: null,
    ciLo: null,
    ciHi: null,
    n,
    expectancy: s ? s.expectancy_r : null,
    negativeEdge: false,
    source: null,
  }
}

/** Verdict for the hero card. Never says "take" when the measured edge is negative. */
export function verdict(sig: EngineSignal | null | undefined): { level: 'go' | 'caution' | 'avoid' | 'idle'; text: string } {
  if (!sig) return { level: 'idle', text: 'No active signal — waiting for a confirmed bar setup.' }
  if (sig.tier === 'TRAP') return { level: 'avoid', text: 'Trap risk: model score below 50. Do not trade.' }
  const pv = probabilityView(sig.probability)
  if (pv.kind === 'measured' && pv.negativeEdge) {
    return { level: 'avoid', text: `Measured expectancy ${pv.expectancy!.toFixed(2)}R after costs — no edge. Skip or paper-trade.` }
  }
  if (sig.plan.flags.includes('oversize')) {
    return { level: 'caution', text: 'Minimum lot exceeds your risk budget. Reduce exposure or skip.' }
  }
  if (pv.kind === 'warmup') {
    return { level: 'caution', text: 'Setup not yet measured. Treat as unproven — reduced size or paper only.' }
  }
  if (sig.tier === 'STRUCTURAL') return { level: 'caution', text: 'Structural tier — half size, require confluence.' }
  return { level: 'go', text: 'A+ with positive measured expectancy after costs.' }
}

export function fmtR(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : ''}${v.toFixed(dp)}R`
}

export function fmtPF(s: Stat | null | undefined): string {
  if (!s || s.profit_factor == null) return '—'
  if (!Number.isFinite(s.profit_factor)) return '∞'
  return s.profit_factor.toFixed(2)
}

export function gateList(fr: TimeframeFrame | undefined, side: 'long' | 'short'): { label: string; pass: boolean }[] {
  const g = fr?.gates ?? {}
  return [
    { label: 'History warm', pass: !!g.min_history },
    { label: 'Killzone', pass: !!g.killzone },
    { label: 'No shock', pass: !!g.no_shock },
    { label: 'Volume > avg', pass: !!g.volume },
    { label: 'No conflict', pass: !!g[side === 'long' ? 'long_no_conflict' : 'short_no_conflict'] },
    { label: 'Cooldown', pass: !!g[side === 'long' ? 'cooldown_long' : 'cooldown_short'] },
  ]
}

export function timeAgo(epochSec: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - epochSec))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/** Distance-cull price objects so the chart stays readable. */
export function withinAtr(price: number | null | undefined, ref: number, atr: number | null | undefined, maxAtr: number): boolean {
  if (price == null || !Number.isFinite(price)) return false
  if (!atr || atr <= 0) return true
  return Math.abs(price - ref) <= maxAtr * atr
}
