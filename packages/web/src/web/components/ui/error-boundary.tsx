import * as React from "react";

/**
 * Keeps a render error inside the panel that threw it instead of blanking the
 * whole app. Wrap drawers and other secondary surfaces; the page itself should
 * still fail loudly.
 *
 * Remount it (via `key`) when the subject changes so the error state resets.
 */
interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** What to show instead of the crashed subtree. */
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

  componentDidCatch(error: Error): void {
    console.error("[ErrorBoundary]", error);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <p className="text-[13px] text-muted-foreground">
            This panel failed to render. Close it and try again.
          </p>
        )
      );
    }
    return this.props.children;
  }
}