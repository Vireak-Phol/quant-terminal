import React, { useRef, useEffect, useState, useMemo } from 'react'
import { useLiveOrderBook, RestingWall, PricePoint, TradePoint } from '../../hooks/useLiveOrderBook'
import { price } from '../../lib/format'

export interface BookmapChartProps {
  hideHeader?: boolean
}

export function BookmapChart({ hideHeader = false }: BookmapChartProps = {}) {
  const { data, connectionState, latencyMs } = useLiveOrderBook()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Zoom / View settings
  const [priceWindow, setPriceWindow] = useState<number>(3.0) // +/- dollars from mid price
  const [timeWindowSec, setTimeWindowSec] = useState<number>(60) // 60s history
  const [showTrades, setShowTrades] = useState<boolean>(true)
  const [sensitivity, setSensitivity] = useState<'normal' | 'walls_only'>('normal')

  // Smooth local trajectory buffer
  const localHistoryRef = useRef<PricePoint[]>([])
  const localTradesRef = useRef<TradePoint[]>([])

  // Sync historical points from incoming data
  useEffect(() => {
    if (!data) return

    if (data.price_history && data.price_history.length > 0) {
      localHistoryRef.current = data.price_history
    } else if (data.mid_price > 0) {
      const now = Date.now()
      localHistoryRef.current.push({
        t: now,
        p: data.mid_price,
        bid: data.best_bid,
        ask: data.best_ask,
      })
      if (localHistoryRef.current.length > 300) {
        localHistoryRef.current.shift()
      }
    }

    if (data.recent_trades && data.recent_trades.length > 0) {
      localTradesRef.current = data.recent_trades
    }
  }, [data])

  // Canvas render loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationFrameId: number

    const render = () => {
      const width = canvas.width
      const height = canvas.height
      const dpr = window.devicePixelRatio || 1

      ctx.clearRect(0, 0, width, height)

      // Background
      ctx.fillStyle = '#0a0d14'
      ctx.fillRect(0, 0, width, height)

      if (!data || data.mid_price === 0) {
        ctx.fillStyle = '#64748b'
        ctx.font = '12px monospace'
        ctx.textAlign = 'center'
        ctx.fillText(
          connectionState === 'connecting'
            ? 'Connecting to Bookmap Live L2 Stream...'
            : 'Waiting for OrderBook data on ws://localhost:8765...',
          width / 2,
          height / 2
        )
        animationFrameId = requestAnimationFrame(render)
        return
      }

      const midPrice = data.mid_price
      const minPrice = midPrice - priceWindow
      const maxPrice = midPrice + priceWindow
      const priceRange = maxPrice - minPrice

      const rightMargin = 135 * dpr
      const bottomMargin = 28 * dpr
      const chartWidth = width - rightMargin
      const chartHeight = height - bottomMargin

      // Price to Y coordinate mapper
      const priceToY = (p: number) => {
        return chartHeight - ((p - minPrice) / priceRange) * chartHeight
      }

      const now = Date.now()
      const timeSpanMs = timeWindowSec * 1000
      const startTime = now - timeSpanMs

      // Time to X coordinate mapper
      const timeToX = (t: number) => {
        const rel = (t - startTime) / timeSpanMs
        return Math.max(0, Math.min(chartWidth, rel * chartWidth))
      }

      // 1. Draw Horizontal Price Grid Lines & Labels
      const gridStep = priceWindow <= 2 ? 0.25 : priceWindow <= 5 ? 0.5 : 1.0
      const firstGridPrice = Math.floor(minPrice / gridStep) * gridStep
      
      ctx.strokeStyle = '#1e293b'
      ctx.lineWidth = 1 * dpr
      ctx.font = `${10 * dpr}px monospace`
      ctx.fillStyle = '#64748b'
      ctx.textAlign = 'left'

      for (let p = firstGridPrice; p <= maxPrice; p += gridStep) {
        const y = priceToY(p)
        if (y >= 0 && y <= chartHeight) {
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(chartWidth, y)
          ctx.stroke()

          // Price label on right axis
          ctx.fillText(`$${p.toFixed(2)}`, chartWidth + 10 * dpr, y + 3 * dpr)
        }
      }

      // 2. Draw Bookmap Liquidity Heatmap Bands (Resting Orders)
      const allSizes = [...data.bids.map((b) => b.size), ...data.asks.map((a) => a.size)]
      const maxVol = Math.max(...allSizes, 0.5)

      // Asks (Sells) Heatmap Bands - Red / Coral / Amber
      data.asks.forEach((ask) => {
        const y = priceToY(ask.price)
        if (y < 0 || y > chartHeight) return
        const ratio = Math.min(1.0, ask.size / maxVol)
        const isWall = data.resting_walls.some(
          (w) => w.side === 'ask' && Math.abs(w.price - ask.price) < 0.05
        )

        if (sensitivity === 'walls_only' && !isWall) return

        const bandHeight = Math.max(2 * dpr, (chartHeight / (priceRange / 0.1)) * 0.85)

        // Color intensity based on volume
        let alpha = 0.15 + ratio * 0.65
        let fillStyle = `rgba(244, 63, 94, ${alpha})`
        if (isWall) {
          alpha = 0.85
          fillStyle = `rgba(251, 146, 60, ${alpha})` // Golden orange for massive sell wall
        }

        ctx.fillStyle = fillStyle
        ctx.fillRect(0, y - bandHeight / 2, chartWidth, bandHeight)

        // Edge laser glow for walls
        if (isWall) {
          ctx.strokeStyle = 'rgba(251, 191, 36, 0.9)'
          ctx.lineWidth = 1.5 * dpr
          ctx.beginPath()
          ctx.moveTo(chartWidth - 60 * dpr, y)
          ctx.lineTo(chartWidth, y)
          ctx.stroke()
        }
      })

      // Bids (Buys) Heatmap Bands - Cyan / Emerald / Neon Green
      data.bids.forEach((bid) => {
        const y = priceToY(bid.price)
        if (y < 0 || y > chartHeight) return
        const ratio = Math.min(1.0, bid.size / maxVol)
        const isWall = data.resting_walls.some(
          (w) => w.side === 'bid' && Math.abs(w.price - bid.price) < 0.05
        )

        if (sensitivity === 'walls_only' && !isWall) return

        const bandHeight = Math.max(2 * dpr, (chartHeight / (priceRange / 0.1)) * 0.85)

        let alpha = 0.15 + ratio * 0.65
        let fillStyle = `rgba(6, 182, 212, ${alpha})`
        if (isWall) {
          alpha = 0.85
          fillStyle = `rgba(16, 185, 129, ${alpha})` // Neon emerald for massive buy wall
        }

        ctx.fillStyle = fillStyle
        ctx.fillRect(0, y - bandHeight / 2, chartWidth, bandHeight)

        if (isWall) {
          ctx.strokeStyle = 'rgba(52, 211, 153, 0.9)'
          ctx.lineWidth = 1.5 * dpr
          ctx.beginPath()
          ctx.moveTo(chartWidth - 60 * dpr, y)
          ctx.lineTo(chartWidth, y)
          ctx.stroke()
        }
      })

      // 3. Draw Spread Corridor
      const bestBidY = priceToY(data.best_bid)
      const bestAskY = priceToY(data.best_ask)
      if (bestBidY >= 0 && bestAskY <= chartHeight) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.12)'
        ctx.fillRect(0, bestAskY, chartWidth, Math.max(1, bestBidY - bestAskY))
      }

      // 4. Draw Rolling Price Trajectory Line
      const history = localHistoryRef.current
      if (history.length > 1) {
        ctx.beginPath()
        ctx.strokeStyle = '#38bdf8' // Cyan price line
        ctx.lineWidth = 2 * dpr
        ctx.lineJoin = 'round'

        let first = true
        for (let i = 0; i < history.length; i++) {
          const pt = history[i]
          const x = timeToX(pt.t)
          const y = priceToY(pt.p)
          if (first) {
            ctx.moveTo(x, y)
            first = false
          } else {
            ctx.lineTo(x, y)
          }
        }
        ctx.stroke()
      }

      // 5. Draw Bookmap Executed Trade Bubbles (if enabled)
      if (showTrades && localTradesRef.current.length > 0) {
        localTradesRef.current.forEach((trade) => {
          const x = timeToX(trade.t)
          const y = priceToY(trade.p)
          if (x >= 0 && x <= chartWidth && y >= 0 && y <= chartHeight) {
            const radius = Math.max(3 * dpr, Math.min(14 * dpr, Math.sqrt(trade.q) * 4 * dpr))
            ctx.beginPath()
            ctx.arc(x, y, radius, 0, Math.PI * 2)
            if (trade.side === 'buy') {
              ctx.fillStyle = 'rgba(34, 197, 94, 0.65)'
              ctx.strokeStyle = '#4ade80'
            } else {
              ctx.fillStyle = 'rgba(239, 68, 68, 0.65)'
              ctx.strokeStyle = '#f87171'
            }
            ctx.lineWidth = 1 * dpr
            ctx.fill()
            ctx.stroke()
          }
        })
      }

      // 6. Current Price Crosshair & Pulsing Dot
      const currentY = priceToY(midPrice)
      if (currentY >= 0 && currentY <= chartHeight) {
        // Dashed crosshair
        ctx.setLineDash([4 * dpr, 4 * dpr])
        ctx.strokeStyle = '#38bdf8'
        ctx.lineWidth = 1 * dpr
        ctx.beginPath()
        ctx.moveTo(0, currentY)
        ctx.lineTo(chartWidth, currentY)
        ctx.stroke()
        ctx.setLineDash([])

        // Pulsing dot at right edge
        ctx.beginPath()
        ctx.arc(chartWidth - 2 * dpr, currentY, 4.5 * dpr, 0, Math.PI * 2)
        ctx.fillStyle = '#38bdf8'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(chartWidth - 2 * dpr, currentY, 8 * dpr, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(56, 189, 248, 0.3)'
        ctx.fill()
      }

      // 7. Right-Axis Price & Wall Badges
      // Current Price Badge
      if (currentY >= 0 && currentY <= chartHeight) {
        const badgeHeight = 18 * dpr
        const badgeY = currentY - badgeHeight / 2
        ctx.fillStyle = '#0284c7'
        ctx.fillRect(chartWidth + 4 * dpr, badgeY, 95 * dpr, badgeHeight)
        ctx.fillStyle = '#ffffff'
        ctx.font = `bold ${11 * dpr}px monospace`
        ctx.textAlign = 'left'
        ctx.fillText(`$${midPrice.toFixed(2)}`, chartWidth + 8 * dpr, currentY + 3.5 * dpr)
      }

      // Resting Wall Badges (Institutions)
      data.resting_walls.forEach((wall) => {
        const y = priceToY(wall.price)
        if (y >= 10 && y <= chartHeight - 10) {
          const isBid = wall.side === 'bid'
          ctx.fillStyle = isBid ? '#064e3b' : '#7f1d1d'
          ctx.strokeStyle = isBid ? '#10b981' : '#ef4444'
          ctx.lineWidth = 1 * dpr
          const badgeX = chartWidth + 5 * dpr
          const badgeW = 120 * dpr
          const badgeH = 16 * dpr
          ctx.fillRect(badgeX, y - badgeH / 2, badgeW, badgeH)
          ctx.strokeRect(badgeX, y - badgeH / 2, badgeW, badgeH)

          ctx.fillStyle = isBid ? '#34d399' : '#fca5a5'
          ctx.font = `bold ${9 * dpr}px monospace`
          ctx.textAlign = 'left'
          ctx.fillText(
            `⚡ ${wall.multiple}x ${isBid ? 'BUY' : 'SELL'} (${wall.size.toFixed(1)} oz)`,
            badgeX + 4 * dpr,
            y + 3 * dpr
          )
        }
      })

      // 8. Time Axis Bar (Bottom)
      ctx.fillStyle = '#0f172a'
      ctx.fillRect(0, chartHeight, width, bottomMargin)
      ctx.strokeStyle = '#1e293b'
      ctx.beginPath()
      ctx.moveTo(0, chartHeight)
      ctx.lineTo(width, chartHeight)
      ctx.stroke()

      ctx.fillStyle = '#64748b'
      ctx.font = `${9 * dpr}px monospace`
      ctx.textAlign = 'center'
      const timeSteps = [
        { label: `-${timeWindowSec}s`, rel: 0 },
        { label: `-${Math.round(timeWindowSec * 0.75)}s`, rel: 0.25 },
        { label: `-${Math.round(timeWindowSec * 0.5)}s`, rel: 0.5 },
        { label: `-${Math.round(timeWindowSec * 0.25)}s`, rel: 0.75 },
        { label: 'NOW', rel: 1.0 },
      ]
      timeSteps.forEach((st) => {
        const x = st.rel * chartWidth
        ctx.fillText(st.label, x, chartHeight + 17 * dpr)
      })

      animationFrameId = requestAnimationFrame(render)
    }

    render()

    return () => {
      cancelAnimationFrame(animationFrameId)
    }
  }, [data, priceWindow, timeWindowSec, showTrades, sensitivity, connectionState])

  // Handle Resize with ResizeObserver for full container height & width
  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current
      const container = containerRef.current
      if (!canvas || !container) return
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const targetHeight = hideHeader ? rect.height : Math.max(380, rect.height || 420)
      canvas.width = rect.width * dpr
      canvas.height = targetHeight * dpr
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${targetHeight}px`
    }

    handleResize()
    const observer = new ResizeObserver(handleResize)
    if (containerRef.current) observer.observe(containerRef.current)
    window.addEventListener('resize', handleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [hideHeader])

  return (
    <div
      className={`relative w-full h-full flex flex-col min-h-0 bg-[#0a0d14] overflow-hidden select-none ${
        hideHeader ? '' : 'bg-terminal-panel/95 border border-terminal-border/80 rounded-lg p-3 font-mono text-xs shadow-xl'
      }`}
    >
      {/* Top Controls Bar (shown only when not embedded with master TradingView header) */}
      {!hideHeader && (
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-terminal-border/60 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="font-extrabold tracking-wider text-terminal-gold uppercase text-sm">
                XAUUSD BOOKMAP HEATMAP
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-terminal-surface border border-terminal-border text-terminal-gold font-bold">
                USDⓈ-M FUTURES
              </span>
            </div>

            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold bg-terminal-surface border border-terminal-border">
              <span
                className={`w-2 h-2 rounded-full ${
                  connectionState === 'connected' ? 'bg-terminal-bull animate-pulse' : 'bg-terminal-bear'
                }`}
              />
              <span className="text-terminal-text-dim uppercase">
                {connectionState === 'connected' ? `LIVE (${latencyMs}ms)` : 'OFFLINE'}
              </span>
            </div>
          </div>

          {/* View Controls: Zoom, Time, Bubbles */}
          <div className="flex items-center gap-2 text-2xs">
            <div className="flex items-center bg-terminal-surface rounded border border-terminal-border p-0.5">
              <span className="px-1 text-terminal-text-dim">ZOOM:</span>
              {[2, 3, 6, 12].map((z) => (
                <button
                  key={z}
                  onClick={() => setPriceWindow(z)}
                  className={`px-1.5 py-0.5 rounded ${
                    priceWindow === z
                      ? 'bg-terminal-panel text-terminal-gold font-bold'
                      : 'text-terminal-text-dim hover:text-terminal-text'
                  }`}
                >
                  ±${z}
                </button>
              ))}
            </div>

            <div className="flex items-center bg-terminal-surface rounded border border-terminal-border p-0.5">
              {[30, 60, 120].map((s) => (
                <button
                  key={s}
                  onClick={() => setTimeWindowSec(s)}
                  className={`px-1.5 py-0.5 rounded ${
                    timeWindowSec === s
                      ? 'bg-terminal-panel text-terminal-gold font-bold'
                      : 'text-terminal-text-dim hover:text-terminal-text'
                  }`}
                >
                  {s}s
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowTrades(!showTrades)}
              className={`px-2 py-1 rounded border ${
                showTrades
                  ? 'bg-terminal-bull/15 text-terminal-bull border-terminal-bull/40 font-semibold'
                  : 'bg-terminal-surface text-terminal-text-dim border-terminal-border'
              }`}
            >
              {showTrades ? '● BUBBLES ON' : '○ BUBBLES OFF'}
            </button>

            <button
              onClick={() => setSensitivity(sensitivity === 'normal' ? 'walls_only' : 'normal')}
              className={`px-2 py-1 rounded border ${
                sensitivity === 'walls_only'
                  ? 'bg-terminal-bear/20 text-terminal-bear border-terminal-bear/40 font-semibold'
                  : 'bg-terminal-surface text-terminal-text-dim border-terminal-border'
              }`}
            >
              {sensitivity === 'walls_only' ? '⚡ WALLS ONLY' : 'ALL HEAT'}
            </button>
          </div>
        </div>
      )}

      {/* Floating TradingView Controls Bar for full-bleed mode */}
      {hideHeader && (
        <div className="absolute top-2.5 right-3.5 z-20 flex items-center gap-2 text-2xs font-mono bg-terminal-panel/85 backdrop-blur-md px-2.5 py-1 rounded border border-terminal-border/70 shadow-lg">
          <div className="flex items-center bg-terminal-surface rounded border border-terminal-border p-0.5">
            {[2, 3, 6, 12].map((z) => (
              <button
                key={z}
                onClick={() => setPriceWindow(z)}
                className={`px-1.5 py-0.5 rounded font-bold ${
                  priceWindow === z ? 'bg-terminal-panel text-terminal-gold' : 'text-terminal-text-dim hover:text-terminal-text'
                }`}
              >
                ±${z}
              </button>
            ))}
          </div>

          <div className="flex items-center bg-terminal-surface rounded border border-terminal-border p-0.5">
            {[30, 60, 120].map((s) => (
              <button
                key={s}
                onClick={() => setTimeWindowSec(s)}
                className={`px-1.5 py-0.5 rounded font-bold ${
                  timeWindowSec === s ? 'bg-terminal-panel text-terminal-gold' : 'text-terminal-text-dim hover:text-terminal-text'
                }`}
              >
                {s}s
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowTrades(!showTrades)}
            className={`px-2 py-0.5 rounded border text-[10px] font-bold ${
              showTrades
                ? 'bg-terminal-bull/20 text-terminal-bull border-terminal-bull/40'
                : 'bg-terminal-surface text-terminal-text-dim border-terminal-border'
            }`}
          >
            {showTrades ? 'BUBBLES' : 'NO BUBBLES'}
          </button>

          <button
            onClick={() => setSensitivity(sensitivity === 'normal' ? 'walls_only' : 'normal')}
            className={`px-2 py-0.5 rounded border text-[10px] font-bold ${
              sensitivity === 'walls_only'
                ? 'bg-terminal-bear/20 text-terminal-bear border-terminal-bear/40'
                : 'bg-terminal-surface text-terminal-text-dim border-terminal-border'
            }`}
          >
            {sensitivity === 'walls_only' ? 'WALLS' : 'ALL'}
          </button>
        </div>
      )}

      {/* Floating Info Legend Top Left */}
      {hideHeader && (
        <div className="absolute top-2.5 left-3.5 z-20 flex items-center gap-2.5 font-mono text-[11px] pointer-events-none bg-terminal-panel/80 backdrop-blur-md px-3 py-1.5 rounded border border-terminal-border/70 shadow-lg">
          <span className="font-bold text-terminal-gold">BOOKMAP HEATMAP</span>
          <span className="text-terminal-text-dim text-[10px]">L2 TRAJECTORY</span>
          {data && (
            <span className="text-terminal-bull font-bold ml-1">{price(data.mid_price)}</span>
          )}
        </div>
      )}

      {/* Main Canvas Container */}
      <div ref={containerRef} className="relative w-full flex-1 min-h-0 overflow-hidden">
        <canvas ref={canvasRef} className="block w-full h-full cursor-crosshair" />
      </div>

      {/* Heatmap Legend & Institutional Summary */}
      <div className="px-3 py-1.5 border-t border-terminal-border/40 bg-terminal-surface/90 flex flex-wrap items-center justify-between text-2xs font-mono gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-terminal-text-dim uppercase font-semibold">Heatmap:</span>
          <div className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded bg-cyan-500/30" />
            <span className="text-terminal-text-dim">Bids</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded bg-emerald-500" />
            <span className="text-terminal-bull font-bold">⚡ Buy Wall</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded bg-rose-500/30" />
            <span className="text-terminal-text-dim">Asks</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded bg-amber-500" />
            <span className="text-terminal-bear font-bold">⚡ Sell Wall</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-terminal-text-dim">Taker Buy</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-rose-400" />
            <span className="text-terminal-text-dim">Taker Sell</span>
          </div>
        </div>

        {data && data.resting_walls.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-terminal-gold font-bold">Active Resting Walls:</span>
            {data.resting_walls.slice(0, 3).map((w, i) => (
              <span
                key={i}
                className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                  w.side === 'bid'
                    ? 'bg-terminal-bull/20 text-terminal-bull border-terminal-bull/40'
                    : 'bg-terminal-bear/20 text-terminal-bear border-terminal-bear/40'
                }`}
              >
                ${w.price.toFixed(2)} ({w.size.toFixed(1)} oz · {w.multiple}x)
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
