import { useState } from 'react'
import { useLiveOrderBook } from '../../hooks/useLiveOrderBook'

export interface DiagnosticsPanelProps {
  onClose?: () => void
}

export function DiagnosticsPanel({ onClose }: DiagnosticsPanelProps) {
  const { data: liveBook, connectionState, latencyMs, sendCommand } = useLiveOrderBook()
  const [replaySpeed, setReplaySpeed] = useState<number>(1.0)
  const [sessionName, setSessionName] = useState<string>('')

  const telemetry = liveBook?.telemetry

  const handleToggleRecord = () => {
    if (telemetry?.is_recording) {
      sendCommand('stop_recording')
    } else {
      sendCommand('start_recording', { name: sessionName || undefined })
    }
  }

  const handleSetSpeed = (s: number) => {
    setReplaySpeed(s)
    sendCommand('set_replay_speed', { speed: s })
  }

  return (
    <div className="flex flex-col h-full bg-terminal-surface/95 text-terminal-text font-mono text-xs select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-terminal-border/80 bg-terminal-panel/60 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-glow animate-pulse" />
          <span className="font-bold tracking-wider text-xs text-terminal-text uppercase">
            Diagnostics & Microstructure Health
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
        {/* Connection & Exchange Status Card */}
        <div className="rounded-lg bg-terminal-panel border border-terminal-border p-3 space-y-2">
          <span className="text-2xs font-extrabold uppercase text-terminal-gold tracking-wider">
            Exchange & Feed Status
          </span>
          <div className="grid grid-cols-2 gap-2 text-2xs pt-1">
            <div className="bg-terminal-surface p-2 rounded border border-terminal-border/50">
              <span className="text-terminal-text-dim text-[10px] block">CONNECTION</span>
              <span
                className={`font-bold uppercase ${
                  connectionState === 'connected' ? 'text-terminal-bull' : 'text-terminal-bear'
                }`}
              >
                {connectionState}
              </span>
            </div>
            <div className="bg-terminal-surface p-2 rounded border border-terminal-border/50">
              <span className="text-terminal-text-dim text-[10px] block">ORDER BOOK SYNC</span>
              <span
                className={`font-bold uppercase ${
                  telemetry?.order_book_sync_state === 'synchronized'
                    ? 'text-terminal-bull'
                    : 'text-terminal-gold'
                }`}
              >
                {telemetry?.order_book_sync_state || 'UNINITIALIZED'}
              </span>
            </div>
            <div className="bg-terminal-surface p-2 rounded border border-terminal-border/50">
              <span className="text-terminal-text-dim text-[10px] block">FEED LATENCY</span>
              <span className="font-bold tabular-nums text-terminal-text">
                {latencyMs} ms
              </span>
            </div>
            <div className="bg-terminal-surface p-2 rounded border border-terminal-border/50">
              <span className="text-terminal-text-dim text-[10px] block">RECONNECTS</span>
              <span className="font-bold tabular-nums text-terminal-text">
                {telemetry?.reconnect_count ?? 0}
              </span>
            </div>
            <div className="bg-terminal-surface p-2 rounded border border-terminal-border/50">
              <span className="text-terminal-text-dim text-[10px] block">SEQUENCE GAPS</span>
              <span className="font-bold tabular-nums text-terminal-text">
                {telemetry?.sequence_gaps_count ?? 0} recovered
              </span>
            </div>
            <div className="bg-terminal-surface p-2 rounded border border-terminal-border/50">
              <span className="text-terminal-text-dim text-[10px] block">EVENTS PROCESSED</span>
              <span className="font-bold tabular-nums text-terminal-text">
                {telemetry?.total_updates_processed ?? 0}
              </span>
            </div>
          </div>
        </div>

        {/* Microstructure Metrics Card */}
        <div className="rounded-lg bg-terminal-panel border border-terminal-border p-3 space-y-2">
          <span className="text-2xs font-extrabold uppercase text-terminal-gold tracking-wider">
            Microstructure Telemetry
          </span>
          <div className="space-y-1.5 text-2xs pt-1">
            <div className="flex justify-between items-center py-1 border-b border-terminal-border/40">
              <span className="text-terminal-text-dim">Contract:</span>
              <span className="font-bold text-terminal-text">Binance Futures XAUUSDT Perpetual</span>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-terminal-border/40">
              <span className="text-terminal-text-dim">Mark Price:</span>
              <span className="font-bold tabular-nums text-terminal-gold">
                ${liveBook?.mark_price ? liveBook.mark_price.toFixed(2) : '0.00'}
              </span>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-terminal-border/40">
              <span className="text-terminal-text-dim">Funding Rate:</span>
              <span className="font-bold tabular-nums text-cyan-400">
                {liveBook?.funding_rate ? `${(liveBook.funding_rate * 100).toFixed(4)}%` : '0.0000%'}
              </span>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-terminal-border/40">
              <span className="text-terminal-text-dim">Active Liquidity Zones:</span>
              <span className="font-bold text-terminal-text">
                {liveBook?.liquidity_zones?.filter((z) => z.status !== 'removed').length || 0}
              </span>
            </div>
            <div className="flex justify-between items-center py-1">
              <span className="text-terminal-text-dim">Recent Absorptions:</span>
              <span className="font-bold text-terminal-bull">
                {liveBook?.absorption_candidates?.length || 0} candidates
              </span>
            </div>
          </div>
        </div>

        {/* Local Recording & Replay Engine Controls */}
        <div className="rounded-lg bg-terminal-panel border border-terminal-border p-3 space-y-2">
          <span className="text-2xs font-extrabold uppercase text-terminal-gold tracking-wider">
            Market Data Recorder & Replay
          </span>

          <div className="pt-1 space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Session name (optional)"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                className="flex-1 bg-terminal-surface border border-terminal-border rounded px-2 py-1 text-2xs text-terminal-text outline-none focus:border-terminal-gold"
              />
              <button
                onClick={handleToggleRecord}
                className={`px-3 py-1 rounded font-bold text-2xs transition-all ${
                  telemetry?.is_recording
                    ? 'bg-rose-500 text-white animate-pulse'
                    : 'bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/40 hover:bg-terminal-gold/30'
                }`}
              >
                {telemetry?.is_recording ? '● STOP REC' : '◉ RECORD'}
              </button>
            </div>

            <div className="flex items-center justify-between pt-1 text-2xs text-terminal-text-dim">
              <span>Replay Speed:</span>
              <div className="flex items-center gap-1">
                {[1, 2, 5, 10].map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSetSpeed(s)}
                    className={`px-2 py-0.5 rounded font-bold ${
                      replaySpeed === s
                        ? 'bg-terminal-gold text-terminal-bg'
                        : 'bg-terminal-surface text-terminal-text-dim hover:text-terminal-text'
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
