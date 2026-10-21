import React, { useState, ReactNode } from 'react'
import { ErrorBoundary } from './ErrorBoundary'

interface PanelProps {
  title: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  loading?: boolean
  empty?: boolean
  emptyMessage?: string
  className?: string
  collapsible?: boolean
  defaultCollapsed?: boolean
  headerBadge?: ReactNode
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  loading = false,
  empty = false,
  emptyMessage,
  className = '',
  collapsible = false,
  defaultCollapsed = false,
  headerBadge,
}: PanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  return (
    <div
      className={`bg-terminal-card border border-terminal-border rounded-lg shadow-sm overflow-hidden flex flex-col ${className}`}
    >
      <div className="flex items-center justify-between px-4 py-2.5 bg-terminal-surface/30 border-b border-terminal-border/60">
        <div className="flex items-center gap-2.5 min-w-0">
          {collapsible && (
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="text-terminal-text-dim hover:text-terminal-text transition-colors p-0.5"
              aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
            >
              <span className="text-[10px] font-mono">{collapsed ? '►' : '▼'}</span>
            </button>
          )}
          <div className="flex items-baseline gap-2 min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-terminal-text truncate">
              {title}
            </h3>
            {subtitle && (
              <span className="text-2xs text-terminal-text-dim truncate hidden sm:inline">
                {subtitle}
              </span>
            )}
          </div>
          {headerBadge}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>

      {!collapsed && (
        <div className="p-4 flex-1 flex flex-col min-h-0">
          <ErrorBoundary title={title}>
            {loading ? (
              <div className="h-32 flex items-center justify-center font-mono text-2xs text-terminal-text-dim animate-pulse">
                Loading...
              </div>
            ) : empty ? (
              <div className="p-6 text-center font-mono text-2xs text-terminal-text-dim">
                {emptyMessage || `${title} Unavailable`}
              </div>
            ) : (
              children
            )}
          </ErrorBoundary>
        </div>
      )}
    </div>
  )
}
