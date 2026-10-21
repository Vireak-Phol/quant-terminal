/** Number and time formatting. Centralised so a price renders identically in the
 *  ladder, the blotter, the tape and the trade plan — inconsistent decimals read
 *  as a data bug to anyone scanning a desk screen. */

/** Price with instrument-appropriate precision. XAUUSD wants 2dp, JPY pairs 3,
 *  indices 2, crypto more. Inferred from magnitude when not told. */
export function price(v: number | null | undefined, dp?: number): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const places = dp ?? (Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 4 : 6)
  return v.toLocaleString('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })
}

export function usd(v: number | null | undefined, dp?: number): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `$${price(v, dp)}`
}

/** Compact volume/notional: 1.2K, 4.5M, 8.9B. */
export function compact(v: number | null | undefined, dp = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(dp)}T`
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(dp)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(dp)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(dp)}K`
  return `${sign}${abs.toLocaleString('en-US')}`
}

export function int(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return Math.round(v).toLocaleString('en-US')
}

/** Always shows the sign. Deltas without an explicit + are ambiguous at a glance. */
export function signed(v: number | null | undefined, dp = 0): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const s = v.toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })
  return v > 0 ? `+${s}` : s
}

export function pct(v: number | null | undefined, dp = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(dp)}%`
}

export function signedPct(v: number | null | undefined, dp = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`
}

/** snake_case / SCREAMING_SNAKE → Title Case. The JSON is snake_case throughout
 *  and raw keys were leaking into the UI ("bullish_cross", "long_gamma"). */
export function label(v: string | null | undefined): string {
  if (!v) return '—'
  return v
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Directional glyph. Paired with colour everywhere so the signal survives
 *  greyscale printing and colour-vision deficiency. */
export function arrow(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return '→'
  return v > 0 ? '▲' : '▼'
}

export function biasGlyph(bias: string | null | undefined): string {
  switch (bias) {
    case 'bullish':
    case 'positive':
    case 'bull':
    case 'rising':
    case 'above':
      return '▲'
    case 'bearish':
    case 'negative':
    case 'bear':
    case 'falling':
    case 'below':
      return '▼'
    case 'ranging':
      return '↔'
    default:
      return '●'
  }
}

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** Minutes since midnight from an "HH:MM" string, or null if unparseable. */
export function hhmmToMinutes(s: string): number | null {
  const m = HM.exec(s.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

export function clockHM(d: Date, timeZone?: string): string {
  return d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  })
}

/** "4m ago", "2h ago", "3d ago" — for the staleness pill. */
export function ago(from: Date | string, now: Date): string {
  const t = typeof from === 'string' ? new Date(from) : from
  if (Number.isNaN(t.getTime())) return 'unknown'
  const secs = Math.max(0, Math.round((now.getTime() - t.getTime()) / 1000))
  if (secs < 45) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 90) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 36) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** Minutes until a target, negative if past. */
export function minutesUntil(target: Date, now: Date): number {
  return Math.round((target.getTime() - now.getTime()) / 60000)
}

export function humanDuration(minutes: number): string {
  const m = Math.abs(Math.round(minutes))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
