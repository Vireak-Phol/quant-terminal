import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useLiveOrderBook } from '../../hooks/useLiveOrderBook'
import { price } from '../../lib/format'
import {
  TIER_LABEL,
  fmtPF,
  fmtR,
  gateList,
  isOrderflowTag,
  probabilityView,
  setupLabel,
  tagLabel,
  timeAgo,
  verdict,
} from '../../lib/v74'
import type {
  ChartTf,
  EngineSignal,
  LedgerSummaryRow,
  LedgerView,
  RiskConfigV74,
  SideView,
  TimeframeFrame,
  V74Frame,
} from '../../types/v74'

interface Props {
  v74?: V74Frame | null
  tf: ChartTf
  onTfChange: (tf: ChartTf) => void
  onClose?: () => void
}

type Tab = 'signal' | 'ledger' | 'risk'

export function V7SignalPanel({ v74, tf, onTfChange, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('signal')
  const fr = v74?.frames?.[tf]
  const warnings = v74?.guardrails?.warnings ?? []

  return (
    <div className="flex flex-col h-full bg-terminal-surface/95 text-terminal-text font-mono text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border/80 bg-terminal-card/60 shrink-0">
        <div className="flex items-center gap-2">
          <StatusDot status={v74?.status} />
          <h2 className="font-bold tracking-wider text-xs">v7.4 SIGNAL ENGINE</h2>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex rounded border border-terminal-border p-0.5" role="group" aria-label="Signal timeframe">
            {(['5m', '15m'] as const).map((t) => (
              <button
                key={t}
                onClick={() => onTfChange(t)}
                aria-pressed={tf === t}
                className={`px-1.5 py-0.5 rounded text-2xs font-bold ${tf === t ? 'bg-terminal-gold/20 text-terminal-gold' : 'text-terminal-text-dim hover:text-terminal-text'}`}
              >
                {t}
              </button>
            ))}
          </div>
          {onClose && (
            <button onClick={onClose} className="text-terminal-text-dim hover:text-terminal-text px-1 text-sm font-bold" aria-label="Close signal panel">
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="flex border-b border-terminal-border/60 shrink-0" role="tablist">
        {(['signal', 'ledger', 'risk'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 text-2xs font-bold uppercase tracking-wider ${tab === t ? 'text-terminal-gold border-b-2 border-terminal-gold' : 'text-terminal-text-dim hover:text-terminal-text'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {warnings.length > 0 && (
        <div role="alert" className="mx-3 mt-2 rounded border border-terminal-warn/60 bg-terminal-warn-deep/30 px-2.5 py-1.5 text-2xs text-terminal-warn space-y-0.5">
          {warnings.map((w) => (
            <p key={w.code}>⚠ {w.message}</p>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {!v74 ? (
          <Empty title="Bridge not connected" text="Start the bridge: PYTHONPATH=orderbook-bridge:. .venv/bin/python3 orderbook-bridge/bridge.py" />
        ) : v74.status === 'warming_up' ? (
          <Empty title="Warming up engine…" text="Replaying 30 days of XAUUSDT bars so every indicator matches its Pine state." />
        ) : v74.status === 'error' ? (
          <Empty title="Engine error" text={v74.error ?? 'unknown'} />
        ) : tab === 'signal' ? (
          <SignalTab fr={fr} />
        ) : tab === 'ledger' ? (
          <LedgerTab tf={tf} />
        ) : (
          <RiskTab risk={v74.risk} />
        )}
      </div>
      {v74?.status === 'degraded' && (
        <p className="px-3 py-1 text-2xs text-terminal-warn border-t border-terminal-border/60">Data degraded: {v74.error}</p>
      )}
    </div>
  )
}

function StatusDot({ status }: { status?: string }) {
  const cls = status === 'live' ? 'bg-terminal-bull animate-pulse' : status === 'degraded' || status === 'warming_up' ? 'bg-terminal-warn' : 'bg-terminal-bear'
  return <span className={`w-2 h-2 rounded-full ${cls}`} aria-label={`engine ${status ?? 'offline'}`} />
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="p-4 rounded-lg border border-terminal-border/60 bg-terminal-card/40 text-center space-y-1">
      <p className="font-bold text-xs">{title}</p>
      <p className="text-2xs text-terminal-text-dim break-words">{text}</p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal tab
// ─────────────────────────────────────────────────────────────────────────────
function SignalTab({ fr }: { fr?: TimeframeFrame }) {
  if (!fr || !fr.ready) return <Empty title="Collecting history" text="Engine needs 100 bars before scoring." />
  const sig = fr.active_signal ?? null
  const ctx = fr.context!
  return (
    <>
      <SignalCard sig={sig} />
      <div className="grid grid-cols-2 gap-2">
        <SideCard title="LONG" side={fr.long!} gates={gateList(fr, 'long')} bull />
        <SideCard title="SHORT" side={fr.short!} gates={gateList(fr, 'short')} />
      </div>
      <ContextCard fr={fr} />
      <RecentSignals fr={fr} />
      <p className="text-2xs text-terminal-text-dim leading-relaxed">
        Win rates are measured on closed ledger trades after fees + slippage (Beta-smoothed, Wilson 95% CI). Model scores are
        internal ranking only. Macro feed: {ctx.macro}. Signals only — not financial advice.
      </p>
    </>
  )
}

function SignalCard({ sig }: { sig: EngineSignal | null }) {
  const v = verdict(sig)
  if (!sig) {
    return (
      <div className="p-3 rounded-lg border border-terminal-border/60 bg-terminal-card/40 text-center">
        <p className="font-bold">No open A+/Structural signal</p>
        <p className="text-2xs text-terminal-text-dim mt-1">{v.text}</p>
      </div>
    )
  }
  const long = sig.direction === 'LONG'
  const pv = probabilityView(sig.probability)
  const p = sig.plan
  const tone = v.level === 'go' ? 'border-terminal-bull/60' : v.level === 'avoid' ? 'border-terminal-bear/60' : 'border-terminal-warn/60'
  return (
    <section aria-label="Active signal" className={`rounded-lg border-2 ${tone} bg-terminal-card/60 p-3 space-y-2.5`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className={`text-sm font-extrabold ${long ? 'text-terminal-bull' : 'text-terminal-bear'}`}>
            {long ? '▲ LONG' : '▼ SHORT'} · {TIER_LABEL[sig.tier]}
          </p>
          <p className="text-2xs text-terminal-text-dim">
            {setupLabel(sig.setup)} · {sig.tf} · {timeAgo(sig.time)}
          </p>
        </div>
        <ProbBadge pv={pv} />
      </div>

      <ProbBar pv={pv} />

      <div className="grid grid-cols-4 gap-1.5 text-center">
        <Level label="Entry" value={price(p.entry)} />
        <Level label="Stop" value={price(p.stop)} cls="text-terminal-bear" />
        <Level label="TP1" value={price(p.tp1)} cls="text-terminal-bull" />
        <Level label="TP2" value={price(p.tp2)} cls="text-terminal-bull" />
      </div>
      <div className="grid grid-cols-4 gap-1.5 text-center">
        <Level label="Size" value={`${p.qty} oz`} />
        <Level label="Risk" value={`$${p.risk_usd.toFixed(2)}`} />
        <Level label="R:R" value={`${p.rr_tp1} / ${p.rr_tp2}`} />
        <Level label="Cost" value={`${p.cost_r.toFixed(2)}R`} cls={p.cost_r > 0.3 ? 'text-terminal-warn' : ''} />
      </div>
      <p className="text-2xs text-terminal-text-dim">
        Stop basis: {p.stop_basis === 'wall' ? `behind resting wall @ ${price(p.wall_price)}` : p.stop_basis === 'session_sigma' ? '1.5× session σ' : '1.5× ATR'} ·
        leverage {p.leverage}×
      </p>
      {p.flags.length > 0 && (
        <p className="text-2xs text-terminal-warn">⚠ {p.flags.map((f) => f.replace('_', ' ')).join(' · ')}</p>
      )}

      <p
        className={`text-2xs font-semibold rounded px-2 py-1 ${
          v.level === 'go' ? 'bg-terminal-bull-deep/40 text-terminal-bull' : v.level === 'avoid' ? 'bg-terminal-bear-deep/40 text-terminal-bear' : 'bg-terminal-warn-deep/40 text-terminal-warn'
        }`}
      >
        {v.level === 'go' ? '✔ ' : v.level === 'avoid' ? '✖ ' : '! '}
        {v.text}
      </p>

      <details>
        <summary className="cursor-pointer text-2xs text-terminal-text-dim hover:text-terminal-text">Why this signal ({sig.factors.length} factors, {sig.tags.length} tags)</summary>
        <div className="mt-1.5 space-y-0.5">
          {sig.factors.slice(0, 10).map((f) => (
            <div key={f.key} className="flex justify-between text-2xs">
              <span>{f.label}</span>
              <span className={f.log_odds >= 0 ? 'text-terminal-bull' : 'text-terminal-bear'}>
                {f.log_odds >= 0 ? '▲' : '▼'} {f.log_odds.toFixed(2)}
              </span>
            </div>
          ))}
          <div className="flex flex-wrap gap-1 pt-1.5">
            {sig.tags.map((t) => (
              <span key={t} className="px-1.5 py-0.5 rounded border border-terminal-border text-2xs">
                {tagLabel(t)}
                {isOrderflowTag(t) && <span className="text-terminal-warn"> · unmeasured</span>}
              </span>
            ))}
          </div>
        </div>
      </details>
    </section>
  )
}

function ProbBadge({ pv }: { pv: ReturnType<typeof probabilityView> }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wider text-terminal-text-dim">{pv.kind === 'measured' ? 'Measured win rate' : 'Win rate'}</p>
      <p className={`text-base font-extrabold tabular-nums ${pv.kind === 'measured' ? 'text-terminal-gold' : 'text-terminal-text-dim'}`}>{pv.headline}</p>
      <p className="text-[10px] text-terminal-text-dim">{pv.sub}</p>
      {pv.expectancy != null && (
        <p className={`text-2xs font-bold ${pv.expectancy > 0 ? 'text-terminal-bull' : 'text-terminal-bear'}`}>E {fmtR(pv.expectancy)} net</p>
      )}
    </div>
  )
}

function ProbBar({ pv }: { pv: ReturnType<typeof probabilityView> }) {
  if (pv.kind !== 'measured' || pv.ciLo == null || pv.ciHi == null || pv.value == null) return null
  return (
    <div
      className="relative h-2 rounded bg-terminal-bg border border-terminal-border/60"
      role="img"
      aria-label={`Win rate ${pv.value.toFixed(1)} percent, confidence interval ${pv.ciLo.toFixed(0)} to ${pv.ciHi.toFixed(0)} percent`}
    >
      <div className="absolute inset-y-0 bg-terminal-gold/30" style={{ left: `${pv.ciLo}%`, width: `${Math.max(1, pv.ciHi - pv.ciLo)}%` }} />
      <div className="absolute inset-y-0 w-0.5 bg-terminal-gold" style={{ left: `${pv.value}%` }} />
      <div className="absolute inset-y-0 w-px bg-terminal-text-dim/60" style={{ left: '50%' }} />
    </div>
  )
}

function Level({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded bg-terminal-bg/60 border border-terminal-border/40 py-1">
      <p className="text-[10px] uppercase text-terminal-text-dim">{label}</p>
      <p className={`text-2xs font-bold tabular-nums ${cls}`}>{value}</p>
    </div>
  )
}

function SideCard({ title, side, gates, bull }: { title: string; side: SideView; gates: { label: string; pass: boolean }[]; bull?: boolean }) {
  return (
    <div className="rounded-lg border border-terminal-border/60 bg-terminal-card/40 p-2 space-y-1">
      <div className="flex justify-between items-baseline">
        <span className={`font-bold text-2xs ${bull ? 'text-terminal-bull' : 'text-terminal-bear'}`}>{bull ? '▲' : '▼'} {title}</span>
        <span className="text-2xs tabular-nums" title="OSC model score (heuristic, not a probability)">
          score {side.score.toFixed(0)}
        </span>
      </div>
      <p className="text-2xs text-terminal-text-dim truncate">{side.setup ? setupLabel(side.setup) : 'no setup this bar'}</p>
      <ul className="space-y-0.5">
        {gates.map((g) => (
          <li key={g.label} className="flex justify-between text-[10px]">
            <span className="text-terminal-text-dim">{g.label}</span>
            <span className={g.pass ? 'text-terminal-bull' : 'text-terminal-bear'}>{g.pass ? '✔' : '✖'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ContextCard({ fr }: { fr: TimeframeFrame }) {
  const c = fr.context!
  const h = fr.structure?.hopla
  const rows: [string, string, string?][] = [
    ['Regime', `${c.regime} (ER ${c.er.toFixed(2)})`],
    ['Session', c.killzone.replace('_', ' ') + (c.kz_confirmed ? ' · vol✔' : '')],
    ['4H trend', c.htf_bull ? '▲ above EMA200' : c.htf_bear ? '▼ below EMA200' : '—', c.htf_bull ? 'text-terminal-bull' : c.htf_bear ? 'text-terminal-bear' : ''],
    ['Shock guard', c.shock_hard ? 'HARD — signals muted' : c.shock_soft ? 'cooldown' : 'clear', c.shock_hard ? 'text-terminal-bear' : c.shock_soft ? 'text-terminal-warn' : 'text-terminal-bull'],
    ['VWAP Z / SMPI', `${c.vwap_z.toFixed(2)} / ${c.smpi == null ? '—' : c.smpi.toFixed(2)}`],
    ['N_eff / k', `${c.n_eff.toFixed(2)} / ${c.k_active}`],
    ['A+ threshold', `${c.dynamic_min.toFixed(1)}`],
    ['ATR / sess σ', `${c.atr?.toFixed(2) ?? '—'} / ${c.session_vol?.toFixed(2) ?? '—'}`],
  ]
  if (h) rows.push(['Hopla 3 / 97', `${price(h.line_3)} / ${price(h.line_97)}`, h.in_discount || h.near_3 ? 'text-terminal-bull' : h.in_premium || h.near_97 ? 'text-terminal-bear' : ''])
  const s = fr.structure
  if (s?.vac_above != null || s?.vac_below != null) rows.push(['Vacuum ↑ / ↓', `${price(s?.vac_above)} / ${price(s?.vac_below)}`])
  return (
    <section aria-label="Market context" className="rounded-lg border border-terminal-border/60 bg-terminal-card/40 p-2">
      <p className="text-[10px] font-bold uppercase tracking-wider text-terminal-text-dim mb-1">Market context</p>
      <dl className="space-y-0.5">
        {rows.map(([k, v, cls]) => (
          <div key={k} className="flex justify-between text-2xs">
            <dt className="text-terminal-text-dim">{k}</dt>
            <dd className={`tabular-nums ${cls ?? ''}`}>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function RecentSignals({ fr }: { fr: TimeframeFrame }) {
  const list = (fr.signals ?? []).filter((s) => s.tier !== 'TRAP').slice(-8).reverse()
  if (!list.length) return null
  return (
    <section aria-label="Recent signals" className="rounded-lg border border-terminal-border/60 bg-terminal-card/40 p-2">
      <p className="text-[10px] font-bold uppercase tracking-wider text-terminal-text-dim mb-1">Recent signals</p>
      <ul className="space-y-0.5">
        {list.map((s) => (
          <li key={s.id} className="flex justify-between text-2xs">
            <span className={s.direction === 'LONG' ? 'text-terminal-bull' : 'text-terminal-bear'}>
              {s.direction === 'LONG' ? '▲' : '▼'} {s.tier === 'A_PLUS' ? 'A+' : 'S'} {setupLabel(s.setup)}
            </span>
            <span className="text-terminal-text-dim">
              {s.status === 'closed' ? `${s.outcome} ${fmtR(s.r_net)}` : s.status === 'history' ? 'replay' : 'open'} · {timeAgo(s.time)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger tab
// ─────────────────────────────────────────────────────────────────────────────
function LedgerTab({ tf }: { tf: ChartTf }) {
  const { socket, sendCommand, connectionState } = useLiveOrderBook()
  const [view, setView] = useState<LedgerView | null>(null)
  const [source, setSource] = useState<'backtest' | 'live'>('backtest')

  useEffect(() => socket.onReply((m) => { if (m.type === 'ledger') setView(m as unknown as LedgerView) }), [socket])
  const refresh = useCallback(() => sendCommand('get_ledger', { tf, limit: 50 }), [sendCommand, tf])
  useEffect(() => {
    if (connectionState !== 'connected') return
    refresh()
    const id = setInterval(refresh, 30_000)
    return () => clearInterval(id)
  }, [refresh, connectionState])

  const rows: LedgerSummaryRow[] = useMemo(() => (view?.summary[source] ?? []).filter((r) => r.tier !== 'TRAP' || source === 'backtest'), [view, source])
  if (!view) return <Empty title="Loading ledger…" text="Requesting measured results from the bridge." />
  const rel = view.reliability[tf] ?? []
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex rounded border border-terminal-border p-0.5" role="group" aria-label="Ledger source">
          {(['backtest', 'live'] as const).map((s) => (
            <button key={s} aria-pressed={source === s} onClick={() => setSource(s)} className={`px-2 py-0.5 rounded text-2xs font-bold ${source === s ? 'bg-terminal-gold/20 text-terminal-gold' : 'text-terminal-text-dim'}`}>
              {s} ({view.counts[s]})
            </button>
          ))}
        </div>
        <button onClick={refresh} className="text-2xs text-terminal-text-dim hover:text-terminal-text" aria-label="Refresh ledger">⟳ refresh</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-2xs">
          <caption className="sr-only">Measured results per setup and tier, net of costs</caption>
          <thead>
            <tr className="text-terminal-text-dim text-left">
              <th className="font-normal py-0.5">Setup</th>
              <th className="font-normal">Tier</th>
              <th className="font-normal text-right">n</th>
              <th className="font-normal text-right">Win%</th>
              <th className="font-normal text-right">E net</th>
              <th className="font-normal text-right">E gross</th>
              <th className="font-normal text-right">PF</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.setup}-${r.tier}`} className={`border-t border-terminal-border/30 ${r.warmup ? 'text-terminal-text-dim' : ''}`}>
                <td className="py-0.5">{setupLabel(r.setup)}</td>
                <td>{r.tier === 'A_PLUS' ? 'A+' : r.tier === 'STRUCTURAL' ? 'S' : 'T'}</td>
                <td className="text-right tabular-nums">{r.n}</td>
                <td className="text-right tabular-nums" title={`95% CI ${r.ci_lo}–${r.ci_hi}%`}>{r.warmup ? 'warm-up' : `${r.win_rate.toFixed(1)}`}</td>
                <td className={`text-right tabular-nums ${r.expectancy_r > 0 ? 'text-terminal-bull' : 'text-terminal-bear'}`}>{fmtR(r.expectancy_r)}</td>
                <td className={`text-right tabular-nums ${r.gross_expectancy_r > 0 ? 'text-terminal-bull' : 'text-terminal-bear'}`}>{fmtR(r.gross_expectancy_r)}</td>
                <td className="text-right tabular-nums">{fmtPF(r)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={7} className="py-2 text-center text-terminal-text-dim">No closed {source} records for {tf} yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {source === 'backtest' && rel.length > 0 && (
        <section aria-label="Reliability" className="rounded-lg border border-terminal-border/60 bg-terminal-card/40 p-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-terminal-text-dim mb-1">Model score vs measured win rate</p>
          <div className="flex items-end gap-0.5 h-16" role="img" aria-label="Bar chart of measured win rate per model score bin">
            {rel.map((b) => (
              <div key={b.score_bin} className="flex-1 flex flex-col items-center justify-end h-full" title={`score ${b.score_bin}-${b.score_bin + 5}: ${b.win_rate}% (n=${b.n})`}>
                <div className={`w-full ${b.expectancy_r > 0 ? 'bg-terminal-bull/70' : 'bg-terminal-bear/60'}`} style={{ height: `${Math.min(100, b.win_rate)}%` }} />
              </div>
            ))}
          </div>
          <p className="text-[10px] text-terminal-text-dim mt-1">A flat profile means the model score does not separate winners from losers on this data.</p>
        </section>
      )}
      {source === 'live' && view.recent.length > 0 && (
        <ul className="space-y-0.5">
          {view.recent.slice(0, 15).map((r) => (
            <li key={r.id} className="flex justify-between text-2xs">
              <span className={r.direction === 'LONG' ? 'text-terminal-bull' : 'text-terminal-bear'}>{r.direction === 'LONG' ? '▲' : '▼'} {setupLabel(r.setup)}</span>
              <span className="text-terminal-text-dim">{r.status === 'open' ? 'open' : `${r.outcome} ${fmtR(r.r_net)}`}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk tab
// ─────────────────────────────────────────────────────────────────────────────
const RISK_FIELDS: { key: keyof RiskConfigV74; label: string; step: number; min: number; max?: number; scale?: number; suffix?: string }[] = [
  { key: 'account_equity', label: 'Account equity', step: 10, min: 1, suffix: 'USDT' },
  { key: 'risk_pct', label: 'Risk per trade', step: 0.1, min: 0.1, max: 10, suffix: '%' },
  { key: 'taker_fee_rate', label: 'Fee per side', step: 0.001, min: 0, max: 0.5, scale: 100, suffix: '%' },
  { key: 'slippage_ticks', label: 'Slippage (round trip)', step: 1, min: 0, suffix: 'ticks' },
  { key: 'leverage_cap', label: 'Leverage cap', step: 1, min: 1, max: 125, suffix: '×' },
  { key: 'sl_mult', label: 'Stop (× session σ)', step: 0.1, min: 0.5, max: 5 },
  { key: 'tp1_mult', label: 'TP1 (× session σ)', step: 0.1, min: 0.5, max: 10 },
  { key: 'tp2_mult', label: 'TP2 (× session σ)', step: 0.1, min: 0.5, max: 15 },
  { key: 'horizon_bars', label: 'Ledger horizon', step: 1, min: 1, max: 200, suffix: 'bars' },
  { key: 'max_trades_per_day', label: 'Max A+ trades / day', step: 1, min: 1, max: 50 },
  { key: 'daily_loss_limit_r', label: 'Daily loss warning', step: 0.5, min: 0.5, max: 20, suffix: 'R' },
  { key: 'max_consecutive_losses', label: 'Loss streak warning', step: 1, min: 1, max: 20 },
]

function RiskTab({ risk }: { risk: RiskConfigV74 }) {
  const { socket, sendCommand } = useLiveOrderBook()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(
    () =>
      socket.onReply((m) => {
        if (m.type === 'risk_config') setMsg(m.ok ? 'Saved. New signals use these settings.' : `Rejected: ${String(m.error)}`)
      }),
    [socket],
  )
  const val = (f: (typeof RISK_FIELDS)[number]) => draft[f.key] ?? String(+((risk[f.key] as number) * (f.scale ?? 1)).toFixed(6))
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    const config: Record<string, number> = {}
    for (const f of RISK_FIELDS) {
      if (draft[f.key] === undefined) continue
      const n = Number(draft[f.key])
      if (!Number.isFinite(n) || n < f.min || (f.max != null && n > f.max)) {
        setMsg(`${f.label}: must be between ${f.min} and ${f.max ?? '∞'}`)
        return
      }
      config[f.key] = n / (f.scale ?? 1)
    }
    sendCommand('set_risk_config', { config })
    setDraft({})
  }
  const roundTrip = risk.taker_fee_rate * 2 * 100
  return (
    <form onSubmit={save} className="space-y-2" aria-label="Risk settings">
      {RISK_FIELDS.map((f) => (
        <label key={f.key} className="flex items-center justify-between gap-2 text-2xs">
          <span className="text-terminal-text-dim">{f.label}</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              step={f.step}
              min={f.min}
              max={f.max}
              value={val(f)}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              className="w-20 bg-terminal-bg border border-terminal-border rounded px-1.5 py-0.5 text-right tabular-nums focus:outline-none focus:border-terminal-gold"
            />
            <span className="w-8 text-terminal-text-dim">{f.suffix ?? ''}</span>
          </span>
        </label>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <button type="submit" className="px-3 py-1 rounded bg-terminal-gold/20 border border-terminal-gold/50 text-terminal-gold font-bold text-2xs">Save</button>
        {Object.keys(draft).length > 0 && (
          <button type="button" onClick={() => setDraft({})} className="text-2xs text-terminal-text-dim">Discard</button>
        )}
      </div>
      {msg && <p role="status" className="text-2xs text-terminal-text-dim">{msg}</p>}
      <p className="text-2xs text-terminal-text-dim leading-relaxed">
        Round-trip cost ≈ {roundTrip.toFixed(3)}% of price (≈ ${((risk.taker_fee_rate * 2) * 4000).toFixed(2)}/oz at $4,000) plus slippage.
        On short timeframes this can exceed the stop distance; using maker (limit) entries roughly halves it.
      </p>
    </form>
  )
}
