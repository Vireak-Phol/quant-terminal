import { DailyAnalysis } from '../types/analysis'

export const sampleAnalysis: DailyAnalysis = {
  date: '2026-07-29',
  market: 'NASDAQ',
  symbol: 'NVDA',
  big_money_analysis: {
    institutional_flow: {
      accumulation_score: 78,
      distribution_score: 22,
      net_institutional_flow: 'positive',
      large_blocks: [
        { time: '09:32', size: 850000, side: 'buy', significance: 'high' },
        { time: '10:15', size: 420000, side: 'buy', significance: 'medium' },
        { time: '11:45', size: 380000, side: 'sell', significance: 'medium' },
        { time: '13:20', size: 920000, side: 'buy', significance: 'high' },
        { time: '14:05', size: 210000, side: 'sell', significance: 'low' },
      ],
    },
    order_flow_imbalance: {
      bid_ask_ratio: 1.42,
      delta_volume: 2340000,
      cumulative_delta: 'rising',
      imbalance_score: 72,
    },
    liquidity_clusters: [
      { price: 118.40, type: 'support', strength: 'strong', volume_nodes: 18500 },
      { price: 121.60, type: 'resistance', strength: 'strong', volume_nodes: 16200 },
      { price: 116.80, type: 'support', strength: 'moderate', volume_nodes: 12800 },
      { price: 123.50, type: 'resistance', strength: 'moderate', volume_nodes: 9400 },
    ],
    professional_positioning: {
      put_call_ratio: 0.72,
      max_pain: 120.00,
      gamma_exposure: 1250000000,
      dealer_positioning: 'long_gamma',
    },
    smart_money_concepts: {
      market_structure: 'bullish',
      fair_value_gaps: [
        { price_low: 117.20, price_high: 117.85, status: 'unfilled' },
        { price_low: 115.40, price_high: 116.10, status: 'filled' },
        { price_low: 119.60, price_high: 120.25, status: 'unfilled' },
      ],
      order_blocks: [
        { price: 117.50, type: 'bullish', strength: 'strong' },
        { price: 121.80, type: 'bearish', strength: 'moderate' },
        { price: 115.80, type: 'bullish', strength: 'weak' },
      ],
      liquidity_sweeps: [
        { time: '09:50', price: 117.05, type: 'buy_side', result: 'reversal_up' },
        { time: '11:30', price: 121.20, type: 'sell_side', result: 'partial_reversal' },
        { time: '14:40', price: 118.60, type: 'buy_side', result: 'continuation_up' },
      ],
    },
    session_bias: {
      overall_bias: 'bullish',
      confidence: 74,
      key_levels: {
        resistance_r1: 121.60,
        resistance_r2: 123.50,
        support_s1: 118.40,
        support_s2: 116.80,
      },
      narrative:
        'Strong institutional accumulation detected with multiple large buy blocks executing above VWAP. Unfilled FVG at 117.20-117.85 acting as magnetic support. Positive delta divergence supports bullish bias. Key resistance at 121.60 (high-volume node) — break above opens path to 123.50. Risk below 116.80.',
    },
  },
  technical_confluence: {
    trend: { short_term: 'bullish', medium_term: 'bullish', long_term: 'bullish' },
    momentum: { rsi: 62, macd: 'bullish_cross', stochastic: 68 },
    volume_analysis: {
      volume_trend: 'increasing',
      vwap_position: 'above',
      volume_profile: 'poc_at_119.20',
    },
    support_resistance: { nearest_support: 118.40, nearest_resistance: 121.60 },
  },
  risk_assessment: {
    overall_risk: 'moderate',
    volatility_regime: 'normal',
    key_risks: ['NVDA earnings next week', 'Semiconductor sector rotation', 'Fed rate decision Aug 1'],
    position_sizing: 'standard',
  },
}
