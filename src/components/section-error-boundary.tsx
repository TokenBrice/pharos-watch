"use client";

import { Component, type ReactNode } from "react";

interface Props {
  name: string;
  children: ReactNode;
  supportingText?: string;
}

interface State {
  hasError: boolean;
}

export class SectionErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.name}] render error:`, error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-lg border border-border/50 bg-muted/30 p-6 text-center">
          <p className="text-sm font-medium text-foreground">The {this.props.name} section is temporarily unavailable.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {this.props.supportingText ?? "Please try again. Existing page content is still safe to use."}
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="mt-2 text-sm font-medium text-foreground hover:underline"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
