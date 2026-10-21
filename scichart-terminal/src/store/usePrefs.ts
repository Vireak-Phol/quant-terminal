import { useCallback, useEffect, useMemo, useState } from 'react'

/** User preferences, persisted to localStorage. Theme and density are written to
 *  <html> as data attributes so CSS owns the cascade and no component needs to
 *  know the active theme. */

export type Theme = 'dark' | 'contrast' | 'light'
export type Density = 'compact' | 'normal' | 'comfortable'

export interface Prefs {
  theme: Theme
  density: Density
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  density: 'normal',
}

const KEY = 'terminal.prefs.v1'

const THEMES: Theme[] = ['dark', 'contrast', 'light']
const DENSITIES: Density[] = ['compact', 'normal', 'comfortable']

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<Prefs>
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      theme: THEMES.includes(parsed.theme as Theme) ? (parsed.theme as Theme) : DEFAULT_PREFS.theme,
      density: DENSITIES.includes(parsed.density as Density)
        ? (parsed.density as Density)
        : DEFAULT_PREFS.density,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(load)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = prefs.theme
    root.dataset.density = prefs.density
  }, [prefs.theme, prefs.density])

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs))
    } catch {
      /* private browsing / quota — degrade to session-only */
    }
  }, [prefs])

  const cycleTheme = useCallback(() => {
    setPrefs((p) => ({ ...p, theme: THEMES[(THEMES.indexOf(p.theme) + 1) % THEMES.length] }))
  }, [])

  const cycleDensity = useCallback(() => {
    setPrefs((p) => ({
      ...p,
      density: DENSITIES[(DENSITIES.indexOf(p.density) + 1) % DENSITIES.length],
    }))
  }, [])

  return useMemo(() => ({ prefs, cycleTheme, cycleDensity }), [prefs, cycleTheme, cycleDensity])
}

export type PrefsApi = ReturnType<typeof usePrefs>
