"use client";

import { Component, type ReactNode } from "react";

interface Props {
  name: string;
  children: ReactNode;
  supportingText?: string;
}

interface State {
  hasError: boolean;
  retryCount: number;
}

const MAX_RETRIES = 3;

export class SectionErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, retryCount: 0 };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.name}] render error:`, error);
  }

  render() {
    if (this.state.hasError) {
      const canRetry = this.state.retryCount < MAX_RETRIES;
      return (
        <div role="alert" className="rounded-lg border border-border/50 bg-muted/30 p-6 text-center">
          <p className="text-sm font-medium text-foreground">The {this.props.name} section is temporarily unavailable.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {this.props.supportingText ?? "Please try again. Existing page content is still safe to use."}
          </p>
          {canRetry ? (
            <button
              onClick={() => this.setState((prev) => ({ hasError: false, retryCount: prev.retryCount + 1 }))}
              className="mt-2 text-sm font-medium text-foreground hover:underline pharos-focus-ring"
            >
              Try again ({MAX_RETRIES - this.state.retryCount} {MAX_RETRIES - this.state.retryCount === 1 ? "retry" : "retries"} left)
            </button>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Please refresh the page to try again.
            </p>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
