"use client";

import { useEffect, useState, useCallback } from "react";

type Phase = "kpi" | "complete";

interface EntranceSequence {
  phase: Phase;
  delayFor: (group: string, index: number) => number;
}

const PHASE_TIMINGS: Record<Phase, number> = {
  kpi: 0,
  complete: 400,
};

const GROUP_OFFSETS: Record<string, { base: number; stagger: number }> = {
  kpi: { base: 0, stagger: 80 },
  cards: { base: 200, stagger: 60 },
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useEntranceSequence(): EntranceSequence {
  const [isReduced] = useState(() => prefersReducedMotion());
  const [phase, setPhase] = useState<Phase>(
    () => prefersReducedMotion() ? "complete" : "kpi",
  );

  useEffect(() => {
    if (isReduced) return;

    const timers = [
      setTimeout(() => setPhase("kpi"), PHASE_TIMINGS.kpi),
      setTimeout(() => setPhase("complete"), PHASE_TIMINGS.complete),
    ];

    return () => timers.forEach(clearTimeout);
  }, [isReduced]);

  const delayFor = useCallback(
    (group: string, index: number): number => {
      if (isReduced) return 0;
      const config = GROUP_OFFSETS[group];
      if (!config) return 0;
      const cappedIndex = Math.min(index, 8);
      return config.base + cappedIndex * config.stagger;
    },
    [isReduced],
  );

  return { phase, delayFor };
}
