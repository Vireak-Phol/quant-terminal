import { describe, it, expect } from 'vitest'
import { probabilityView, verdict, withinAtr, tagLabel, gateList } from './v74'
import { newAplusSignals } from './alerts'
import type { EngineSignal, ProbabilityEstimate, Stat, V74Frame } from '../types/v74'

const stat = (over: Partial<Stat> = {}): Stat => ({
  n: 120, wins: 70, win_rate: 58.1, raw_rate: 58.3, ci_lo: 49.4, ci_hi: 66.8, expectancy_r: 0.21, profit_factor: 1.4,
  avg_win_r: 1.2, avg_loss_r: -1.1, gross_expectancy_r: 0.4, gross_win_rate: 60, avg_cost_r: 0.19, ...over,
})

const est = (over: Partial<ProbabilityEstimate> = {}): ProbabilityEstimate => ({
  status: 'measured', source: 'backtest', bucket: 'FVG_Bull|A_PLUS', level: 'setup_tier', min_samples: 15,
  stat: stat(), backtest: stat(), live: null, ...over,
})

const sig = (over: Partial<EngineSignal> = {}): EngineSignal => ({
  id: 's1', tf: '5m', time: 1000, direction: 'LONG', tier: 'A_PLUS', setup: 'FVG_Bull', score: 70,
  probability: est(),
  plan: { direction: 'LONG', entry: 4000, stop: 3997, tp1: 4004, tp2: 4007, risk_per_unit: 3, cost_per_unit: 4.01, cost_r: 0.2,
    rr_tp1: 1.33, rr_tp2: 2.33, qty: 0.14, notional: 560, leverage: 5.6, risk_usd: 0.98, stop_basis: 'session_sigma', wall_price: null, flags: [] },
  tags: [], factors: [], orderflow: { tags: [], log_odds: 0, details: [] }, status: 'open', outcome: null, r_net: null, ...over,
})

describe('probabilityView', () => {
  it('shows measured win rate with CI and n', () => {
    const v = probabilityView(est())
    expect(v.kind).toBe('measured')
    expect(v.headline).toBe('58.1%')
    expect(v.sub).toContain('n=120')
    expect(v.negativeEdge).toBe(false)
  })
  it('never shows a percentage during warm-up', () => {
    const v = probabilityView(est({ status: 'warmup', stat: stat({ n: 7 }) }))
    expect(v.kind).toBe('warmup')
    expect(v.headline).not.toMatch(/%/)
    expect(v.sub).toContain('7/15')
    expect(v.value).toBeNull()
  })
  it('flags negative net expectancy', () => {
    expect(probabilityView(est({ stat: stat({ expectancy_r: -0.4 }) })).negativeEdge).toBe(true)
  })
})

describe('verdict', () => {
  it('go only for A+ with positive measured edge', () => {
    expect(verdict(sig()).level).toBe('go')
  })
  it('avoid when measured expectancy is negative', () => {
    expect(verdict(sig({ probability: est({ stat: stat({ expectancy_r: -2.2 }) }) })).level).toBe('avoid')
  })
  it('caution on warm-up, structural or oversize', () => {
    expect(verdict(sig({ probability: est({ status: 'warmup' }) })).level).toBe('caution')
    expect(verdict(sig({ tier: 'STRUCTURAL' })).level).toBe('caution')
    expect(verdict(sig({ plan: { ...sig().plan, flags: ['oversize'] } })).level).toBe('caution')
  })
  it('avoid on trap, idle without signal', () => {
    expect(verdict(sig({ tier: 'TRAP' })).level).toBe('avoid')
    expect(verdict(null).level).toBe('idle')
  })
})

describe('helpers', () => {
  it('withinAtr culls far levels', () => {
    expect(withinAtr(4010, 4000, 2, 12)).toBe(true)
    expect(withinAtr(4030, 4000, 2, 12)).toBe(false)
    expect(withinAtr(null, 4000, 2, 12)).toBe(false)
  })
  it('labels tags', () => {
    expect(tagLabel('of_wall_support')).toMatch(/wall/i)
    expect(tagLabel('session_ny_am')).toContain('NY AM')
  })
  it('gate list reflects frame gates', () => {
    const g = gateList({ tf: '5m', ready: true, gates: { killzone: true, long_no_conflict: false } }, 'long')
    expect(g.find((x) => x.label === 'Killzone')!.pass).toBe(true)
    expect(g.find((x) => x.label === 'No conflict')!.pass).toBe(false)
  })
})

describe('newAplusSignals', () => {
  const frame = (latest: EngineSignal[]): V74Frame =>
    ({ status: 'live', frames: { '5m': { tf: '5m', ready: true, latest } } } as unknown as V74Frame)

  it('ignores signals present on first load, then reports only new open A+', () => {
    const seen = new Set<string>()
    expect(newAplusSignals(frame([sig({ id: 'old' })]), seen, true)).toHaveLength(0)
    const out = newAplusSignals(frame([sig({ id: 'old' }), sig({ id: 'new' }), sig({ id: 'st', tier: 'STRUCTURAL' })]), seen, false)
    expect(out.map((s) => s.id)).toEqual(['new'])
    expect(newAplusSignals(frame([sig({ id: 'new' })]), seen, false)).toHaveLength(0)
  })
  it('does not alert warm-up history', () => {
    const seen = new Set<string>()
    newAplusSignals(frame([]), seen, true)
    expect(newAplusSignals(frame([sig({ id: 'h', status: 'history' })]), seen, false)).toHaveLength(0)
  })
})
