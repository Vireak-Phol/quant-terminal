/** New-signal alert detection + a short synthesized chime (no audio assets needed). */

import type { EngineSignal, V74Frame } from '../types/v74'

/** Return A+ signals in ``frame`` that are new (live, open) and not in ``seen``. Mutates ``seen``. */
export function newAplusSignals(frame: V74Frame | null | undefined, seen: Set<string>, firstLoad: boolean): EngineSignal[] {
  const out: EngineSignal[] = []
  if (!frame?.frames) return out
  for (const fr of Object.values(frame.frames)) {
    for (const s of fr?.latest ?? []) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      // On first frame we only mark existing ids as seen; nothing is "new" yet.
      if (!firstLoad && s.tier === 'A_PLUS' && s.status === 'open') out.push(s)
    }
  }
  return out
}

let ctx: AudioContext | null = null

export function playChime(direction: 'LONG' | 'SHORT'): void {
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext
    if (!AC) return
    ctx = ctx ?? new AC()
    const c = ctx!
    const notes = direction === 'LONG' ? [660, 880] : [880, 660]
    notes.forEach((f, i) => {
      const o = c.createOscillator()
      const g = c.createGain()
      o.type = 'sine'
      o.frequency.value = f
      const t0 = c.currentTime + i * 0.16
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(0.15, t0 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15)
      o.connect(g).connect(c.destination)
      o.start(t0)
      o.stop(t0 + 0.16)
    })
  } catch {
    // Autoplay policies may block audio until the user interacts; the toast still shows.
  }
}
