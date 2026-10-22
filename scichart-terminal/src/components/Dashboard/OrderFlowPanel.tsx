import { memo, useEffect, useState } from 'react'
import { useLiveField } from '../../hooks/useLiveField'
import type { BubbleSignalData, BubbleRegime } from '../../hooks/useLiveOrderBook'

export interface OrderFlowPanelProps {
  onClose?: () => void
}

/** Visual identity for each classified sweep regime. Colour + glyph + a short
 *  desk label so the tape reason survives a glance (and greyscale/CVD). */
const REGIME_META: Record<
  BubbleRegime,
  { label: string; glyph: string; dot: string; text: string; border: string }
> = {
  institutional_absorption_open: {
    label: 'ABSORPTION OPEN',
    glyph: '🧱',
    dot: 'bg-cyan-400',
    text: 'text-cyan-300',
    border: 'border-cyan-500/40',
  },
  liquidation_exhaustion_flush: {
    label: 'LIQ FLUSH',
    glyph: '💥',
    dot: 'bg-rose-400',
    text: 'text-rose-300',
    border: 'border-rose-500/40',
  },
  vacuum_sweep_breakout: {
    label: 'VACUUM SWEEP',
    glyph: '🚀',
    dot: 'bg-terminal-gold',
    text: 'text-terminal-gold',
    border: 'border-terminal-gold/40',
  },
  standard_flow: {
    label: 'STANDARD FLOW',
    glyph: '·',
    dot: 'bg-terminal-text-dim',
    text: 'text-terminal-text-dim',
    border: 'border-terminal-border/50',
  },
}

function fmtQty(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1000) return `${(v / 1000).toFixed(2)}k`
  return v.toFixed(1)
}

function fmtSigned(v: number, dp = 1): string {
  const sign = v > 0 ? '+' : ''
  return `${sign}${fmtQtyDp(v, dp)}`
}

function fmtQtyDp(v: number, dp: number): string {
  const abs = Math.abs(v)
  if (abs >= 1000) return `${(v / 1000).toFixed(2)}k`
  return v.toFixed(dp)
}

