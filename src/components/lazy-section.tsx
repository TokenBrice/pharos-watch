"use client";

import type { ReactNode } from "react";
import { useNearViewport } from "@/hooks/use-near-viewport";

interface LazySectionProps {
  /** Minimum height in px to reserve while gated, prevents CLS. */
  minHeight?: number;
  /** Optional responsive min-height utility classes for adaptive chart shells. */
  className?: string;
  /** Optional IntersectionObserver rootMargin override. */
  rootMargin?: string;
  children: ReactNode;
}

/**
 * Defers child mounting until the wrapper approaches the viewport.
 * `useNearViewport` is SSR-safe: it returns `near=false` on the server and on
 * the first client render, then flips to `true` from a mount effect when the
 * element approaches the viewport (or immediately when `IntersectionObserver`
 * is unavailable).
 */
export function LazySection({ minHeight, className, rootMargin, children }: LazySectionProps) {
  const { ref, near } = useNearViewport<HTMLDivElement>(rootMargin);
  return (
    <div
      ref={ref}
      className={near ? undefined : className}
      style={!near && minHeight != null ? { minHeight } : undefined}
    >
      {near ? children : null}
    </div>
  );
}
