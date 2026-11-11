"use client";

import type { ReactNode } from "react";
// eslint-disable-next-line no-restricted-imports -- this wrapper supplies the homepage's neutral fallback.
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { cn } from "@/lib/utils";

/**
 * Homepage section boundary: a render crash is still logged by
 * SectionErrorBoundary, but the section shows a calm muted placeholder in its
 * card shape instead of the "temporarily unavailable" notice and retry
 * (docs/homepage.md#data-health).
 */
export function HomeSectionErrorBoundary({
  name,
  className,
  children,
}: {
  name: string;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <SectionErrorBoundary
      name={name}
      fallback={
        <div className={cn("pharos-card-shell flex min-h-32 items-center justify-center p-6", className)}>
          <span className="pharos-meta">Updating</span>
        </div>
      }
    >
      {children}
    </SectionErrorBoundary>
  );
}
