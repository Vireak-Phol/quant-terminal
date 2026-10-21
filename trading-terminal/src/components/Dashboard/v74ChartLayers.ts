/** v7.4 chart layers rendered on the existing overlay canvas of TradingViewDeepChart.
 *
 *  Layers (each independently toggleable, persisted in localStorage):
 *    signals   — A+ / Structural markers at the signal bar (Trap dimmed, small)
 *    tradeBox  — active trade: entry / stop / TP1 / TP2 risk-reward box projected right
 *    structure — Unicorn FVG + breaker zones and Regression OBs (distance-culled)
 *    hopla     — Hopla 3 / 50 / 97 dealing-range lines (labelled → not ghost lines)
 *    vacuum    — liquidity-vacuum pockets + nearest magnet line
 *    history   — closed signals coloured by outcome (win/loss) with R result
 *
 *  Invariants respected (AGENTS.md): no VWAP / EMA lines; every horizontal line drawn
 *  here carries a text label; nothing is drawn beyond ``MAX_DIST_ATR`` from price.
 */

import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { SignalBrief, TimeframeFrame } from '../../types/v74'
import { withinAtr } from '../../lib/v74'

export type V74LayerKey = 'signals' | 'tradeBox' | 'structure' | 'hopla' | 'vacuum' | 'history'
export type V74Layers = Record<V74LayerKey, boolean>

export const DEFAULT_V74_LAYERS: V74Layers = {
  signals: true,
  tradeBox: true,
  structure: false,
  hopla: true,
  vacuum: false,
  history: false,
}

export const V74_LAYER_LABELS: Record<V74LayerKey, string> = {
  signals: 'Signals',
  tradeBox: 'Trade',
  structure: 'Structure',
  hopla: 'Hopla',
  vacuum: 'Vacuum',
  history: 'History',
}

const KEY = 'terminal.v74Layers.v1'

export function loadLayers(): V74Layers {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_V74_LAYERS
    return { ...DEFAULT_V74_LAYERS, ...(JSON.parse(raw) as Partial<V74Layers>) }
  } catch {
    return DEFAULT_V74_LAYERS
  }
}

export function saveLayers(l: V74Layers): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l))
  } catch {
    /* session-only */
  }
}

export const MAX_DIST_ATR = 12
const PRICE_SCALE_W = 72

const C = {
  bull: 'rgba(74, 222, 128, 1)',
  bear: 'rgba(248, 113, 113, 1)',
  gold: 'rgba(251, 191, 36, 1)',
  dim: 'rgba(148, 163, 184, 0.55)',
  text: '#e2e8f0',
}

type XFn = (t: number) => number | null

interface Ctx {
  ctx: CanvasRenderingContext2D
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  x: XFn
  width: number
  height: number
  plotRight: number
  mid: number
  atr: number | null
}

function y(c: Ctx, p: number | null | undefined): number | null {
  if (p == null || !Number.isFinite(p)) return null
  const v = c.series.priceToCoordinate(p)
  return v == null ? null : (v as number)
}

function tag(c: Ctx, text: string, xr: number, yy: number, color: string, align: 'right' | 'left' = 'right') {
  const { ctx } = c
  ctx.font = "bold 9px 'JetBrains Mono', monospace"
  const w = ctx.measureText(text).width + 8
  const x0 = align === 'right' ? xr - w : xr
  ctx.fillStyle = 'rgba(9, 13, 22, 0.85)'
  ctx.fillRect(x0, yy - 7, w, 14)
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.strokeRect(x0 + 0.5, yy - 6.5, w - 1, 13)
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x0 + 4, yy)
}

function hline(c: Ctx, p: number, color: string, label: string, dash: number[] = [4, 4], fromX = 0) {
  const yy = y(c, p)
  if (yy == null || yy < 0 || yy > c.height) return
  const { ctx } = c
  ctx.save()
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.75
  ctx.setLineDash(dash)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(fromX, yy + 0.5)
  ctx.lineTo(c.plotRight - 2, yy + 0.5)
  ctx.stroke()
  ctx.restore()
  tag(c, label, c.plotRight - 4, yy, color)
}

function zone(c: Ctx, x0: number, top: number, bottom: number, fill: string, stroke: string, label?: string) {
  const y0 = y(c, top)
  const y1 = y(c, bottom)
  if (y0 == null || y1 == null) return
  const { ctx } = c
  const left = Math.max(0, x0)
  const w = c.plotRight - 2 - left
  if (w <= 2) return
  ctx.fillStyle = fill
  ctx.fillRect(left, Math.min(y0, y1), w, Math.max(1, Math.abs(y1 - y0)))
  ctx.strokeStyle = stroke
  ctx.setLineDash([2, 3])
  ctx.strokeRect(left + 0.5, Math.min(y0, y1) + 0.5, w - 1, Math.max(1, Math.abs(y1 - y0)) - 1)
  ctx.setLineDash([])
  if (label) {
    ctx.font = "9px 'JetBrains Mono', monospace"
    ctx.fillStyle = stroke
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(label, left + 3, Math.min(y0, y1) + 2)
  }
}

