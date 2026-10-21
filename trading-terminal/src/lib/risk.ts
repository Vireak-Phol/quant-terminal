/** Position sizing and staleness.
 *
 *  Sizing is derived from the V6 ATR stop rather than from a fixed lot, because a
 *  fixed lot silently doubles risk when volatility doubles. Equity and risk-%
 *  are user inputs held in preferences — this module is pure arithmetic and holds
 *  no state.
 *
 *  This is a sizing aid for a discretionary process, not a risk system of record.
 */

export interface SizingInput {
  equity: number
  /** Percent of equity risked on the trade, e.g. 0.5 for half a percent. */
  riskPct: number
  entry: number
  stop: number
  /** Units per contract/lot. 100 for a standard XAUUSD lot; 1 for cash equities. */
  contractSize?: number
}

export interface SizingResult {
  /** Currency at risk if the stop fills. */
  riskAmount: number
  /** Price distance to the stop. */
  stopDistance: number
  /** Risk per single unit of the instrument. */
  riskPerUnit: number
  /** Raw units the risk budget affords. */
  units: number
  /** Units expressed in lots/contracts. */
  lots: number
  /** Gross exposure at entry. */
  notional: number
  /** Notional as a multiple of equity — the leverage the size implies. */
  leverage: number
  valid: boolean
}

export function sizePosition(i: SizingInput): SizingResult {
  const contractSize = i.contractSize && i.contractSize > 0 ? i.contractSize : 1
  const stopDistance = Math.abs(i.entry - i.stop)
  const riskAmount = i.equity * (i.riskPct / 100)
  const valid =
    Number.isFinite(stopDistance) &&
    stopDistance > 0 &&
    Number.isFinite(riskAmount) &&
    riskAmount > 0 &&
    Number.isFinite(i.entry)

  if (!valid) {
    return {
      riskAmount: Math.max(0, riskAmount || 0),
      stopDistance: 0,
      riskPerUnit: 0,
      units: 0,
      lots: 0,
      notional: 0,
      leverage: 0,
      valid: false,
    }
  }

  const units = riskAmount / stopDistance
  const notional = units * i.entry
  return {
    riskAmount,
    stopDistance,
    riskPerUnit: stopDistance,
    units,
    lots: units / contractSize,
    notional,
    leverage: i.equity > 0 ? notional / i.equity : 0,
    valid: true,
  }
}

/** Reward:risk for a target, and the win rate that target needs to break even.
 *  The breakeven figure is the honest counterweight to a big R:R — 3:1 looks
 *  free until you see it still needs one in four to land. */
export function rMultiple(entry: number, stop: number, target: number) {
  const risk = Math.abs(entry - stop)
  const reward = Math.abs(target - entry)
  const r = risk > 0 ? reward / risk : 0
  return {
    r,
    breakevenWinRate: r > 0 ? (1 / (1 + r)) * 100 : 100,
  }
}

/** Expectancy in R, given a win probability. Lets the V6 win-prob be checked
 *  against the plan's geometry instead of taken on faith. */
export function expectancyR(winProbPct: number, r: number): number {
  const p = Math.min(1, Math.max(0, winProbPct / 100))
  return p * r - (1 - p) * 1
}

export type Staleness = 'live' | 'recent' | 'stale' | 'unknown'

export interface StalenessState {
  level: Staleness
  ageMinutes: number | null
  label: string
  tone: 'bull' | 'warn' | 'bear' | 'muted'
}

/** Age of a snapshot. A number whose age you cannot see is a number you cannot
 *  act on, which is why this drives a permanent fixture in the status bar. */
export function stalenessOf(asOf: string | undefined, now: Date): StalenessState {
  if (!asOf) {
    return {
      level: 'unknown',
      ageMinutes: null,
      label: 'No timestamp',
      tone: 'muted',
    }
  }
  const t = new Date(asOf)
  if (Number.isNaN(t.getTime())) {
    return { level: 'unknown', ageMinutes: null, label: 'Bad timestamp', tone: 'muted' }
  }
  const ageMinutes = (now.getTime() - t.getTime()) / 60000
  if (ageMinutes < 5) return { level: 'live', ageMinutes, label: 'Live', tone: 'bull' }
  if (ageMinutes < 30) return { level: 'recent', ageMinutes, label: 'Recent', tone: 'warn' }
  return { level: 'stale', ageMinutes, label: 'Stale', tone: 'bear' }
}
