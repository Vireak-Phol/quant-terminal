import React from 'react'
import { V7Signal, HoplaLevels, ActiveFVG } from '../../hooks/useLiveOrderBook'
import { price } from '../../lib/format'

interface V7SignalPanelProps {
  signal?: V7Signal | null
  hopla?: HoplaLevels
  activeFvgs?: ActiveFVG[]
  midPrice?: number
  onClose?: () => void
}

export function V7SignalPanel({
  signal,
  hopla,
  activeFvgs = [],
  midPrice = 0,
  onClose,
}: V7SignalPanelProps) {
  const isLong = signal?.direction === 'LONG'
  const isAplus = signal?.tier === 'TIER_1_A_PLUS'

  return (
    <div className="flex flex-col h-full bg-terminal-surface/95 text-terminal-text font-mono text-xs select-none">
      {/* Header Bar */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-terminal-border/80 bg-terminal-panel/60 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-terminal-gold shadow-glow animate-pulse" />
          <span className="font-bold tracking-wider text-xs text-terminal-text">
            v7.4 INSTITUTIONAL SIGNALS
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
        {/* Active Real-Time Signal Card */}
        {signal ? (
          <div
            className={`rounded-xl border p-3.5 shadow-xl transition-all ${
              isAplus
                ? isLong
                  ? 'bg-gradient-to-br from-emerald-950/40 via-terminal-panel to-terminal-surface border-emerald-500/50 shadow-emerald-950/30'
                  : 'bg-gradient-to-br from-rose-950/40 via-terminal-panel to-terminal-surface border-rose-500/50 shadow-rose-950/30'
                : 'bg-terminal-panel border-terminal-border shadow-xs'
            }`}
          >
            {/* Signal Title & Probability */}
            <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-terminal-border/60">
              <div className="flex items-center gap-2">
                <span
                  className={`px-2 py-0.5 rounded text-2xs font-extrabold uppercase tracking-wider ${
                    isLong
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                      : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                  }`}
                >
                  {signal.tier_label}
                </span>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-terminal-text-dim uppercase tracking-wider">
                  Win Probability
                </span>
                <p className="text-sm font-extrabold text-terminal-gold tabular-nums">
                  {signal.win_probability}%
                </p>
              </div>
            </div>

            {/* Execution Levels Grid */}
            <div className="grid grid-cols-2 gap-2 bg-terminal-surface/80 rounded-lg p-2.5 border border-terminal-border/50 text-2xs mb-3">
              <div>
                <span className="text-terminal-text-dim text-[10px] uppercase">ENTRY</span>
                <p className="font-bold text-terminal-text text-xs tabular-nums">
                  {price(signal.entry_price)}
                </p>
              </div>
              <div>
                <span className="text-terminal-text-dim text-[10px] uppercase">STOP LOSS</span>
                <p className="font-bold text-terminal-bear text-xs tabular-nums">
                  {price(signal.stop_loss)}
                </p>
              </div>
              <div>
                <span className="text-terminal-text-dim text-[10px] uppercase">TARGET 1 (TP1)</span>
                <p className="font-bold text-terminal-bull text-xs tabular-nums">
                  {price(signal.tp1)}
                </p>
              </div>
              <div>
                <span className="text-terminal-text-dim text-[10px] uppercase">R:R RATIO</span>
                <p className="font-bold text-terminal-gold text-xs tabular-nums">
                  {signal.risk_reward}R
                </p>
              </div>
            </div>

            {/* Wall Defense Protection Badge */}
            <div className="flex items-center justify-between text-2xs px-2.5 py-1.5 rounded bg-terminal-surface/60 border border-terminal-border/40 mb-3">
              <span className="text-terminal-text-dim">Anchored Behind Wall:</span>
              <span className="text-terminal-gold font-bold">
                ⚡ {signal.wall_size.toFixed(1)} oz @ ${signal.wall_price.toFixed(2)}
              </span>
            </div>

            {/* Confluence Breakdown */}
            <div>
              <p className="text-[10px] font-bold text-terminal-text-dim uppercase tracking-wider mb-1.5">
                Institutional Confluence (v7.4):
              </p>
              <div className="space-y-1">
                {signal.confluence_factors.map((factor, idx) => (
                  <div key={idx} className="flex items-start gap-1.5 text-2xs text-terminal-text">
                    <span className="text-emerald-400 font-bold shrink-0">✔</span>
                    <span>{factor}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-xl border border-terminal-border/60 bg-terminal-panel/40 text-center space-y-1.5">
            <div className="w-6 h-6 mx-auto rounded-full bg-terminal-surface flex items-center justify-center text-terminal-text-dim text-xs">
              ⏳
            </div>
            <p className="font-bold text-terminal-text text-xs">Scanning for A+ Confluence</p>
            <p className="text-2xs text-terminal-text-dim">
              Monitoring Hopla 3-97 PO3 boundaries, FVG retests, and L2 resting walls $\ge 2.5\times$
            </p>
          </div>
        )}

        {/* Hopla 3-97 PO3 Goldbach Dealing Range Card */}
        {hopla && hopla.line_3_disc && (
          <div className="rounded-xl border border-terminal-border/80 bg-terminal-panel/60 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-terminal-gold uppercase tracking-wider">
                HOPLA 3-97 PO3 DEALING RANGE
              </span>
              <span className="text-[10px] text-terminal-text-dim">27pt Macro Box</span>
            </div>

            <div className="space-y-1 text-2xs">
              <div className="flex items-center justify-between py-1 border-b border-terminal-border/40">
                <span className="text-rose-400 font-semibold flex items-center gap-1">
                  <span>97% Premium (Short)</span>
                </span>
                <span className="font-bold text-terminal-text tabular-nums">
                  ${hopla.line_97_prem?.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-terminal-border/40">
                <span className="text-terminal-text-dim">50% Equilibrium</span>
                <span className="text-terminal-text-dim tabular-nums">
                  ${hopla.line_50_eq?.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-emerald-400 font-semibold flex items-center gap-1">
                  <span>3% Discount (Long)</span>
                </span>
                <span className="font-bold text-terminal-text tabular-nums">
                  ${hopla.line_3_disc?.toFixed(2)}
                </span>
              </div>
            </div>

            {/* Proximity Pill */}
            {(hopla.at_discount || hopla.at_premium) && (
              <div
                className={`text-[10px] text-center font-bold py-1 px-2 rounded ${
                  hopla.at_discount
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 animate-pulse'
                    : 'bg-rose-500/20 text-rose-400 border border-rose-500/40 animate-pulse'
                }`}
              >
                {hopla.at_discount ? '🔥 AT 3% DISCOUNT ACCUMULATION ZONE' : '🔥 AT 97% PREMIUM DISTRIBUTION ZONE'}
              </div>
            )}
          </div>
        )}

        {/* Active FVGs Strip */}
        {activeFvgs.length > 0 && (
          <div className="rounded-xl border border-terminal-border/80 bg-terminal-panel/60 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-terminal-text-dim uppercase tracking-wider">
                ACTIVE 5M FAIR VALUE GAPS ({activeFvgs.length})
              </span>
            </div>
            <div className="space-y-1 text-2xs">
              {activeFvgs.slice(-4).map((fvg) => (
                <div
                  key={fvg.id}
                  className="flex items-center justify-between py-1 px-2 rounded bg-terminal-surface/60 border border-terminal-border/40"
                >
                  <span
                    className={`font-bold ${
                      fvg.side === 'bullish' ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {fvg.side === 'bullish' ? 'BULL FVG' : 'BEAR FVG'}
                  </span>
                  <span className="text-terminal-text-dim tabular-nums">
                    ${fvg.bottom.toFixed(2)} - ${fvg.top.toFixed(2)} (${fvg.size.toFixed(2)})
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
