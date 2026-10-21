interface MetricTileProps {
  label: string
  value: string | number
  sub?: string
  color?: 'default' | 'green' | 'red' | 'gold' | 'warn' | 'info' | 'muted'
  glyph?: string
  className?: string
}

export function MetricTile({
  label,
  value,
  sub,
  color = 'default',
  glyph,
  className = '',
}: MetricTileProps) {
  const valueColor = {
    default: 'text-terminal-text',
    green: 'text-terminal-bull',
    red: 'text-terminal-bear',
    gold: 'text-terminal-accent',
    warn: 'text-terminal-warn',
    info: 'text-terminal-info',
    muted: 'text-terminal-text-dim',
  }[color]

  return (
    <div
      className={`metric p-3 bg-terminal-surface/50 rounded-lg border border-terminal-border/50 flex flex-col justify-between ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="metric-label flex items-center gap-1 font-mono text-2xs text-terminal-text-dim">
          {glyph && <span className="font-mono text-xs opacity-75">{glyph}</span>}
          {label}
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 font-mono">
        <span className={`metric-value font-bold text-sm ${valueColor}`}>{value}</span>
        {sub && <span className="text-2xs text-terminal-text-dim">{sub}</span>}
      </div>
    </div>
  )
}
