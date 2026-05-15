"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Returns a ref + a "near" boolean that flips to `true` once the element
 * enters or approaches the viewport. The flag is sticky — once true, it
 * never goes back to false (the IntersectionObserver disconnects).
 *
 * Server-side rendering: SSR has no IntersectionObserver, so the initial
 * value is `false` only on the client; SSR consumers should treat the
 * `near` flag as opaque and not gate critical-for-SEO content on it.
 */
export function useNearViewport<T extends HTMLElement>(rootMargin = "300px") {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    if (typeof window === "undefined" || typeof window.IntersectionObserver === "undefined") {
      // Defensive — older browsers + jsdom. Mount immediately.
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [near, rootMargin]);

  return { ref, near };
}
