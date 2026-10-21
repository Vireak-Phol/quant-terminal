import { useState, useEffect, useRef, useCallback } from 'react'

export interface OrderBookLevel {
  price: number
  size: number
  cumulative: number
}

export interface RestingWall {
  side: 'bid' | 'ask'
  price: number
  size: number
  multiple: number
}

export interface LiquidityZoneData {
  type: string
  id: string
  symbol: string
  side: 'bid' | 'ask'
  priceLow: string
  priceHigh: string
  centerPrice: number
  displayedQuantity: string
  peakDisplayedQuantity: string
  notionalValue: number
  firstSeenTimestamp: number
  lastUpdatedTimestamp: number
  persistenceDuration: number
  status: 'active' | 'reduced' | 'removed' | 'replenished' | 'uncertain'
  multipleOfMean: number
  levelCount: number
}

export interface AbsorptionCandidateData {
  type: string
  id: string
  symbol: string
  side: 'buy' | 'sell'
  price: string
  executedQuantity: string
  tradeCount: number
  priceResponse: number
  expectedPriceResponse: number
  confidence: number
  status: string
  timestamp: number
  reason: string
}

export interface PricePoint {
  t: number
  p: number
  bid: number
  ask: number
}

export interface TradePoint {
  t: number
  p: number
  q: number
  side: 'buy' | 'sell'
  id?: number
}

export interface V7Signal {
  id: string
  direction: 'LONG' | 'SHORT'
  tier: 'TIER_1_A_PLUS' | 'TIER_2_STRUCTURAL' | 'TRAP_WARNING'
  tier_label: string
  win_probability: number
  entry_price: number
  stop_loss: number
  tp1: number
  tp2: number
  risk_reward: number
  wall_price: number
  wall_size: number
  confluence_factors: string[]
  timestamp: number
}

export interface HoplaLevels {
  box_low?: number
  box_high?: number
  line_3_disc?: number
  line_97_prem?: number
  line_50_eq?: number
  line_97_above?: number
  line_3_below?: number
  at_discount?: boolean
  at_premium?: boolean
}

export interface ActiveFVG {
  id: string
  side: 'bullish' | 'bearish'
  time: number
  top: number
  bottom: number
  size: number
}

export interface TelemetryData {
  connection_state: string
  order_book_sync_state: string
  last_exchange_time: number
  last_receive_time: number
  latency_ms: number
  reconnect_count: number
  sequence_gaps_count: number
  total_updates_processed: number
  active_clients: number
  is_replaying: boolean
  is_recording: boolean
}

export interface LiveOrderBookData {
  symbol: string
  market_type?: string
  provider?: string
  contract_type?: string
  timestamp: number
  mid_price: number
  spread: number
  best_bid: number
  best_ask: number
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  imbalance: number // -1.0 to 1.0
  imbalance_score: number // 0 to 100
  top5_bid_vol: number
  top5_ask_vol: number
  bid_total_vol: number
  ask_total_vol: number
  resting_walls: RestingWall[]
  liquidity_zones?: LiquidityZoneData[]
  absorption_candidates?: AbsorptionCandidateData[]
  recent_trades?: TradePoint[]
  price_history?: PricePoint[]
  mark_price?: number
  funding_rate?: number
  v6_flow_signal: 'BULLISH_PRESSURE' | 'BEARISH_PRESSURE' | 'BALANCED'
  v7_signal?: V7Signal | null
  hopla?: HoplaLevels
  active_fvgs?: ActiveFVG[]
  telemetry?: TelemetryData
  status: string
}

export type ConnectionState = 'connected' | 'connecting' | 'disconnected'

export function useLiveOrderBook(url = 'ws://localhost:8765') {
  const [data, setData] = useState<LiveOrderBookData | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [latencyMs, setLatencyMs] = useState<number>(0)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<any>(null)

  const connect = useCallback(() => {
    try {
      setConnectionState('connecting')
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        setConnectionState('connected')
      }

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as LiveOrderBookData
          if (parsed && parsed.timestamp) {
            setLatencyMs(Math.max(0, Date.now() - parsed.timestamp))
          }
          setData(parsed)
        } catch (e) {
          console.error('Error parsing OrderBook WS payload:', e)
        }
      }

      ws.onerror = () => {
        // ws.onclose will fire after error
      }

      ws.onclose = () => {
        setConnectionState('disconnected')
        reconnectTimeoutRef.current = setTimeout(() => {
          connect()
        }, 2000)
      }
    } catch {
      setConnectionState('disconnected')
      reconnectTimeoutRef.current = setTimeout(() => {
        connect()
      }, 2000)
    }
  }, [url])

  const sendCommand = useCallback((action: string, payload: Record<string, any> = {}) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action, ...payload }))
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connect])

  return {
    data,
    connectionState,
    latencyMs,
    sendCommand,
  }
}
