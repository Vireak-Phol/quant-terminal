import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import React from 'react'
import { V7SignalPanel } from './V7SignalPanel'
import type { V74Frame } from '../../types/v74'

const risk = {
  account_equity: 100, risk_pct: 1, taker_fee_rate: 0.0005, slippage_ticks: 1, tick_size: 0.01, qty_step: 0.001, min_qty: 0.001,
  leverage_cap: 10, sl_mult: 1.5, tp1_mult: 2, tp2_mult: 3.5, min_risk_atr: 0.5, wall_anchor_atr: 0.5, wall_buffer_ticks: 5,
  horizon_bars: 20, max_trades_per_day: 5, daily_loss_limit_r: 3, max_consecutive_losses: 3, cost_heavy_r: 0.3,
}

const ctx = {
  regime: 'TRENDING', er: 0.5, killzone: 'NY_AM', active_killzone: true, kz_confirmed: true, shock_hard: false, shock_soft: false,
  htf_bull: true, htf_bear: false, htf_extension: 0.4, vwap_z: -1.8, smpi: 0.4, vol_z: 0.6, atr: 3.1, session_vol: 1.9,
  n_eff: 2.1, k_active: 3, r_bar: 0.2, dynamic_min: 65, eqs: 1, toxic_flow: false, ltf_ok: true, macro: 'neutral', trend_dir: 1, rpd_trend: 1,
}

const side = { score: 71, raw_score: 70, tier: 'A_PLUS', setup: 'FVG_Bull', has_setup: true, no_conflict: true, weights: {} }

function frame(over: Record<string, unknown> = {}, warnings: { code: string; message: string }[] = []): V74Frame {
  return {
    status: 'live', error: null, version: 1, symbol: 'XAUUSDT', macro: 'neutral', probability_basis: 'empirical', risk,
    guardrails: { warnings, trades_today: 0, r_today: 0, consecutive_losses: 0 },
    frames: {
      '5m': {
        tf: '5m', ready: true, context: ctx, gates: { min_history: true, killzone: true, no_shock: true, volume: true, long_no_conflict: true },
        long: side, short: { ...side, score: 30, tier: null, setup: null }, signals: [], latest: [],
        active_signal: {
          id: 'x', tf: '5m', time: Math.floor(Date.now() / 1000) - 60, direction: 'LONG', tier: 'A_PLUS', setup: 'FVG_Bull', score: 71,
          probability: { status: 'warmup', source: null, bucket: 'FVG_Bull|A_PLUS', level: 'setup_tier', min_samples: 15,
            stat: { n: 4 } as any, backtest: null, live: null },
          plan: { direction: 'LONG', entry: 4000, stop: 3997.15, tp1: 4003.8, tp2: 4006.65, risk_per_unit: 2.85, cost_per_unit: 4.01, cost_r: 1.4,
            rr_tp1: 1.33, rr_tp2: 2.33, qty: 0.145, notional: 580, leverage: 5.8, risk_usd: 0.99, stop_basis: 'session_sigma', wall_price: null, flags: ['cost_heavy'] },
          tags: ['htf_aligned', 'of_wall_support'], factors: [{ key: 'loc', label: 'Structure location', log_odds: 0.85 }],
          orderflow: { tags: [], log_odds: 0, details: [] }, status: 'open', outcome: null, r_net: null,
        },
        ...over,
      } as any,
    },
  }
}

describe('V7SignalPanel', () => {
  afterEach(cleanup)

  it('renders the active plan and a warm-up probability (no fake %)', () => {
    render(<V7SignalPanel v74={frame()} tf="5m" onTfChange={() => {}} />)
    expect(screen.getByText(/▲ LONG · A\+ Execution/)).toBeTruthy()
    expect(screen.getByText('Warm-up')).toBeTruthy()
    expect(screen.getByText(/n=4\/15/)).toBeTruthy()
    expect(screen.getByText('3,997.15')).toBeTruthy()
    expect(screen.getByText(/cost heavy/)).toBeTruthy()
    expect(screen.getByText(/Setup not yet measured/)).toBeTruthy()
  })

  it('marks order-flow tags as unmeasured', () => {
    render(<V7SignalPanel v74={frame()} tf="5m" onTfChange={() => {}} />)
    expect(screen.getByText(/Resting wall behind entry/).textContent).toContain('unmeasured')
  })

  it('shows soft guardrail warnings as an alert', () => {
    render(<V7SignalPanel v74={frame({}, [{ code: 'loss_streak', message: '3 losses in a row.' }])} tf="5m" onTfChange={() => {}} />)
    expect(screen.getByRole('alert').textContent).toContain('3 losses in a row')
  })

  it('shows warm-up and disconnected states', () => {
    const { rerender } = render(<V7SignalPanel v74={null} tf="5m" onTfChange={() => {}} />)
    expect(screen.getByText(/Bridge not connected/)).toBeTruthy()
    rerender(<V7SignalPanel v74={{ ...frame(), status: 'warming_up' }} tf="5m" onTfChange={() => {}} />)
    expect(screen.getByText(/Warming up engine/)).toBeTruthy()
  })

  it('timeframe switch and tabs are accessible buttons', () => {
    let tf = ''
    render(<V7SignalPanel v74={frame()} tf="5m" onTfChange={(t) => (tf = t)} />)
    fireEvent.click(screen.getByRole('button', { name: '15m' }))
    expect(tf).toBe('15m')
    fireEvent.click(screen.getByRole('tab', { name: 'risk' }))
    expect(screen.getByRole('form', { name: 'Risk settings' })).toBeTruthy()
  })
})
