"use client";

import { useEffect, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface UsePrefersReducedMotionOptions {
  ssrDefault?: boolean;
}

function readPrefersReducedMotion(ssrDefault: boolean): boolean {
  if (typeof window === "undefined") return ssrDefault;
  return window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? ssrDefault;
}

export function usePrefersReducedMotion({
  ssrDefault = false,
}: UsePrefersReducedMotionOptions = {}): boolean {
  const [isReduced, setIsReduced] = useState(() => readPrefersReducedMotion(ssrDefault));

  useEffect(() => {
    const media = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!media) return;

    const handleChange = (event: MediaQueryListEvent) => setIsReduced(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return isReduced;
}
