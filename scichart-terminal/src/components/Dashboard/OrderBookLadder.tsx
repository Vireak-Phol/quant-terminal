import { useMemo } from 'react'
import { useLiveOrderBook } from '../../hooks/useLiveOrderBook'
import { price } from '../../lib/format'

export interface OrderBookLadderProps {
  onClose?: () => void
  compact?: boolean
}

export function OrderBookLadder({ onClose, compact = false }: OrderBookLadderProps = {}) {
  const { data, connectionState, latencyMs } = useLiveOrderBook()

  const maxBidVol = useMemo(() => {
    if (!data || !data.bids.length) return 1
    return Math.max(...data.bids.map((b) => b.size), 0.1)
  }, [data])

  const maxAskVol = useMemo(() => {
    if (!data || !data.asks.length) return 1
    return Math.max(...data.asks.map((a) => a.size), 0.1)
  }, [data])

  return (
    <div
      className={`font-mono text-xs select-none ${
        compact
          ? 'h-full flex flex-col min-h-0 bg-terminal-surface/95 overflow-hidden'
          : 'bg-terminal-panel/90 border border-terminal-border/80 rounded-lg p-4 shadow-xl'
      }`}
    >
      {/* Top Header */}
      {compact ? (
        <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border/80 bg-terminal-panel shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-bold tracking-wider text-terminal-gold uppercase text-xs">
              L2 DOM LADDER
            </span>
            <span className="px-1.5 py-0.2 rounded text-[10px] bg-terminal-surface border border-terminal-border text-terminal-text-dim">
              DEPTH
            </span>
          </div>

          <div className="flex items-center gap-2">
            {data && (
              <span className="text-[10px] text-terminal-gold font-bold">
                SPR ${data.spread.toFixed(2)}
              </span>
            )}
            {onClose && (
              <button
                onClick={onClose}
                className="w-5 h-5 flex items-center justify-center rounded text-terminal-text-dim hover:text-terminal-text hover:bg-terminal-surface text-xs font-bold"
                title="Close DOM"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-terminal-border/60">
          <div className="flex items-center gap-2.5">
            <span className="font-bold tracking-wider text-terminal-gold uppercase text-sm">
              {data?.symbol || 'XAUUSD (L2 ORDER BOOK)'}
            </span>
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold bg-terminal-surface border border-terminal-border">
              <span
                className={`w-2 h-2 rounded-full ${
                  connectionState === 'connected'
                    ? 'bg-terminal-bull animate-pulse'
                    : connectionState === 'connecting'
                      ? 'bg-terminal-gold animate-bounce'
                      : 'bg-terminal-bear'
                }`}
              />
              <span className="uppercase text-terminal-text-dim">
                {connectionState === 'connected'
                  ? `LIVE 100ms (${latencyMs}ms)`
                  : connectionState === 'connecting'
                    ? 'Connecting...'
                    : 'Bridge Offline'}
              </span>
            </div>
          </div>
          {data && (
            <div className="flex items-center gap-4 text-2xs">
              <div>
                <span className="text-terminal-text-dim mr-1">SPREAD:</span>
                <span className="text-terminal-text font-bold">${data.spread.toFixed(2)}</span>
              </div>
              <div>
                <span className="text-terminal-text-dim mr-1">MID:</span>
                <span className="text-terminal-text font-bold">{price(data.mid_price)}</span>
              </div>
              <div>
                <span className="text-terminal-text-dim mr-1">FLOW:</span>
                <span
                  className={`font-bold uppercase px-1.5 py-0.5 rounded ${
                    data.v6_flow_signal === 'BULLISH_PRESSURE'
                      ? 'bg-terminal-bull/20 text-terminal-bull border border-terminal-bull/40'
                      : data.v6_flow_signal === 'BEARISH_PRESSURE'
                        ? 'bg-terminal-bear/20 text-terminal-bear border border-terminal-bear/40'
                        : 'bg-terminal-surface text-terminal-text-dim border border-terminal-border'
                  }`}
                >
                  {data.v6_flow_signal}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Disconnected Notice */}
      {connectionState !== 'connected' && (
        <div className="my-4 p-3 bg-terminal-surface/70 border border-dashed border-terminal-border rounded text-2xs text-terminal-text-dim">
          <p className="font-bold text-terminal-gold mb-1">Live OrderBook WebSocket Bridge is not connected.</p>
          <p>
            Start the local Gold L2 streaming daemon in terminal:
          </p>
          <code className="block mt-1 p-1.5 bg-black/40 text-terminal-text rounded">
            .venv/bin/python3 orderbook-bridge/bridge.py
          </code>
        </div>
      )}

      {/* Imbalance Meter */}
      {data && (
        <div className="my-3 py-2 px-3 bg-terminal-surface/40 rounded border border-terminal-border/40">
          <div className="flex justify-between items-center text-2xs mb-1.5">
            <span className="text-terminal-bull font-bold">
              BIDS: {data.top5_bid_vol.toFixed(2)} oz
            </span>
            <span className="text-terminal-text-dim uppercase tracking-wider font-semibold">
              OFI Imbalance: {data.imbalance > 0 ? `+${(data.imbalance * 100).toFixed(1)}%` : `${(data.imbalance * 100).toFixed(1)}%`}
            </span>
            <span className="text-terminal-bear font-bold">
              ASKS: {data.top5_ask_vol.toFixed(2)} oz
            </span>
          </div>
          {/* Visual Imbalance Bar */}
          <div className="w-full h-2 bg-terminal-surface rounded-full overflow-hidden flex">
            <div
              className="bg-terminal-bull transition-all duration-150"
              style={{ width: `${data.imbalance_score}%` }}
            />
            <div
              className="bg-terminal-bear transition-all duration-150"
              style={{ width: `${100 - data.imbalance_score}%` }}
            />
          </div>
        </div>
      )}

      {/* Dual Ladder Grid */}
      {data && (
        <div className={`mt-2 grid grid-cols-1 ${compact ? 'gap-2 overflow-y-auto flex-1' : 'lg:grid-cols-2 gap-3'}`}>
          {/* ASKS (Sells) Table */}
          <div className="bg-terminal-surface/30 rounded border border-terminal-border/50 p-2">
            <div className="flex justify-between text-2xs uppercase text-terminal-bear font-bold pb-1.5 border-b border-terminal-border/40">
              <span>Ask Price</span>
              <span>Size (oz)</span>
              <span>Cum. Depth</span>
            </div>
            <div className={`space-y-1 mt-1.5 overflow-y-auto ${compact ? 'max-h-40' : 'max-h-56'}`}>
              {data.asks.slice(0, 10).reverse().map((ask, idx) => {
                const depthPct = Math.min(100, (ask.size / maxAskVol) * 100)
                const isWall = data.resting_walls.some((w) => w.side === 'ask' && Math.abs(w.price - ask.price) < 0.05)
                return (
                  <div
                    key={idx}
                    className="relative flex justify-between items-center py-0.5 px-1.5 text-2xs rounded hover:bg-terminal-surface/60 group"
                  >
                    {/* Depth Fill Bar */}
                    <div
                      className="absolute right-0 top-0 bottom-0 bg-terminal-bear/15 rounded pointer-events-none transition-all duration-100"
                      style={{ width: `${depthPct}%` }}
                    />
                    <span className="font-bold text-terminal-bear z-10">
                      {ask.price.toFixed(2)}
                    </span>
                    <span className="text-terminal-text z-10 flex items-center gap-1">
                      {ask.size.toFixed(4)}
                      {isWall && (
                        <span className="text-[9px] px-1 bg-terminal-bear/30 text-terminal-bear border border-terminal-bear/50 rounded font-bold">
                          WALL
                        </span>
                      )}
                    </span>
                    <span className="text-terminal-text-dim text-[10px] z-10">
                      {ask.cumulative.toFixed(2)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* BIDS (Buys) Table */}
          <div className="bg-terminal-surface/30 rounded border border-terminal-border/50 p-2">
            <div className="flex justify-between text-2xs uppercase text-terminal-bull font-bold pb-1.5 border-b border-terminal-border/40">
              <span>Bid Price</span>
              <span>Size (oz)</span>
              <span>Cum. Depth</span>
            </div>
            <div className={`space-y-1 mt-1.5 overflow-y-auto ${compact ? 'max-h-40' : 'max-h-56'}`}>
              {data.bids.slice(0, 10).map((bid, idx) => {
                const depthPct = Math.min(100, (bid.size / maxBidVol) * 100)
                const isWall = data.resting_walls.some((w) => w.side === 'bid' && Math.abs(w.price - bid.price) < 0.05)
                return (
                  <div
                    key={idx}
                    className="relative flex justify-between items-center py-0.5 px-1.5 text-2xs rounded hover:bg-terminal-surface/60 group"
                  >
                    {/* Depth Fill Bar */}
                    <div
                      className="absolute left-0 top-0 bottom-0 bg-terminal-bull/15 rounded pointer-events-none transition-all duration-100"
                      style={{ width: `${depthPct}%` }}
                    />
                    <span className="font-bold text-terminal-bull z-10">
                      {bid.price.toFixed(2)}
                    </span>
                    <span className="text-terminal-text z-10 flex items-center gap-1">
                      {isWall && (
                        <span className="text-[9px] px-1 bg-terminal-bull/30 text-terminal-bull border border-terminal-bull/50 rounded font-bold">
                          WALL
                        </span>
                      )}
                      {bid.size.toFixed(4)}
                    </span>
                    <span className="text-terminal-text-dim text-[10px] z-10">
                      {bid.cumulative.toFixed(2)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Institutional Resting Walls / Liquidity Clusters summary */}
      {data && data.resting_walls.length > 0 && (
        <div className="mt-3 pt-2.5 border-t border-terminal-border/40 flex flex-wrap items-center gap-2 text-2xs">
          <span className="text-terminal-gold font-bold uppercase tracking-wider">
            Detected Institutional Resting Walls:
          </span>
          {data.resting_walls.map((wall, i) => (
            <span
              key={i}
              className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                wall.side === 'bid'
                  ? 'bg-terminal-bull/15 text-terminal-bull border-terminal-bull/40'
                  : 'bg-terminal-bear/15 text-terminal-bear border-terminal-bear/40'
              }`}
            >
              {wall.side.toUpperCase()} ${wall.price.toFixed(2)} ({wall.size.toFixed(2)} oz · {wall.multiple}x)
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
