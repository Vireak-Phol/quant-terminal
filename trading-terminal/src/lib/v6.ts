import type { V6Engine, V6Tier } from '../types/analysis'

/** OSC-VIP V6 Bayesian tier engine.
 *
 *  This is the single authoritative implementation of the rules specified in
 *  `.agents/AGENTS.md` §2–§4. The Pine indicator owns signal *generation*; this
 *  owns signal *classification* for display. Keeping it in one module — rather
 *  than scattered across panel components — is what makes the terminal's verdict
 *  auditable: there is exactly one place to read, and one place to correct.
 *
 *  Thresholds are named constants, not inline numbers, because they are the
 *  calibration surface of the whole system.
 */

/** A+ Harmonized Execution floor (`minAplusWinProb`). */
export const A_PLUS_FLOOR = 65.0
/** Structural-Only floor. Below this is trap/friction territory. */
export const STRUCTURAL_FLOOR = 50.0
/** An opposing signal at or above this suppresses A+ elevation (§3.1). */
export const CONFLICT_FLOOR = 55.0

/** ATR multiples for the A+ execution plan (§2, Tier 1). */
export const SL_ATR_MULT = 1.5
export const TP1_ATR_MULT = 2.0
export const TP2_ATR_MULT = 3.5

/** Kaufman Efficiency Ratio regime bounds (§4). */
export const ER_TRENDING = 0.45
export const ER_RANGING = 0.2

export type Side = 'long' | 'short'

/** One A+ prerequisite and whether this snapshot satisfies it. */
export interface Prereq {
  id: 'bar_confirmed' | 'killzone' | 'shock_guard' | 'volume_gate' | 'no_conflict'
  label: string
  pass: boolean
  /** Shown when `pass` is false — the actual observed value. */
  detail: string
}

export interface SideAssessment {
  side: Side
  winProb: number
  tier: V6Tier
  /** Plain-language verdict, e.g. "A+ suppressed — opposing side 57.0% ≥ 55.0%". */
  reason: string
  /** True when the raw probability cleared A+ but a prerequisite blocked it. */
  suppressed: boolean
  prereqs: Prereq[]
  /** Suggested risk fraction: 1.0 for A+, 0.5 for Structural, 0 for Trap (§2). */
  sizeFactor: number
}

export interface TradePlan {
  side: Side
  entry: number
  stop: number
  tp1: number
  tp2: number
  riskPerUnit: number
  rrTp1: number
  rrTp2: number
}

export interface Regime {
  /** Kaufman ER classification. */
  kind: 'trending' | 'ranging' | 'transitional'
  erVal: number
  /** Which setup family the regime favours (§4). */
  favours: string
  smpi: number
  smpiSide: Side | 'flat'
  htfTrend: V6Engine['htf_trend']
}

export interface V6Assessment {
  long: SideAssessment
  short: SideAssessment
  /** Higher-probability side — the one to act on, per §3.2. */
  primary: SideAssessment
  /** Lower-probability side. Disregarded entirely when below CONFLICT_FLOOR (§3.3). */
  counter: SideAssessment
  /** True when the macro shock guard mutes every signal (§4). */
  muted: boolean
  /** Whether the primary side is actionable at all. */
  actionable: boolean
  regime: Regime
  /** Non-null only for actionable sides with a usable ATR and entry price. */
  plan: TradePlan | null
  /** Count of REG-V6 structural confluences present (§5). */
  confluenceCount: number
  confluences: { id: string; label: string; present: boolean }[]
}

function tierFromProb(p: number): V6Tier {
  if (p >= A_PLUS_FLOOR) return 'a_plus'
  if (p >= STRUCTURAL_FLOOR) return 'structural'
  return 'trap'
}

export function tierLabel(t: V6Tier): string {
  switch (t) {
    case 'a_plus':
      return 'A+'
    case 'structural':
      return 'Structural'
    case 'trap':
      return 'Trap'
    default:
      return 'None'
  }
}

/** Maps a tier to the semantic colour token family used by the UI. */
export function tierTone(t: V6Tier): 'bull' | 'warn' | 'bear' | 'muted' {
  switch (t) {
    case 'a_plus':
      return 'bull'
    case 'structural':
      return 'warn'
    case 'trap':
      return 'bear'
    default:
      return 'muted'
  }
}

const KILLZONE_LABEL: Record<string, string> = {
  london: 'London (02:00–05:00 NY)',
  ny_am: 'NY AM (08:30–11:00 NY)',
  asia: 'Asia (20:00–00:00 NY)',
  none: 'Outside killzone',
}

