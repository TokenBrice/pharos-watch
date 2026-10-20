"use client";

import { useEffect, useState } from "react";
import { useHydrated } from "@/hooks/use-hydrated";
import { deriveDataHealth, getDataHealthBoundaries } from "@/lib/data-health";

type FreshnessInput = Parameters<typeof deriveDataHealth>[0];

/** A local render at the next health crossing, never a poll or an application-wide tick. */
export function useFreshnessBoundary(inputs: readonly FreshnessInput[], enabled = true): number | undefined {
  const hydrated = useHydrated();
  const [nowMs, setNowMs] = useState<number>();
  const boundaryKey = inputs.flatMap(getDataHealthBoundaries).join(",");

  useEffect(() => {
    if (!hydrated || !enabled || !boundaryKey) return;
    const boundaries = boundaryKey.split(",").map(Number);
    let timer: number | undefined;
    const schedule = () => {
      const now = Date.now();
      const next = boundaries.reduce((earliest, boundary) => boundary > now ? Math.min(earliest, boundary) : earliest, Infinity);
      if (!Number.isFinite(next)) return;
      // Browser timeouts cannot represent delays beyond signed 32-bit milliseconds.
      timer = window.setTimeout(() => {
        setNowMs(Date.now());
        schedule();
      }, Math.min(next - now, 2_147_483_647));
    };
    // Re-anchor after commit as well: a budget may have crossed since render.
    timer = window.setTimeout(() => {
      setNowMs(Date.now());
      schedule();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [boundaryKey, enabled, hydrated]);

  // Each consumer uses its own receipt clock for SSR/first hydration.
  return hydrated ? nowMs : undefined;
}
