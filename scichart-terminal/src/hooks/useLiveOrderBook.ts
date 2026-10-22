import { useSyncExternalStore, useCallback } from 'react'
import type { V74Frame } from '../types/v74'

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

export type BubbleRegime =
  | 'standard_flow'
  | 'institutional_absorption_open'
  | 'liquidation_exhaustion_flush'
  | 'vacuum_sweep_breakout'

export interface BubbleSignalData {
  type: 'bubble_regime'
  timestamp: number
  priceCenter: string
  aggressorSide: 'buy' | 'sell'
  totalQuantity: string
  sweepTicks: number
  oiDelta: number
  liquidationQuantity: string
  regime: BubbleRegime
}

export interface TradePoint {
  t: number
  p: number
  q: number
  side: 'buy' | 'sell'
  id?: number
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
  telemetry?: TelemetryData
  /** v7.4 institutional engine frame (closed-bar signals, structure, ledger). */
  v74?: V74Frame | null
  // --- Audit R1: trade-price candles + CVD (bridge on_trade_received) ---
  cvd?: number
  trade_candle?: {
    t: number; o: number; h: number; l: number; c: number
    v: number; d: number; bv: number; sv: number; closed: boolean
  } | null
  // --- Audit R3: session/killzone + key levels + sweep events ---
  session?: {
    london: boolean; ny_am: boolean; asia: boolean; london_fix: boolean; name: string
  }
  key_levels?: {
    pdh: number | null; pdl: number | null; pwh: number | null; pwl: number | null
  }
  sweep_events?: Array<{ kind: 'liq_sweep'; time: number; price: number; dir: number }>
  // --- Bubble Regime engine: OI + liquidation classified sweeps ---
  open_interest?: number
  oi_delta?: number
  bubbles?: BubbleSignalData[]
  status: string
}

export type ConnectionState = 'connected' | 'connecting' | 'disconnected'

interface Snapshot {
  data: LiveOrderBookData | null
  connectionState: ConnectionState
  latencyMs: number
}

/**
 * One WebSocket per URL, shared by every component that calls `useLiveOrderBook()`.
 * Ref-counted: the socket opens on the first subscriber and closes (and stops
 * reconnecting) when the last one unmounts. Previously each panel opened its own
 * socket, multiplying bridge load and JSON parsing per frame.
 */
export class SharedSocket {
  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUs = false
  private replyListeners = new Set<(msg: { type: string } & Record<string, unknown>) => void>()
  snapshot: Snapshot = { data: null, connectionState: 'connecting', latencyMs: 0 }

  constructor(private url: string, private reconnectMs = 2000) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.open()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.close()
    }
  }

  getSnapshot = (): Snapshot => this.snapshot

  /** Command replies (`ledger`, `risk_config`, `recorder_status`, …) — not book frames. */
  onReply(fn: (msg: { type: string } & Record<string, unknown>) => void): () => void {
    this.replyListeners.add(fn)
    return () => {
      this.replyListeners.delete(fn)
    }
  }

  send(action: string, payload: Record<string, unknown> = {}): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action, ...payload }))
      return true
    }
    return false
  }

  private emit(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((l) => l())
  }

  private open() {
    this.closedByUs = false
    this.emit({ connectionState: 'connecting' })
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => this.emit({ connectionState: 'connected' })
    ws.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data as string)
        if (!parsed) return
        // Command replies go to reply listeners; only full bookmap frames replace state.
        if (parsed.type && parsed.type !== 'bookmap_update') {
          this.replyListeners.forEach((l) => l(parsed))
          return
        }
        const latencyMs = parsed.timestamp ? Math.max(0, Date.now() - parsed.timestamp) : this.snapshot.latencyMs
        // The bridge sends the heavy `v74` frame only when it changes; carry the last one forward.
        if (!('v74' in parsed) && this.snapshot.data?.v74 !== undefined) parsed.v74 = this.snapshot.data.v74
        this.emit({ data: parsed as LiveOrderBookData, latencyMs })
      } catch (e) {
        console.error('Error parsing OrderBook WS payload:', e)
      }
    }
    ws.onclose = () => {
      this.ws = null
      if (this.closedByUs) return
      this.emit({ connectionState: 'disconnected' })
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.closedByUs || this.reconnectTimer) return
    this.emit({ connectionState: 'disconnected' })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closedByUs && this.listeners.size > 0) this.open()
    }, this.reconnectMs)
  }

  private close() {
    this.closedByUs = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}

const sockets = new Map<string, SharedSocket>()

export function getSharedSocket(url: string): SharedSocket {
  let s = sockets.get(url)
  if (!s) {
    s = new SharedSocket(url)
    sockets.set(url, s)
  }
  return s
}

/** Test hook: drop all cached sockets. */
export function __resetSharedSockets() {
  sockets.clear()
}

export const DEFAULT_BRIDGE_URL: string =
  (import.meta as any).env?.VITE_BRIDGE_URL || 'ws://localhost:8765'

export function useLiveOrderBook(url = DEFAULT_BRIDGE_URL) {
  const socket = getSharedSocket(url)
  const snap = useSyncExternalStore(socket.subscribe, socket.getSnapshot, socket.getSnapshot)

  const sendCommand = useCallback(
    (action: string, payload: Record<string, any> = {}) => {
      socket.send(action, payload)
    },
    [socket],
  )

  return {
    data: snap.data,
    connectionState: snap.connectionState,
    latencyMs: snap.latencyMs,
    sendCommand,
    socket,
  }
}
