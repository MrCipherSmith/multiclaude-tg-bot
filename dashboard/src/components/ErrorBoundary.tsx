import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  /** Optional fallback override; defaults to a small inline message. */
  fallback?: (err: Error, reset: () => void) => ReactNode;
}

interface State {
  err: Error | null;
}

/**
 * Catches render-time exceptions in any child route component so a single
 * page bug doesn't unmount the entire dashboard layout (sidebar + nav).
 *
 * Why: react-query throws into the component tree when a fetch fails
 * with malformed JSON, an unexpected null shape, or a missing required
 * field. Without a boundary, the whole `<Outlet />` subtree disappears
 * and the user sees a blank panel with no way back.
 *
 * The reset() callback re-renders the children — usually enough to
 * recover after the user navigates to a different route or fixes the
 * underlying data issue.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    // Log to console for operator inspection. Never silently swallow —
    // the dashboard is operator-facing tooling, transparency > polish.
    console.error("[dashboard ErrorBoundary]", err, info?.componentStack);
  }

  reset = () => this.setState({ err: null });

  render() {
    if (this.state.err) {
      if (this.props.fallback) return this.props.fallback(this.state.err, this.reset);
      return (
        <div className="bg-red-900/30 border border-red-800 rounded-lg p-6 max-w-2xl mx-auto mt-8">
          <h2 className="text-lg font-semibold text-red-300 mb-2">Page error</h2>
          <p className="text-sm text-red-200 mb-3">
            {this.state.err.message || "Something went wrong rendering this page."}
          </p>
          <pre className="text-xs text-red-200/70 bg-black/30 p-3 rounded overflow-auto max-h-64 mb-4">
            {this.state.err.stack?.split("\n").slice(0, 8).join("\n") ?? this.state.err.message}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={this.reset}
              className="text-sm px-3 py-1.5 rounded bg-red-700 hover:bg-red-600 text-white"
            >
              Try again
            </button>
            <button
              onClick={() => (window.location.href = "/")}
              className="text-sm px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200"
            >
              Back to overview
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
