"use client";

import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

type FlashDirection = "up" | "down" | null;
type FlashState = {
  direction: FlashDirection;
  nonce: number;
};

const UP_FLASH_CLASSES = [
  "pharos-data-fresh-up pharos-data-fresh-up-a",
  "pharos-data-fresh-up pharos-data-fresh-up-b",
] as const;
const DOWN_FLASH_CLASSES = [
  "pharos-data-fresh-down pharos-data-fresh-down-a",
  "pharos-data-fresh-down pharos-data-fresh-down-b",
] as const;

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
  const [flash, setFlash] = useState<FlashState>({ direction: null, nonce: 0 });

  // Detect change during render — React 19 idiom for previous-prop comparison.
  if (value !== previous) {
    setPrevious(value);
    if (value != null && previous != null && !isReduced) {
      const direction = value > previous ? "up" : "down";
      setFlash((current) => ({ direction, nonce: current.nonce + 1 }));
    }
  }

  useEffect(() => {
    if (flash.direction == null) return;
    const nonce = flash.nonce;
    const t = setTimeout(() => {
      setFlash((current) =>
        current.nonce === nonce ? { ...current, direction: null } : current,
      );
    }, durationMs);
    return () => clearTimeout(t);
  }, [flash, durationMs]);

  if (flash.direction === "up") return UP_FLASH_CLASSES[flash.nonce % 2];
  if (flash.direction === "down") return DOWN_FLASH_CLASSES[flash.nonce % 2];
  return "";
}
