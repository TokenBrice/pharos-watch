"use client";

import { useEffect, useRef, useState } from "react";

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

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useCountUp(target: number, opts?: CountUpOptions): string {
  const {
    duration = 600,
    decimals = Number.isInteger(target) ? 0 : 1,
    prefix = "",
    suffix = "",
  } = opts ?? {};

  const [display, setDisplay] = useState(() =>
    prefersReducedMotion() ? target : 0,
  );
  const fromRef = useRef(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplay(target);
      return;
    }

    const from = fromRef.current;
    const delta = target - from;
    if (delta === 0) return;

    const start = performance.now();

    function tick(now: number) {
      const elapsed = now - start;
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
        Math.min((performance.now() - start) / duration, 1),
      );
    };
  }, [target, duration]);

  return `${prefix}${formatNumber(display, decimals)}${suffix}`;
}
