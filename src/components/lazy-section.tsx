"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNearViewport } from "@/hooks/use-near-viewport";

interface LazySectionProps {
  /** Minimum height in px to reserve while gated, prevents CLS. */
  minHeight?: number;
  /** Optional responsive min-height utility classes for adaptive chart shells. */
  className?: string;
  /** Optional IntersectionObserver rootMargin override. */
  rootMargin?: string;
  /** Mount a known anchor target without discarding its reserved geometry. */
  forceMount?: boolean;
  /** Optional content shown in the reserved space while gated, so the reserve
   * reads as a loading surface instead of a blank void. */
  placeholder?: ReactNode;
  children: ReactNode;
}

/**
 * Defers child mounting until the wrapper approaches the viewport.
 * `useNearViewport` is SSR-safe: it returns `near=false` on the server and on
 * the first client render, then flips to `true` from a mount effect when the
 * element approaches the viewport (or immediately when `IntersectionObserver`
 * is unavailable).
 *
 * The reserve outlives the mount: mounted children usually pass through a
 * chunk-load or fetch state shorter than the reserve, and collapsing to it
 * while the section is on screen shoves everything below (layout shift). The
 * reserve is released only once the wrapper is off screen, where the browser's
 * scroll anchoring absorbs any height change.
 */
export function LazySection({ minHeight, className, rootMargin, forceMount = false, placeholder, children }: LazySectionProps) {
  const { ref, near } = useNearViewport<HTMLDivElement>(rootMargin);
  const [revealed, setRevealed] = useState(false);
  const mounted = near || forceMount || revealed;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [holdReserve, setHoldReserve] = useState(true);
  const setRefs = useCallback((el: HTMLDivElement | null) => {
    wrapperRef.current = el;
    ref(el);
  }, [ref]);

  useEffect(() => {
    const el = wrapperRef.current;
    const reveal = () => setRevealed(true);
    el?.addEventListener("pharos:lazy-section-reveal", reveal);
    return () => el?.removeEventListener("pharos:lazy-section-reveal", reveal);
  }, []);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!mounted || !holdReserve || !el || typeof IntersectionObserver === "undefined") return;
    let wasVisible = false;
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      // Release on the first exit after the section has been seen, so a
      // section mounted inside the 300px margin keeps its reserve until read.
      if (entry.isIntersecting) {
        wasVisible = true;
        return;
      }
      if (!wasVisible) return;
      // Above the viewport, scroll anchoring absorbs the shrink only while the
      // page has that much scroll room left below; at the page end the scroll
      // position would clamp and visibly jump, so keep the reserve for now.
      if (entry.boundingClientRect.bottom <= 0) {
        let contentHeight = 0;
        for (const child of Array.from(el.children)) contentHeight += (child as HTMLElement).offsetHeight;
        const shrink = el.offsetHeight - contentHeight;
        const roomBelow = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
        if (shrink > roomBelow) return;
      }
      setHoldReserve(false);
      io.disconnect();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [holdReserve, mounted]);

  const reserve = !mounted || holdReserve;
  return (
    <div
      ref={setRefs}
      data-lazy-section=""
      className={reserve ? className : undefined}
      style={reserve && minHeight != null ? { minHeight } : undefined}
    >
      {mounted ? children : placeholder ?? null}
    </div>
  );
}
