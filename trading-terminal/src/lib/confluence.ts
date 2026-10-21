import type { DailyAnalysis } from '../types/analysis'
import { assessV6 } from './v6'

/** Composite confluence score.
 *
 *  A desk head does not want six dashboards; they want one number and the
 *  ability to ask why. This reduces the whole snapshot to a single 0–100
 *  directional score (50 = balanced) and returns the per-factor contributions
 *  that produced it, so the waterfall panel can show the derivation rather than
 *  asking the reader to trust a black box.
 *
 *  Weights are a judgement call, stated openly here rather than buried. They are
 *  NOT calibrated against realised outcomes — this is a discretionary awareness
 *  aid, and the score should be read as "how aligned is the evidence", not
 *  "what is the edge".
 */

export interface Factor {
  id: string
  label: string
  /** 0–100, where 50 is neutral and 100 is maximally bullish. */
  score: number
  weight: number
  /** score × weight, i.e. this factor's share of the composite. */
  contribution: number
  /** Signed distance from neutral, for the waterfall bars. */
  bias: number
  detail: string
}

export interface ConfluenceResult {
  /** 0–100. 50 is balanced. */
  score: number
  direction: 'bullish' | 'bearish' | 'neutral'
  /** How far from neutral, 0–100 — the conviction magnitude. */
  strength: number
  /** Count of factors agreeing with the net direction. */
  agreement: number
  total: number
  factors: Factor[]
}

const DIR_SCORE: Record<string, number> = {
  bullish: 100,
  positive: 100,
  bull: 100,
  rising: 100,
  above: 100,
  increasing: 75,
  neutral: 50,
  ranging: 50,
  flat: 50,
  at: 50,
  decreasing: 25,
  bearish: 0,
  negative: 0,
  bear: 0,
  falling: 0,
  below: 0,
}

const dirScore = (v: string | undefined): number => DIR_SCORE[v ?? ''] ?? 50

export function computeConfluence(d: DailyAnalysis): ConfluenceResult {
  const bm = d.big_money_analysis
  const tc = d.technical_confluence
  const factors: Factor[] = []

  const add = (id: string, label: string, score: number, weight: number, detail: string) => {
    factors.push({
      id,
      label,
      score: Math.max(0, Math.min(100, score)),
      weight,
      contribution: 0,
      bias: 0,
      detail,
    })
  }

  // Accumulation vs distribution as a share, not a raw score — the two fields are
  // not guaranteed to sum to 100 in user-supplied JSON.
  const acc = bm.institutional_flow.accumulation_score
  const dist = bm.institutional_flow.distribution_score
  const accShare = acc + dist > 0 ? (acc / (acc + dist)) * 100 : 50
  add('flow', 'Institutional flow', accShare, 0.22, `Acc ${acc} vs Dist ${dist}`)

  add(
    'orderflow',
    'Order flow imbalance',
    bm.order_flow_imbalance.imbalance_score,
    0.18,
    `Imbalance ${bm.order_flow_imbalance.imbalance_score}/100 · B/A ${bm.order_flow_imbalance.bid_ask_ratio.toFixed(2)}`,
  )

  add(
    'structure',
    'Market structure',
    dirScore(bm.smart_money_concepts.market_structure),
    0.16,
    `SMC ${bm.smart_money_concepts.market_structure}`,
  )

  const trendAvg =
    (dirScore(tc.trend.short_term) + dirScore(tc.trend.medium_term) + dirScore(tc.trend.long_term)) /
    3
  add(
    'trend',
    'Trend confluence',
    trendAvg,
    0.14,
    `${tc.trend.short_term} / ${tc.trend.medium_term} / ${tc.trend.long_term}`,
  )

  // RSI is already a 0–100 oscillator centred near 50; blend it with the MACD
  // cross state rather than treating either alone as momentum.
  const macdScore = dirScore(
    tc.momentum.macd === 'bullish_cross'
      ? 'bullish'
      : tc.momentum.macd === 'bearish_cross'
        ? 'bearish'
        : 'neutral',
  )
  add(
    'momentum',
    'Momentum',
    tc.momentum.rsi * 0.5 + macdScore * 0.5,
    0.12,
    `RSI ${tc.momentum.rsi} · MACD ${tc.momentum.macd.replace('_', ' ')}`,
  )

  add(
    'volume',
    'Volume / VWAP',
    dirScore(tc.volume_analysis.vwap_position),
    0.08,
    `VWAP ${tc.volume_analysis.vwap_position} · volume ${tc.volume_analysis.volume_trend}`,
  )

  // V6 only participates when the snapshot carries it, and only when the shock
  // guard is clear — a muted engine has no opinion and must not drag the
  // composite toward neutral as if it did.
  if (d.v6) {
    const a = assessV6(d.v6, d.meta?.last_price)
    if (!a.muted) {
      const signed = a.primary.side === 'long' ? a.primary.winProb : 100 - a.primary.winProb
      add(
        'v6',
        'V6 Bayesian engine',
        signed,
        0.18,
        `${a.primary.side} ${a.primary.winProb.toFixed(1)}% · ${a.primary.tier === 'a_plus' ? 'A+' : a.primary.tier}`,
      )
    }
  }

  // Renormalise so the composite stays 0–100 whichever factors were available.
  const weightSum = factors.reduce((s, f) => s + f.weight, 0) || 1
  let score = 0
  for (const f of factors) {
    const w = f.weight / weightSum
    f.weight = w
    f.contribution = f.score * w
    f.bias = (f.score - 50) * w
    score += f.contribution
  }

  const direction = score > 55 ? 'bullish' : score < 45 ? 'bearish' : 'neutral'
  const netUp = score >= 50
  const agreement = factors.filter((f) => (f.score >= 50) === netUp && f.score !== 50).length

  return {
    score,
    direction,
    strength: Math.abs(score - 50) * 2,
    agreement,
    total: factors.length,
    factors: factors.sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias)),
  }
}

/** Cross-symbol agreement, for the correlation/breadth read. Returns the share
 *  of the watchlist leaning each way — the risk-on / risk-off tell. */
export function breadthOf(rows: { bias: string; confidence: number }[]): {
  bullish: number
  bearish: number
  neutral: number
  netPct: number
  regime: 'risk-on' | 'risk-off' | 'mixed'
} {
  const n = rows.length || 1
  const bullish = rows.filter((r) => r.bias === 'bullish').length
  const bearish = rows.filter((r) => r.bias === 'bearish').length
  const neutral = n - bullish - bearish
  const netPct = ((bullish - bearish) / n) * 100
  return {
    bullish,
    bearish,
    neutral,
    netPct,
    regime: netPct > 25 ? 'risk-on' : netPct < -25 ? 'risk-off' : 'mixed',
  }
}
