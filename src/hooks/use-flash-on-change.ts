"use client";

import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

type FlashDirection = "up" | "down" | null;

/**
 * Toggles the `pharos-data-fresh-up` / `pharos-data-fresh-down` class for 1.5s
 * whenever `value` changes — never on initial mount.
 *
 * Returns the className string to spread onto the target element.
 */
export function useFlashOnChange(
  value: number | null | undefined,
  opts?: { durationMs?: number },
): string {
  const isReduced = usePrefersReducedMotion({ ssrDefault: false });
  const durationMs = opts?.durationMs ?? 1500;
  const [previous, setPrevious] = useState<number | null | undefined>(value);
  const [direction, setDirection] = useState<FlashDirection>(null);

  // Detect change during render — React 19 idiom for previous-prop comparison.
  if (value !== previous) {
    setPrevious(value);
    if (value != null && previous != null && !isReduced) {
      setDirection(value > previous ? "up" : "down");
    }
  }

  useEffect(() => {
    if (direction == null) return;
    const t = setTimeout(() => setDirection(null), durationMs);
    return () => clearTimeout(t);
  }, [direction, durationMs]);

  if (direction === "up") return "pharos-data-fresh-up";
  if (direction === "down") return "pharos-data-fresh-down";
  return "";
}