function marker(c: Ctx, s: SignalBrief, tfSec: number, dimmed: boolean) {
  const xx = c.x(s.time - tfSec)
  if (xx == null || xx < 0 || xx > c.plotRight) return
  const long = s.direction === 'LONG'
  const yy = y(c, long ? s.entry - (c.atr ?? 1) * 0.9 : s.entry + (c.atr ?? 1) * 0.9)
  if (yy == null) return
  const { ctx } = c
  const size = s.tier === 'A_PLUS' ? 7 : s.tier === 'STRUCTURAL' ? 5 : 3
  ctx.save()
  ctx.globalAlpha = dimmed ? 0.35 : 1
  ctx.fillStyle = s.tier === 'TRAP' ? C.dim : long ? C.bull : C.bear
  ctx.beginPath()
  if (long) {
    ctx.moveTo(xx, yy - size)
    ctx.lineTo(xx - size, yy + size)
    ctx.lineTo(xx + size, yy + size)
  } else {
    ctx.moveTo(xx, yy + size)
    ctx.lineTo(xx - size, yy - size)
    ctx.lineTo(xx + size, yy - size)
  }
  ctx.closePath()
  ctx.fill()
  if (s.tier === 'A_PLUS') {
    ctx.strokeStyle = C.gold
    ctx.lineWidth = 1.2
    ctx.stroke()
    ctx.font = "bold 9px 'JetBrains Mono', monospace"
    ctx.textAlign = 'center'
    ctx.textBaseline = long ? 'top' : 'bottom'
    ctx.fillStyle = C.gold
    const wr = s.prob_status === 'measured' && s.win_rate != null ? ` ${s.win_rate.toFixed(0)}%` : ''
    ctx.fillText(`A+${wr}`, xx, long ? yy + size + 2 : yy - size - 2)
  }
  ctx.restore()
}

