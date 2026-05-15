"use client";

import type { ReactNode } from "react";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { isLazyChartsEnabled } from "@/lib/feature-flags";

interface LazySectionProps {
  /** Minimum height in px to reserve while gated, prevents CLS. */
  minHeight: number;
  /** Optional IntersectionObserver rootMargin override. */
  rootMargin?: string;
  children: ReactNode;
}

/**
 * Defers child mounting until the wrapper approaches the viewport.
 * Flag-off and SSR paths render children immediately so SEO is unaffected.
 */
export function LazySection({ minHeight, rootMargin, children }: LazySectionProps) {
  const enabled = isLazyChartsEnabled();
  const { ref, near } = useNearViewport<HTMLDivElement>(rootMargin);
  if (!enabled) return <>{children}</>;
  return (
    <div ref={ref} style={{ minHeight }}>
      {near ? children : null}
    </div>
  );
}
