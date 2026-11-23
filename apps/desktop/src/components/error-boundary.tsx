import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  scope?: string;
  resetKey?: string | number | null;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.scope ? `:${this.props.scope}` : ''}] Render failure:`, error, info.componentStack);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    const isRoot = this.props.scope === 'root';
    return (
      <div className={isRoot ? 'flex min-h-screen items-center justify-center bg-background px-6 text-foreground' : 'flex min-h-0 flex-1 items-center justify-center p-6 text-foreground'}>
        <section className="w-full max-w-md rounded-2xl border border-destructive/30 bg-card p-6 shadow-lg" role="alert">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-destructive">Unexpected UI error</p>
          <h2 className="mt-2 text-lg font-semibold tracking-tight">Something went wrong in this view</h2>
          <p className="mt-2 rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground break-words">
            {this.state.error.message || 'An unexpected rendering error occurred.'}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="inline-flex h-9 flex-1 items-center justify-center rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90"
              onClick={this.handleReset}
            >
              Try again
            </button>
            <button
              type="button"
              className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition hover:bg-muted"
              onClick={() => window.location.reload()}
            >
              Reload app
            </button>
          </div>
        </section>
      </div>
    );
  }
}
