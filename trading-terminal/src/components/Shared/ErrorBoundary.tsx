import React, { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  title?: string
  children: ReactNode
  onReset?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Panel Error Boundary caught an error:', error, errorInfo)
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null })
    if (this.props.onReset) {
      this.props.onReset()
    }
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 rounded-lg bg-terminal-surface/80 border border-terminal-warn/30 text-terminal-text flex flex-col items-start gap-2">
          <div className="flex items-center gap-2 text-terminal-warn font-semibold text-xs uppercase tracking-wider">
            <span>⚠️</span>
            <span>{this.props.title || 'Panel'} Error</span>
          </div>
          <p className="text-2xs text-terminal-text-dim font-mono break-all">
            {this.state.error?.message || 'An unexpected rendering error occurred.'}
          </p>
          <button
            onClick={this.handleReset}
            className="mt-2 text-2xs px-2.5 py-1 rounded bg-terminal-surface border border-terminal-border hover:bg-terminal-card transition-colors text-terminal-text"
          >
            Reload Panel
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
