import type { HeavyAbsorptionPoint } from '../../lib/absorption'
import { price } from '../../lib/format'

export interface AbsorptionModalData {
  /** epoch seconds of the bubble anchor */
  time: number
  /** anchor price (candle high/low or mid) */
  anchorPrice: number
  /** aggressor side absorbed ("buy" = buyers absorbed, "sell" = sellers absorbed) */
  side?: "buy" | "sell"
  /** detected absorption point (null for a live-tape footprint) */
  point: HeavyAbsorptionPoint | null
}

interface Props {
  data: AbsorptionModalData
  onClose: () => void
}

/** Click-to-inspect modal for an absorption bubble — the "🎯 Heavy Absorption
 *  Detector" panel. Shows anchor, rolling volume ratio, wick rejection and an
 *  institutional thesis. */
export function AbsorptionModal({ data, onClose }: Props) {
  const p = data.point
  const isBuyAbs = p ? p.type === 'buyers_absorbed' : data.side !== 'sell'
  const when = new Date(data.time * 1000).toLocaleString()

  const tone = isBuyAbs
    ? 'border-terminal-bear/60 bg-terminal-bear-deep/20'
    : 'border-terminal-bull/60 bg-terminal-bull-deep/20'
  const accent = isBuyAbs ? 'text-terminal-bear' : 'text-terminal-bull'

  const thesis = isBuyAbs
    ? 'Aggressive buyers trapped into resting ask liquidity — upper-wick rejection on elevated volume. Sellers absorbed the demand without conceding price; watch for a fade back inside range.'
    : 'Aggressive sellers absorbed into resting bid liquidity — lower-wick rejection on elevated volume. Buyers soaked up the supply; watch for a bounce from this shelf.'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Heavy Absorption detail"
      onClick={onClose}
    >
      <div
        className={`w-[22rem] max-w-[90vw] rounded-xl border-2 ${tone} bg-terminal-surface/98 shadow-2xl font-mono text-xs`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border/70">
          <div className="flex items-center gap-2">
            <span className="text-base">🎯</span>
            <span className="font-bold tracking-wider uppercase text-terminal-text">
              Heavy Absorption Detector
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-terminal-text-dim hover:text-terminal-text text-sm font-bold px-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className={`text-sm font-extrabold ${accent}`}>
            {isBuyAbs ? '▲ BUYERS ABSORBED' : '▼ SELLERS ABSORBED'}
          </div>

          <dl className="space-y-1.5">
            <Row label="Anchor price" value={price(data.anchorPrice)} />
            <Row label="Timestamp" value={when} />
            {p && <Row label="Volume ratio vs 20-SMA" value={`${p.volRatio}%`} accent={accent} />}
            {p && (
              <Row
                label={`${isBuyAbs ? 'Upper' : 'Lower'} wick rejection`}
                value={`${p.wickPercent}%`}
                accent={accent}
              />
            )}
            {p && (
              <Row
                label="Candle"
                value={p.isBullishCandle ? 'bullish body' : 'bearish body'}
              />
            )}
            {!p && <Row label="Source" value="live order-flow tape footprint" />}
          </dl>

          <div className="pt-2 border-t border-terminal-border/50">
            <p className="text-[10px] uppercase tracking-wider text-terminal-text-dim mb-1">
              Institutional thesis
            </p>
            <p className="text-2xs text-terminal-text leading-relaxed">{thesis}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-terminal-text-dim">{label}</dt>
      <dd className={`font-bold tabular-nums ${accent ?? 'text-terminal-text'}`}>{value}</dd>
    </div>
  )
}
