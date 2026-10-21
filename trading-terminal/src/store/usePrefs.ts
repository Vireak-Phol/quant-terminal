import { useCallback, useEffect, useMemo, useState } from 'react'

/** User preferences, persisted to localStorage.
 *
 *  Density, theme and layout are workstation-level settings: a trader configures
 *  them once and expects them on every reload. Sizing inputs (equity, risk %) live
 *  here too so the trade-plan panel is not re-keyed every session.
 *
 *  Theme and density are written to <html> as data attributes rather than held in
 *  React alone, so CSS owns the cascade and no component needs to know the theme.
 */

export type Theme = 'dark' | 'contrast' | 'light'
export type Density = 'compact' | 'normal' | 'comfortable'
export type LayoutPreset = 'single' | 'split' | 'quad' | 'six'

export interface Prefs {
  theme: Theme
  density: Density
  layout: LayoutPreset
  /** Panel id per workspace cell. */
  cells: string[]
  /** Account equity for position sizing. */
  equity: number
  /** Percent of equity risked per trade. */
  riskPct: number
  /** Units per lot/contract for the instrument being sized. */
  contractSize: number
  /** Show the "vs prior session" chips. Off for a cleaner screen. */
  showDeltas: boolean
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  density: 'normal',
  layout: 'quad',
  cells: ['confluence', 'ladder', 'cvd', 'sessions'],
  equity: 100_000,
  riskPct: 0.5,
  contractSize: 100,
  showDeltas: true,
}

const KEY = 'terminal.prefs.v1'

const THEMES: Theme[] = ['dark', 'contrast', 'light']
const DENSITIES: Density[] = ['compact', 'normal', 'comfortable']

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<Prefs>
    // Merge over defaults rather than trusting the stored shape — a prefs blob
    // from an older build must not leave the app with undefined fields.
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      theme: THEMES.includes(parsed.theme as Theme) ? (parsed.theme as Theme) : DEFAULT_PREFS.theme,
      density: DENSITIES.includes(parsed.density as Density)
        ? (parsed.density as Density)
        : DEFAULT_PREFS.density,
      cells: Array.isArray(parsed.cells) ? parsed.cells : DEFAULT_PREFS.cells,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(load)

  // CSS is the source of truth for appearance; React only sets the switch.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = prefs.theme
    root.dataset.density = prefs.density
  }, [prefs.theme, prefs.density])

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs))
    } catch {
      // Private browsing / quota. Preferences degrade to session-only, which is
      // not worth interrupting the user over.
    }
  }, [prefs])

  const set = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((p) => ({ ...p, [key]: value }))
  }, [])

  const cycleTheme = useCallback(() => {
    setPrefs((p) => ({ ...p, theme: THEMES[(THEMES.indexOf(p.theme) + 1) % THEMES.length] }))
  }, [])

  const cycleDensity = useCallback(() => {
    setPrefs((p) => ({
      ...p,
      density: DENSITIES[(DENSITIES.indexOf(p.density) + 1) % DENSITIES.length],
    }))
  }, [])

  const setCell = useCallback((index: number, panelId: string) => {
    setPrefs((p) => {
      const cells = [...p.cells]
      cells[index] = panelId
      return { ...p, cells }
    })
  }, [])

  const reset = useCallback(() => setPrefs(DEFAULT_PREFS), [])

  return useMemo(
    () => ({ prefs, set, cycleTheme, cycleDensity, setCell, reset }),
    [prefs, set, cycleTheme, cycleDensity, setCell, reset],
  )
}

export type PrefsApi = ReturnType<typeof usePrefs>
