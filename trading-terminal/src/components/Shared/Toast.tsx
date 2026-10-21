import React, { useEffect } from 'react'

export interface ToastMessage {
  id: string
  message: string
  type?: 'info' | 'warn' | 'bull' | 'bear'
  duration?: number
}

interface ToastContainerProps {
  toasts: ToastMessage[]
  onDismiss: (id: string) => void
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  // Cap at most 2 visible toasts so they never flood the screen
  const visibleToasts = toasts.slice(-2)

  return (
    <div
      className="fixed bottom-10 right-6 z-50 flex flex-col gap-2 max-w-sm pointer-events-none"
      role="status"
      aria-live="polite"
    >
      {visibleToasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastMessage
  onDismiss: (id: string) => void
}) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(toast.id)
    }, toast.duration || 4000)
    return () => clearTimeout(timer)
  }, [toast, onDismiss])

  const styleCls = {
    info: 'bg-terminal-surface border-terminal-info/50 text-terminal-text',
    warn: 'bg-terminal-warn-deep/30 border-terminal-warn/60 text-terminal-warn',
    bull: 'bg-terminal-bull-deep/30 border-terminal-bull/60 text-terminal-bull',
    bear: 'bg-terminal-bear-deep/30 border-terminal-bear/60 text-terminal-bear',
  }[toast.type || 'info']

  const icon = {
    info: 'ℹ️',
    warn: '⚠️',
    bull: '▲',
    bear: '▼',
  }[toast.type || 'info']

  return (
    <div
      className={`pointer-events-auto p-3 rounded-lg border shadow-lg backdrop-blur flex items-start gap-2.5 transition-all transform animate-in slide-in-from-bottom-2 ${styleCls}`}
    >
      <span className="text-sm shrink-0 font-mono">{icon}</span>
      <p className="text-2xs font-medium leading-relaxed flex-1">{toast.message}</p>
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-2xs opacity-60 hover:opacity-100 p-0.5"
        aria-label="Dismiss toast"
      >
        ✕
      </button>
    </div>
  )
}
