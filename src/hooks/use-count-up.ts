"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

interface CountUpOptions {
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
}

/** Decelerate easing: fast start, smooth landing */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function formatNumber(value: number, decimals: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function useCountUp(target: number, opts?: CountUpOptions): string {
  const {
    duration = 600,
    decimals = Number.isInteger(target) ? 0 : 1,
    prefix = "",
    suffix = "",
  } = opts ?? {};

  const reducedMotion = usePrefersReducedMotion({ ssrDefault: true });
  const [display, setDisplay] = useState(() =>
    reducedMotion ? target : 0,
  );
  const fromRef = useRef(0);
  const rafRef = useRef<number>(0);
  const startRef = useRef(0);

  useEffect(() => {
    if (reducedMotion) {
      fromRef.current = target;
      return;
    }

    const from = fromRef.current;
    const delta = target - from;
    if (delta === 0) return;

    startRef.current = performance.now();

    function tick(now: number) {
      const elapsed = now - startRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutCubic(progress);
      const current = from + delta * eased;

      setDisplay(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      // Capture current display value as the starting point for the next animation
      fromRef.current = from + delta * easeOutCubic(
        Math.min((performance.now() - startRef.current) / duration, 1),
      );
    };
  }, [target, duration, reducedMotion]);

  const value = reducedMotion ? target : display;

  return `${prefix}${formatNumber(value, decimals)}${suffix}`;
}
