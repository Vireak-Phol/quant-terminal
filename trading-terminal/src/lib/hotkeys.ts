import { useEffect, useRef } from 'react'

/** Global keyboard shortcuts.
 *
 *  The terminal is meant to be driven without a mouse, so the hotkey layer is
 *  infrastructure, not a convenience. Two rules matter:
 *
 *  1. Never steal a key while the user is typing. Firing "d: toggle density"
 *     because someone typed "d" into the symbol box is the single most common way
 *     hand-rolled hotkeys become unusable.
 *  2. Never shadow a browser or OS shortcut. Bare letters only; modifiers are
 *     reserved except for the deliberate Cmd/Ctrl+K palette.
 */

export interface Hotkey {
  /** Lowercase `event.key`, e.g. 'k', '1', '[', '?'. */
  key: string
  /** Requires Cmd (macOS) or Ctrl. */
  mod?: boolean
  shift?: boolean
  handler: (e: KeyboardEvent) => void
  /** Fire even while a field has focus — for Escape and the palette. */
  allowInInput?: boolean
  /** Shown in the shortcut overlay. Omit to hide from the cheatsheet. */
  description?: string
  group?: string
}

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function isTypingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (EDITABLE.has(el.tagName)) return true
  return el.isContentEditable === true
}

/** Registers hotkeys for the lifetime of the component.
 *  Handlers are held in a ref so callers can pass inline closures without
 *  re-binding the listener on every render. */
export function useHotkeys(hotkeys: Hotkey[], enabled = true): void {
  const ref = useRef(hotkeys)
  ref.current = hotkeys

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      const typing = isTypingInto(e.target)
      const key = e.key.toLowerCase()
      const mod = e.metaKey || e.ctrlKey

      for (const h of ref.current) {
        if (h.key.toLowerCase() !== key) continue
        if (!!h.mod !== mod) continue
        if (h.shift !== undefined && h.shift !== e.shiftKey) continue
        if (typing && !h.allowInInput) continue
        // Alt is left alone: it composes accented characters on many layouts.
        if (e.altKey && !h.mod) continue
        e.preventDefault()
        h.handler(e)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}

/** Platform-correct modifier glyph for display. */
export const MOD_LABEL: string =
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
    ? '⌘'
    : 'Ctrl'

export function hotkeyLabel(h: Pick<Hotkey, 'key' | 'mod' | 'shift'>): string {
  const parts: string[] = []
  if (h.mod) parts.push(MOD_LABEL)
  if (h.shift) parts.push('⇧')
  parts.push(h.key === ' ' ? 'Space' : h.key.length === 1 ? h.key.toUpperCase() : h.key)
  return parts.join(MOD_LABEL === '⌘' ? '' : '+')
}

/** Traps Tab inside a container — required for the palette and overlay dialogs,
 *  otherwise keyboard focus escapes to the page behind the modal. */
export function useFocusTrap(active: boolean, containerRef: React.RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!active) return
    const el = containerRef.current
    if (!el) return

    const previouslyFocused = document.activeElement as HTMLElement | null

    const focusables = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((n) => n.offsetParent !== null || n === document.activeElement)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const nodes = focusables()
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [active, containerRef])
}
