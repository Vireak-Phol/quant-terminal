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
  /** Monotonic emit counter from the bridge bubble engine. The sweep-feed
   *  selector keys its re-render off this so a new bubble is never dropped at
   *  ring-buffer capacity when a same-signature fill repeats (Audit #1). */
  bubblesRev?: number
  /** Active market-data venue + capability flags (absent on pre-venue bridges). */
  venue?: VenueInfo
  status: string
}

export type ConnectionState = 'connected' | 'connecting' | 'disconnected'

/** What the active venue's feed really contains (bridge `frame.venue.capabilities`). */
export interface VenueCapabilities {
  l2_depth: boolean
  trades: boolean
  liquidations: boolean
  open_interest: boolean
  funding: boolean
  /** "exchange" = traded volume; "tick" = quote-change count (OANDA). */
  volume: 'exchange' | 'tick'
  /** "exchange" = taker aggressor delta; "tick_rule" = estimate from quote ticks. */
  delta: 'exchange' | 'tick_rule'
}

export interface VenueInfo {
  name: 'binance' | 'oanda' | string
  label: string
  symbol: string
  display_symbol: string
  contract: string
  capabilities: VenueCapabilities
}

export interface ProviderOption extends VenueInfo {
  available: boolean
  reason: string | null
}

/** Assumed until the first frame arrives (and for bridges that predate venues). */
export const DEFAULT_VENUE: VenueInfo = {
  name: 'binance',
  label: 'Binance USDⓈ-M Futures',
  symbol: 'XAUUSDT',
  display_symbol: 'XAUUSDT',
  contract: 'PERP',
  capabilities: {
    l2_depth: true, trades: true, liquidations: true, open_interest: true,
    funding: true, volume: 'exchange', delta: 'exchange',
  },
}

type Reply = { type: string } & Record<string, unknown>

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
  private replyListeners = new Set<(msg: Reply) => void>()
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
  onReply(fn: (msg: Reply) => void): () => void {
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

  private reqSeq = 0

  /**
   * Request/response over the shared socket. Sends `{action, req_id, ...payload}` and
   * resolves with the reply carrying the same `req_id`. If the socket is not open yet
   * (first mount, bridge restarting) it waits for the connection within `timeoutMs`.
   * Rejects on timeout or if the socket drops before the reply arrives.
   */
  request<T = Reply>(
    action: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    const reqId = `${action}-${Date.now().toString(36)}-${++this.reqSeq}`
    return new Promise<T>((resolve, reject) => {
      let sent = false
      let settled = false
      const cleanup: Array<() => void> = []
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        cleanup.forEach((c) => c())
        fn()
      }
      const timer = setTimeout(
        () => finish(() => reject(new Error(`${action}: bridge did not reply within ${timeoutMs} ms`))),
        timeoutMs,
      )
      cleanup.push(() => clearTimeout(timer))
      cleanup.push(
        this.onReply((m) => {
          if (m.req_id === reqId) finish(() => resolve(m as unknown as T))
        }),
      )
      const trySend = () => {
        if (!sent && this.send(action, { ...payload, req_id: reqId })) sent = true
      }
      // Keep the socket alive for the duration of the request and follow reconnects.
      cleanup.push(
        this.subscribe(() => {
          if (this.closedByUs) {
            finish(() => reject(new Error(`${action}: socket closed`)))
            return
          }
          const st = this.snapshot.connectionState
          if (!sent && st === 'connected') trySend()
          else if (sent && st === 'disconnected')
            finish(() => reject(new Error(`${action}: bridge disconnected`)))
        }),
      )
      trySend()
    })
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
        // The bridge sends the heavy `v74` frame only when it changes; carry the last one
        // forward — but never across a venue switch (that would show the other venue's signals).
        const prev = this.snapshot.data
        const sameVenue = (prev?.venue?.name ?? 'binance') === (parsed.venue?.name ?? 'binance')
        if (!('v74' in parsed) && prev?.v74 !== undefined && sameVenue) parsed.v74 = prev.v74
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
