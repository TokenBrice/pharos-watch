"use client";

import { Component, type ReactNode } from "react";

interface SectionErrorBoundaryProps {
  section: string;
  children: ReactNode;
}

interface SectionErrorBoundaryState {
  error: Error | null;
}

export class SectionErrorBoundary extends Component<SectionErrorBoundaryProps, SectionErrorBoundaryState> {
  state: SectionErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): SectionErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error(`[admin] section "${this.props.section}" crashed:`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <section
          role="alert"
          aria-live="polite"
          className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-red-700 shadow-[0_10px_32px_oklch(0_0_0_/0.12)] dark:text-red-300"
        >
          <div className="text-sm font-semibold">Section failed to render: {this.props.section}</div>
          <p className="mt-2 text-sm leading-relaxed">
            {this.state.error.message}
          </p>
          <p className="mt-2 text-xs text-red-700/80 dark:text-red-300/80">
            Other sections continue to work. Refresh or sign out if the issue persists.
          </p>
        </section>
      );
    }
    return this.props.children;
  }
}