function assessSide(side: Side, v6: V6Engine): SideAssessment {
  const winProb = side === 'long' ? v6.long_win_prob : v6.short_win_prob
  const opposing = side === 'long' ? v6.short_win_prob : v6.long_win_prob

  const prereqs: Prereq[] = [
    {
      id: 'bar_confirmed',
      label: 'Bar confirmed',
      pass: v6.bar_confirmed,
      detail: v6.bar_confirmed ? 'closed' : 'signal still forming — repaint risk',
    },
    {
      id: 'killzone',
      label: 'Active killzone',
      pass: v6.killzone !== 'none',
      detail: KILLZONE_LABEL[v6.killzone] ?? v6.killzone,
    },
    {
      id: 'shock_guard',
      label: 'No macro shock',
      pass: !v6.shock_guard,
      detail: v6.shock_guard ? 'shock guard ACTIVE — signals muted' : 'clear',
    },
    {
      id: 'volume_gate',
      label: 'Volume gate (volZ > 0)',
      pass: v6.vol_z > 0,
      detail: `volZ ${v6.vol_z.toFixed(2)}`,
    },
    {
      id: 'no_conflict',
      label: `No directional conflict (opp < ${CONFLICT_FLOOR}%)`,
      pass: opposing < CONFLICT_FLOOR,
      detail: `opposing side ${opposing.toFixed(1)}%`,
    },
  ]

  // The shock guard is absolute: it mutes signals outright rather than demoting
  // them, because the volatility spike invalidates the probability estimate
  // itself, not just the entry quality.
  if (v6.shock_guard) {
    return {
      side,
      winProb,
      tier: 'none',
      reason: 'Muted — macro shock guard active (tr > 3.5 × atr100 within 15 bars)',
      suppressed: true,
      prereqs,
      sizeFactor: 0,
    }
  }

  const raw = tierFromProb(winProb)

  if (raw === 'trap') {
    return {
      side,
      winProb,
      tier: 'trap',
      reason: `Trap / friction — ${winProb.toFixed(1)}% below ${STRUCTURAL_FLOOR}% floor. Do not trade.`,
      suppressed: false,
      prereqs,
      sizeFactor: 0,
    }
  }

  if (raw === 'structural') {
    return {
      side,
      winProb,
      tier: 'structural',
      reason: `Structural-only — ${winProb.toFixed(1)}% in ${STRUCTURAL_FLOOR}–${A_PLUS_FLOOR}% band. Half size, or require REG-V6 confluence.`,
      suppressed: false,
      prereqs,
      sizeFactor: 0.5,
    }
  }

  // Cleared the A+ floor on probability alone — now the gates.
  const failed = prereqs.filter((p) => !p.pass)
  if (failed.length > 0) {
    const blocker = failed[0]
    return {
      side,
      winProb,
      tier: 'structural',
      reason: `A+ suppressed — ${blocker.label} failed (${blocker.detail}). Demoted to Structural.`,
      suppressed: true,
      prereqs,
      sizeFactor: 0.5,
    }
  }

  return {
    side,
    winProb,
    tier: 'a_plus',
    reason: `A+ Harmonized Execution — ${winProb.toFixed(1)}% ≥ ${A_PLUS_FLOOR}%, all gates clear.`,
    suppressed: false,
    prereqs,
    sizeFactor: 1,
  }
}

function assessRegime(v6: V6Engine): Regime {
  const er = v6.er_val
  const kind = er > ER_TRENDING ? 'trending' : er < ER_RANGING ? 'ranging' : 'transitional'
  const favours =
    kind === 'trending'
      ? 'Trend continuation — CHoCH / RegOB breaks'
      : kind === 'ranging'
        ? 'Mean reversion — VWAP-Z extremes, RPD peaks/valleys'
        : 'Mixed — no regime edge, demand stronger confluence'
  return {
    kind,
    erVal: er,
    favours,
    smpi: v6.smpi,
    smpiSide: v6.smpi > 0 ? 'long' : v6.smpi < 0 ? 'short' : 'flat',
    htfTrend: v6.htf_trend,
  }
}

function buildPlan(side: Side, entry: number, atr: number): TradePlan | null {
  if (!Number.isFinite(entry) || !Number.isFinite(atr) || atr <= 0) return null
  const dir = side === 'long' ? 1 : -1
  const risk = SL_ATR_MULT * atr
  return {
    side,
    entry,
    stop: entry - dir * risk,
    tp1: entry + dir * TP1_ATR_MULT * atr,
    tp2: entry + dir * TP2_ATR_MULT * atr,
    riskPerUnit: risk,
    rrTp1: TP1_ATR_MULT / SL_ATR_MULT,
    rrTp2: TP2_ATR_MULT / SL_ATR_MULT,
  }
}

/** Full V6 verdict for a snapshot. `entry` is the last traded price; without it
 *  the tier logic still resolves but no trade plan can be produced. */
export function assessV6(v6: V6Engine, entry?: number): V6Assessment {
  const long = assessSide('long', v6)
  const short = assessSide('short', v6)

  const primary = long.winProb >= short.winProb ? long : short
  const counter = primary === long ? short : long

  const reg = v6.reg_v6 ?? {}
  const confluences = [
    { id: 'unicorn', label: 'Unicorn (FVG + Breaker)', present: !!reg.unicorn },
    { id: 'reg_ob', label: 'RegOB break / bounce', present: !!reg.reg_ob },
    { id: 'rpd', label: 'RPD reversal', present: !!reg.rpd },
    { id: 'sweep', label: '20-bar liquidity sweep', present: !!reg.sweep },
  ]

  const actionable = !v6.shock_guard && (primary.tier === 'a_plus' || primary.tier === 'structural')

  return {
    long,
    short,
    primary,
    counter,
    muted: v6.shock_guard,
    actionable,
    regime: assessRegime(v6),
    plan: actionable && entry != null ? buildPlan(primary.side, entry, v6.atr) : null,
    confluenceCount: confluences.filter((c) => c.present).length,
    confluences,
  }
}

/** Tier for a watchlist row, which carries only the two probabilities and so
 *  cannot evaluate the environmental gates. Deliberately optimistic — the
 *  blotter shows the *candidate* tier and the V6 tab shows the adjudicated one. */
export function quickTier(longProb: number, shortProb: number): { tier: V6Tier; side: Side } {
  const side: Side = longProb >= shortProb ? 'long' : 'short'
  const p = Math.max(longProb, shortProb)
  const opp = Math.min(longProb, shortProb)
  // Conflict suppression is the one gate that is computable from probabilities alone.
  const tier = p >= A_PLUS_FLOOR && opp >= CONFLICT_FLOOR ? 'structural' : tierFromProb(p)
  return { tier, side }
}
