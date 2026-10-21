import type { KillzoneName } from '../types/analysis'

/** Session and killzone clock.
 *
 *  All OSC-VIP V6 killzone windows are defined in New York time
 *  (`.agents/AGENTS.md` §4), so this module resolves everything through
 *  `America/New_York` rather than the browser's local zone. A trader in Phnom
 *  Penh and a trader in London must see the same killzone state.
 */

export const NY_TZ = 'America/New_York'

export interface Window {
  id: KillzoneName | 'tokyo' | 'london_full' | 'ny_full'
  label: string
  /** Minutes since NY midnight, inclusive. */
  start: number
  /** Minutes since NY midnight, exclusive. Windows never wrap past 1440 here —
   *  a wrapping session is split into two entries instead. */
  end: number
  /** Killzones are the tradeable windows; sessions are context only. */
  kind: 'killzone' | 'session'
}

const hm = (h: number, m = 0) => h * 60 + m

/** V6 killzones, verbatim from the spec. */
export const KILLZONES: Window[] = [
  { id: 'london', label: 'London KZ', start: hm(2), end: hm(5), kind: 'killzone' },
  { id: 'ny_am', label: 'NY AM KZ', start: hm(8, 30), end: hm(11), kind: 'killzone' },
  // 20:00–00:00 NY. End is 1440 (midnight) so it does not wrap.
  { id: 'asia', label: 'Asia KZ', start: hm(20), end: hm(24), kind: 'killzone' },
]

/** Broad cash sessions, for context bands behind the killzones. */
export const SESSIONS: Window[] = [
  { id: 'tokyo', label: 'Tokyo', start: hm(19), end: hm(24), kind: 'session' },
  { id: 'london_full', label: 'London', start: hm(3), end: hm(11, 30), kind: 'session' },
  { id: 'ny_full', label: 'New York', start: hm(9, 30), end: hm(16), kind: 'session' },
]

/** Minutes since midnight in a given IANA zone. Uses formatToParts rather than
 *  string parsing so it is locale- and DST-safe. */
export function minutesInZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0')
  // Some runtimes render midnight as hour "24".
  return (get('hour') % 24) * 60 + get('minute')
}

export function nyMinutes(now: Date): number {
  return minutesInZone(now, NY_TZ)
}

const inWindow = (mins: number, w: Window) => mins >= w.start && mins < w.end

export interface KillzoneState {
  /** Minutes since NY midnight. */
  nyMinutes: number
  /** Currently active killzone, or 'none'. */
  active: KillzoneName
  activeWindow: Window | null
  /** Minutes until the active window closes. Null when none is active. */
  minutesRemaining: number | null
  /** Next killzone to open, wrapping to tomorrow if needed. */
  next: Window
  minutesUntilNext: number
}

/** Live killzone state. Computed rather than read from the snapshot so the strip
 *  keeps ticking even when the underlying analysis is hours old — the snapshot's
 *  own `v6.killzone` records the state at capture, which is a different fact. */
export function killzoneState(now: Date): KillzoneState {
  const mins = nyMinutes(now)
  const activeWindow = KILLZONES.find((w) => inWindow(mins, w)) ?? null

  // Next opening today, else the first one tomorrow.
  const upcoming = KILLZONES.filter((w) => w.start > mins).sort((a, b) => a.start - b.start)
  const next = upcoming[0] ?? KILLZONES[0]
  const minutesUntilNext = upcoming[0] ? next.start - mins : 1440 - mins + next.start

  return {
    nyMinutes: mins,
    active: (activeWindow?.id as KillzoneName) ?? 'none',
    activeWindow,
    minutesRemaining: activeWindow ? activeWindow.end - mins : null,
    next,
    minutesUntilNext,
  }
}

/** Desk clocks. Every trading floor has these on the wall. */
export const DESK_CLOCKS: { label: string; tz: string }[] = [
  { label: 'LOCAL', tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
  { label: 'NY', tz: NY_TZ },
  { label: 'LON', tz: 'Europe/London' },
  { label: 'TKY', tz: 'Asia/Tokyo' },
]

/** Position of a minute-of-day on a 0–100% horizontal 24h axis. */
export function pctOfDay(minutes: number): number {
  return (minutes / 1440) * 100
}
