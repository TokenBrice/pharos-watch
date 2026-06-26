"use client";

import { useCallback, useEffect, useState } from "react";

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
  const [target, setTarget] = useState<T | null>(null);
  const [near, setNear] = useState(false);
  const ref = useCallback((el: T | null) => {
    setTarget(el);
  }, []);

  useEffect(() => {
    if (near || !target) return;
    if (typeof window === "undefined" || typeof window.IntersectionObserver === "undefined") {
      // Defensive — older browsers + jsdom mount immediately. The setState
      // here is one-shot at first mount (the `near` dep returns early on the
      // next render), so the "cascade" lint warning is a false positive.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    io.observe(target);
    return () => {
      io.disconnect();
    };
  }, [near, rootMargin, target]);

  return { ref, near };
}
