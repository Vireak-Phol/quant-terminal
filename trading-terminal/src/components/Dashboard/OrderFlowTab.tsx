import React, { useState } from 'react'
import { MetricTile } from '../Shared/MetricTile'
import { Panel } from '../Shared/Panel'
import { TradingViewDeepChart } from './TradingViewDeepChart'
import { BookmapChart } from './BookmapChart'
import { OrderBookLadder } from './OrderBookLadder'
import { useLiveOrderBook } from '../../hooks/useLiveOrderBook'

export function OrderFlowTab() {
  const { data: liveBook } = useLiveOrderBook()
  const [activeView, setActiveView] = useState<'tradingview' | 'bookmap' | 'both'>('tradingview')

  const bidAskRatio = liveBook && liveBook.top5_ask_vol > 0
    ? (liveBook.top5_bid_vol / liveBook.top5_ask_vol).toFixed(2)
    : '1.00'

  const deltaVol = liveBook
    ? (liveBook.top5_bid_vol - liveBook.top5_ask_vol).toFixed(2)
    : '0.00'

  const imbalanceScore = liveBook ? liveBook.imbalance_score : 50
  const flowSignal = liveBook?.v6_flow_signal || 'BALANCED'

  return (
    <div className="space-y-4">
      {/* Live Order Flow Metrics Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricTile
          label="Top 5 Bid/Ask Ratio"
          value={bidAskRatio}
          sub={parseFloat(bidAskRatio) >= 1 ? 'Buying pressure dominating' : 'Selling pressure dominating'}
          color={parseFloat(bidAskRatio) >= 1 ? 'green' : 'red'}
        />
        <MetricTile
          label="L2 Top 5 Delta (oz)"
          value={`${parseFloat(deltaVol) > 0 ? '+' : ''}${deltaVol}`}
          color={parseFloat(deltaVol) > 0 ? 'green' : parseFloat(deltaVol) < 0 ? 'red' : 'gold'}
          sub="Bid depth minus ask depth"
        />
        <MetricTile
          label="OFI Imbalance Score"
          value={`${imbalanceScore}/100`}
          color={imbalanceScore > 60 ? 'green' : imbalanceScore < 40 ? 'red' : 'default'}
          sub={imbalanceScore > 60 ? 'Bullish order flow skew' : imbalanceScore < 40 ? 'Bearish order flow skew' : 'Balanced book'}
        />
        <MetricTile
          label="Micro Flow Regime"
          value={flowSignal.replace('_', ' ')}
          color={flowSignal === 'BULLISH_PRESSURE' ? 'green' : flowSignal === 'BEARISH_PRESSURE' ? 'red' : 'default'}
          sub={`${liveBook?.resting_walls.length || 0} active resting walls detected`}
        />
      </div>

      {/* View Switcher Controls */}
      <div className="flex flex-wrap items-center justify-between bg-terminal-surface/70 border border-terminal-border/80 p-2.5 rounded-lg font-mono text-xs gap-3">
        <div className="flex items-center gap-2.5">
          <span className="text-terminal-text-dim uppercase text-[11px] font-bold">Chart View:</span>
          <div className="flex items-center bg-terminal-panel rounded border border-terminal-border p-0.5">
            <button
              onClick={() => setActiveView('tradingview')}
              className={`px-3 py-1 rounded font-bold transition-all text-xs ${
                activeView === 'tradingview'
                  ? 'bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/40'
                  : 'text-terminal-text-dim hover:text-terminal-text'
              }`}
            >
              5M TRADINGVIEW + BUBBLES
            </button>
            <button
              onClick={() => setActiveView('bookmap')}
              className={`px-3 py-1 rounded font-bold transition-all text-xs ${
                activeView === 'bookmap'
                  ? 'bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/40'
                  : 'text-terminal-text-dim hover:text-terminal-text'
              }`}
            >
              BOOKMAP HEATMAP
            </button>
            <button
              onClick={() => setActiveView('both')}
              className={`px-3 py-1 rounded font-bold transition-all text-xs ${
                activeView === 'both'
                  ? 'bg-terminal-gold/20 text-terminal-gold border border-terminal-gold/40'
                  : 'text-terminal-text-dim hover:text-terminal-text'
              }`}
            >
              DUAL VIEW
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 text-2xs text-terminal-text-dim">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-terminal-bull" />
            <span>XAUUSDT (Binance USDⓈ-M Futures)</span>
          </span>
          <span className="hidden md:inline">• Sub-100ms Streaming WebSocket</span>
        </div>
      </div>

      {/* Main Charts Area */}
      {(activeView === 'tradingview' || activeView === 'both') && (
        <Panel title="TradingView 5m Candlestick Chart + DeepChart Absorption Bubbles + Resting Walls">
          <TradingViewDeepChart />
        </Panel>
      )}

      {(activeView === 'bookmap' || activeView === 'both') && (
        <Panel title="Institutional Bookmap — Resting Order Heatmap & Price Trajectory">
          <BookmapChart />
        </Panel>
      )}

      {/* Numerical L2 DOM Ladder for execution & depth verification */}
      <Panel title="Live L2 Depth of Market (DOM Ladder)">
        <OrderBookLadder />
      </Panel>
    </div>
  )
}
