"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type Phase = "briefing" | "kpi" | "complete";

interface EntranceSequence {
  phase: Phase;
  delayFor: (group: string, index: number) => number;
}

const PHASE_TIMINGS: Record<Phase, number> = {
  briefing: 0,
  kpi: 400,
  complete: 800,
};

const GROUP_OFFSETS: Record<string, { base: number; stagger: number }> = {
  briefing: { base: 0, stagger: 60 },
  "briefing-lines": { base: 150, stagger: 60 },
  kpi: { base: 400, stagger: 80 },
  cards: { base: 400, stagger: 60 },
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useEntranceSequence(): EntranceSequence {
  const reduced = useRef(prefersReducedMotion());
  const [phase, setPhase] = useState<Phase>(
    reduced.current ? "complete" : "briefing",
  );

  useEffect(() => {
    if (reduced.current) return;

    const timers = [
      setTimeout(() => setPhase("kpi"), PHASE_TIMINGS.kpi),
      setTimeout(() => setPhase("complete"), PHASE_TIMINGS.complete),
    ];

    return () => timers.forEach(clearTimeout);
  }, []);

  const delayFor = useCallback(
    (group: string, index: number): number => {
      if (reduced.current) return 0;
      const config = GROUP_OFFSETS[group];
      if (!config) return 0;
      const cappedIndex = Math.min(index, 8);
      return config.base + cappedIndex * config.stagger;
    },
    [],
  );

  return { phase, delayFor };
}
