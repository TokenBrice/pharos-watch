"use client";

import type { ReactNode } from "react";
import { useNearViewport } from "@/hooks/use-near-viewport";

interface LazySectionProps {
  /** Minimum height in px to reserve while gated, prevents CLS. */
  minHeight: number;
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
export function LazySection({ minHeight, rootMargin, children }: LazySectionProps) {
  const { ref, near } = useNearViewport<HTMLDivElement>(rootMargin);
  return (
    <div ref={ref} style={{ minHeight }}>
      {near ? children : null}
    </div>
  );
}
