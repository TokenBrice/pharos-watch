"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

const DEFAULT_FORMATTER = new Intl.NumberFormat("en-US");
const DEFAULT_DURATION_MS = 900;

interface UseCountUpOptions {
  /** Total animation time once the target changes. */
  durationMs?: number;
  /** Formats the current (possibly mid-flight) value for display. */
  format?: (value: number) => string;
}

/** Exponential-out easing, matching the system's decelerating motion language. */
function easeOutExpo(progress: number): number {
  return progress >= 1 ? 1 : 1 - Math.pow(2, -10 * progress);
}

/**
 * Animates a numeric value toward `target` with requestAnimationFrame. The
 * first real value counts up from zero; later live updates tween from the
 * current display value. Reduced-motion users (and the explicit user
 * override) get the final value instantly. Returns `null` until a real value
 * exists so callers can stay quiet instead of flashing a placeholder.
 */
export function useCountUp(target: number | null | undefined, options: UseCountUpOptions = {}) {
  const { durationMs = DEFAULT_DURATION_MS, format } = options;
  const reduceMotion = usePrefersReducedMotion();
  const [displayValue, setDisplayValue] = useState<number | null>(target ?? null);
  const displayRef = useRef<number | null>(target ?? null);

  useEffect(() => {
    if (target == null || !Number.isFinite(target)) return;
    const from = displayRef.current ?? 0;
    if (reduceMotion || from === target || durationMs <= 0) {
      displayRef.current = target;
      // One-shot settle, not a subscription — same false positive as the
      // IntersectionObserver fallback in use-near-viewport.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDisplayValue(target);
      return;
    }
    let frame = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const next = from + (target - from) * easeOutExpo(progress);
      displayRef.current = next;
      setDisplayValue(next);
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, reduceMotion, durationMs]);

  return {
    value: displayValue,
    display:
      displayValue == null ? null : (format ?? ((value) => DEFAULT_FORMATTER.format(Math.round(value))))(displayValue),
  };
}