function timeAgo(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h`
}

/** Positioning & Delta card.
 *
 *  CVD updates on every trade (12-15 fps). Keeping it inside the main panel's
 *  equality check forced the whole sweep feed to re-render, reverse arrays and
 *  recompute the DOM at full WebSocket rate (Audit #5). This memoized
 *  sub-component owns its own granular `useLiveField` selector, so only this
 *  small card re-renders on CVD/OI ticks — the sweep feed re-renders only when
 *  the bubble list actually changes. */
const PositioningCard = memo(function PositioningCard() {
  const p = useLiveField(
    (snap) => {
      const d = snap.data
      return {
        oi: d?.open_interest ?? null,
        oiDelta: d?.oi_delta ?? null,
        cvd: d?.cvd ?? null,
      }
    },
    (a, b) => a.oi === b.oi && a.oiDelta === b.oiDelta && a.cvd === b.cvd,
  )

  const oiToneClass =
    p.oiDelta == null
      ? 'text-terminal-text-dim'
      : p.oiDelta > 0
        ? 'text-terminal-bull'
        : p.oiDelta < 0
          ? 'text-terminal-bear'
          : 'text-terminal-gold'
  const cvdTone =
    p.cvd == null
      ? 'text-terminal-text-dim'
      : p.cvd > 0
        ? 'text-terminal-bull'
        : p.cvd < 0
          ? 'text-terminal-bear'
          : 'text-terminal-gold'

  return (
    <div className="rounded-lg bg-terminal-panel border border-terminal-border p-3 space-y-2">
      <span className="text-2xs font-extrabold uppercase text-terminal-gold tracking-wider">
        Positioning & Delta
      </span>
      <div className="grid grid-cols-3 gap-2 text-2xs pt-1">
        <div className="bg-terminal-surface p-2 rounded border border-terminal-border/50">
          <span className="text-terminal-text-dim text-[10px] block">OPEN INTEREST</span>
          <span className="font-bold tabular-nums text-terminal-text">
            {p.oi == null ? '—' : fmtQty(p.oi)}
          </span>
        </div>
        <div className="bg-terminal-surface p-2 rounded border border-terminal-border/50">
          <span className="text-terminal-text-dim text-[10px] block">OI Δ</span>
          <span className={`font-bold tabular-nums ${oiToneClass}`}>
            {p.oiDelta == null ? '—' : fmtSigned(p.oiDelta)}
          </span>
        </div>
        <div className="bg-terminal-surface p-2 rounded border border-terminal-border/50">
          <span className="text-terminal-text-dim text-[10px] block">CVD</span>
          <span className={`font-bold tabular-nums ${cvdTone}`}>
            {p.cvd == null ? '—' : fmtSigned(p.cvd)}
          </span>
        </div>
      </div>
      {/* OI narrative hint */}
      {p.oiDelta != null && (
        <p className="text-[10px] text-terminal-text-dim pt-0.5 leading-tight">
          {p.oiDelta > 0
            ? '▲ OI rising — fresh positions opening into the flow.'
            : p.oiDelta < 0
              ? '▼ OI falling — positions closing / forced out.'
              : '↔ OI flat — no net positioning change.'}
        </p>
      )}
    </div>
  )
})

export function OrderFlowPanel({ onClose }: OrderFlowPanelProps) {
  // Low-frequency slice: only re-render when the bubble feed changes. CVD/OI are
  // intentionally NOT selected here — they live in <PositioningCard/> with their
  // own granular selector so high-frequency CVD ticks don't thrash the feed (#5).
  const s = useLiveField(
    (snap) => {
      const d = snap.data
      const bubbles = d?.bubbles ?? []
      // `bubblesRev` is a monotonic counter the bridge bumps once per emitted
      // sweep. Keying the equality check off it means a brand-new sweep is never
      // silently dropped — even at ring-buffer capacity (count === 40) when a
      // same-signature algorithmic fill repeats the newest entry (Audit #1). We
      // keep count as a cheap fallback for frames predating the rev field.
      return {
        rev: d?.bubblesRev ?? 0,
        count: bubbles.length,
        bubbles,
      }
    },
    (a, b) => a.rev === b.rev && a.count === b.count,
  )

  // Local 1s ticker so relative timestamps ("4s", "25s") keep advancing during
  // tape pauses, when no new frame arrives to trigger a render (Audit #8).
  const [, setNow] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Newest first for the feed.
  const feed: BubbleSignalData[] = [...s.bubbles].reverse()

  // Regime tallies for the summary strip.
  const counts = feed.reduce<Record<string, number>>((acc, b) => {
    acc[b.regime] = (acc[b.regime] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="flex flex-col h-full bg-terminal-surface/95 text-terminal-text font-mono text-xs select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-terminal-border/80 bg-terminal-panel/60 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-terminal-gold shadow-glow animate-pulse" />
          <span className="font-bold tracking-wider text-xs text-terminal-text uppercase">
            Order Flow · Bubble Regime
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-terminal-text-dim hover:text-terminal-text px-1 text-sm font-bold"
            title="Close Panel"
          >
            ✕
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {/* OI / CVD metrics — isolated in a memoized card so CVD ticks don't
            re-render the sweep feed (Audit #5). */}
        <PositioningCard />

        {/* Regime tally */}
        <div className="rounded-lg bg-terminal-panel border border-terminal-border p-3 space-y-2">
          <span className="text-2xs font-extrabold uppercase text-terminal-gold tracking-wider">
            Regime Tally (recent)
          </span>
          <div className="grid grid-cols-2 gap-1.5 pt-1">
            {(Object.keys(REGIME_META) as BubbleRegime[]).map((r) => {
              const meta = REGIME_META[r]
              return (
                <div
                  key={r}
                  className={`flex items-center justify-between gap-1 px-2 py-1 rounded bg-terminal-surface border ${meta.border}`}
                >
                  <span className={`flex items-center gap-1 text-[10px] font-bold ${meta.text}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                    {meta.label}
                  </span>
                  <span className="font-bold tabular-nums text-terminal-text">
                    {counts[r] ?? 0}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Bubble feed */}
        <div className="rounded-lg bg-terminal-panel border border-terminal-border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-2xs font-extrabold uppercase text-terminal-gold tracking-wider">
              Classified Sweeps
            </span>
            <span className="text-[10px] text-terminal-text-dim">{feed.length} events</span>
          </div>

          {feed.length === 0 ? (
            <p className="text-[11px] text-terminal-text-dim py-4 text-center">
              Waiting for aggressive sweeps…
            </p>
          ) : (
            <div className="space-y-1 pt-1">
              {feed.map((b, i) => {
                const meta = REGIME_META[b.regime] ?? REGIME_META.standard_flow
                const isBuy = b.aggressorSide === 'buy'
                const liq = Number(b.liquidationQuantity)
                return (
                  <div
                    key={`${b.timestamp}-${b.priceCenter}-${b.aggressorSide}-${b.totalQuantity}-${i}`}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded bg-terminal-surface border ${meta.border}`}
                  >
                    <span className="text-sm leading-none">{meta.glyph}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-[10px] font-bold truncate ${meta.text}`}>
                          {meta.label}
                        </span>
                        <span className="text-[10px] text-terminal-text-dim shrink-0">
                          {timeAgo(b.timestamp)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 pt-0.5">
                        <span
                          className={`text-[10px] font-bold ${
                            isBuy ? 'text-terminal-bull' : 'text-terminal-bear'
                          }`}
                        >
                          {isBuy ? '▲ BUY' : '▼ SELL'} {fmtQty(Number(b.totalQuantity))}
                        </span>
                        <span className="text-[10px] tabular-nums text-terminal-text">
                          @ {b.priceCenter}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 pt-0.5 text-[9px] text-terminal-text-dim tabular-nums">
                        <span title="Open interest change at sweep time">
                          OIΔ{' '}
                          <span
                            className={
                              b.oiDelta > 0
                                ? 'text-terminal-bull'
                                : b.oiDelta < 0
                                  ? 'text-terminal-bear'
                                  : ''
                            }
                          >
                            {fmtSigned(b.oiDelta)}
                          </span>
                        </span>
                        <span title="Price span of the sweep (USD)">span {b.sweepTicks.toFixed(2)}</span>
                        {liq > 0 && (
                          <span className="text-rose-300" title="Matched forced-liquidation volume">
                            liq {fmtQty(liq)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