/** Draw all enabled layers. Returns nothing; pure canvas side effects. */
export function drawV74Layers(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  x: XFn,
  width: number,
  height: number,
  fr: TimeframeFrame | undefined,
  layers: V74Layers,
  mid: number,
): void {
  if (!fr || !fr.ready) return
  const c: Ctx = { ctx, chart, series, x, width, height, plotRight: Math.max(120, width - PRICE_SCALE_W), mid, atr: fr.context?.atr ?? null }
  const tfSec = fr.tf === '15m' ? 900 : 300
  const near = (p: number | null | undefined) => withinAtr(p, mid, c.atr, MAX_DIST_ATR)
  const st = fr.structure
  ctx.save()

  // Structure: Unicorn (FVG + breaker) and Regression OBs
  if (layers.structure && st) {
    for (const u of st.unicorn.slice(-6)) {
      if (!near(u.entry)) continue
      const bull = u.side === 'bull'
      zone(c, c.plotRight - 180, u.fvg_top, u.fvg_bottom, bull ? 'rgba(74,222,128,0.10)' : 'rgba(248,113,113,0.10)', bull ? C.bull : C.bear, `${bull ? 'Bull' : 'Bear'} FVG ${u.tf}`)
      zone(c, c.plotRight - 180, u.breaker_top, u.breaker_bottom, 'rgba(251,191,36,0.06)', 'rgba(251,191,36,0.6)')
    }
    for (const z of st.regob.slice(-6)) {
      if (!near((z.top + z.bottom) / 2)) continue
      zone(c, c.plotRight - 140, z.top, z.bottom, z.side === 'bull' ? 'rgba(96,165,250,0.10)' : 'rgba(192,132,252,0.10)', z.side === 'bull' ? '#60a5fa' : '#c084fc', `RegOB ${z.side}`)
    }
    const k = st.key_levels
    if (k.pdh != null && near(k.pdh)) hline(c, k.pdh, 'rgba(203,213,225,0.7)', 'PDH', [1, 3])
    if (k.pdl != null && near(k.pdl)) hline(c, k.pdl, 'rgba(203,213,225,0.7)', 'PDL', [1, 3])
    for (const e of st.events.slice(-12)) {
      if (!near(e.price) || (e.kind !== 'liq_sweep' && e.kind !== 'rpd_peak' && e.kind !== 'rpd_valley')) continue
      const xx = x(e.time)
      const yy = y(c, e.price)
      if (xx == null || yy == null || xx > c.plotRight) continue
      ctx.font = "bold 9px 'JetBrains Mono', monospace"
      ctx.textAlign = 'center'
      ctx.textBaseline = e.dir > 0 ? 'top' : 'bottom'
      ctx.fillStyle = e.dir > 0 ? C.bull : C.bear
      ctx.fillText(e.kind === 'liq_sweep' ? '◆ sweep' : e.kind === 'rpd_peak' ? '▼ RPD' : '▲ RPD', xx, e.dir > 0 ? yy + 4 : yy - 4)
    }
  }

  // Vacuum pockets + magnet
  if (layers.vacuum && st) {
    for (const v of st.vacuum) {
      if (!near(v.price)) continue
      const color = v.strength === 3 ? '#FF5252' : v.strength === 2 ? '#FFA726' : '#8B9BB4'
      zone(c, c.plotRight - 110, v.top, v.bottom, `${color}22`, color, `VAC${v.strength}`)
    }
    const magnet = st.vac_band > 0 ? st.vac_above : st.vac_band < 0 ? st.vac_below : null
    if (magnet != null && near(magnet)) hline(c, magnet, '#00E5FF', `MAGNET ${st.vac_band > 0 ? '↑' : '↓'}`, [6, 3])
  }

  // Hopla 3-97 dealing range
  if (layers.hopla && st?.hopla) {
    const h = st.hopla
    if (near(h.line_97)) hline(c, h.line_97, 'rgba(255,59,48,0.9)', `97% ${h.line_97.toFixed(2)}`)
    if (near(h.line_50)) hline(c, h.line_50, 'rgba(148,163,184,0.6)', `EQ ${h.line_50.toFixed(2)}`, [1, 4])
    if (near(h.line_3)) hline(c, h.line_3, 'rgba(0,180,216,0.9)', `3% ${h.line_3.toFixed(2)}`)
  }

  // History: closed outcomes
  if (layers.history) {
    for (const s of fr.signals ?? []) {
      if (s.status !== 'closed' || s.tier === 'TRAP' || !near(s.entry)) continue
      const xx = x(s.time - tfSec)
      const yy = y(c, s.entry)
      if (xx == null || yy == null || xx > c.plotRight) continue
      const win = (s.r_net ?? 0) > 0
      ctx.beginPath()
      ctx.arc(xx, yy, 3.5, 0, Math.PI * 2)
      ctx.fillStyle = win ? C.bull : C.bear
      ctx.fill()
      ctx.font = "8px 'JetBrains Mono', monospace"
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(`${(s.r_net ?? 0) > 0 ? '+' : ''}${(s.r_net ?? 0).toFixed(1)}R`, xx + 5, yy)
    }
  }

  // Signals: markers for live + warm-up history (A+/Structural; Trap faint)
  if (layers.signals) {
    for (const s of fr.signals ?? []) {
      if (!near(s.entry)) continue
      marker(c, s, tfSec, s.tier === 'TRAP')
    }
  }

  // Trade box for the active signal
  const a = fr.active_signal
  if (layers.tradeBox && a && a.status === 'open') {
    const p = a.plan
    const x0 = x(a.time - tfSec) ?? c.plotRight - 160
    const left = Math.min(Math.max(0, x0), c.plotRight - 60)
    const ye = y(c, p.entry)
    const ys = y(c, p.stop)
    const y1 = y(c, p.tp1)
    const y2 = y(c, p.tp2)
    if (ye != null && ys != null && y1 != null && y2 != null) {
      const w = c.plotRight - 2 - left
      ctx.fillStyle = 'rgba(248,113,113,0.14)'
      ctx.fillRect(left, Math.min(ye, ys), w, Math.abs(ys - ye))
      ctx.fillStyle = 'rgba(74,222,128,0.12)'
      ctx.fillRect(left, Math.min(ye, y1), w, Math.abs(y1 - ye))
      ctx.fillStyle = 'rgba(74,222,128,0.06)'
      ctx.fillRect(left, Math.min(y1, y2), w, Math.abs(y2 - y1))
      hline(c, p.entry, C.gold, `${a.tier === 'A_PLUS' ? 'A+ ' : ''}${a.direction} ${p.entry.toFixed(2)}`, [], left)
      hline(c, p.stop, C.bear, `SL ${p.stop.toFixed(2)} (-1R)`, [5, 3], left)
      hline(c, p.tp1, C.bull, `TP1 ${p.tp1.toFixed(2)} (${p.rr_tp1}R)`, [5, 3], left)
      hline(c, p.tp2, C.bull, `TP2 ${p.tp2.toFixed(2)} (${p.rr_tp2}R)`, [2, 3], left)
    }
  }
  ctx.restore()
}
