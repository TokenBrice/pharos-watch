"use client";

import { useMemo } from "react";
import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";
import {
  getYieldSourceDisplayHealthInput,
  type YieldSourceClockInput,
  type YieldSourceDisplayClock,
} from "@/lib/yield-source-presentation";

/**
 * Parent-owned source-age clock: one boundary render at the next public-gate
 * crossing of any listed source, never a poll or per-row timer. Callers pass a
 * memoized source list; a changed list or assessment re-anchors the schedule.
 */
export function useYieldSourceClock(
  sources: readonly YieldSourceClockInput[],
  assessedAt: number | null,
): YieldSourceDisplayClock {
  const inputs = useMemo(
    () => sources.map((source) => getYieldSourceDisplayHealthInput(source, { assessedAt })),
    [assessedAt, sources],
  );
  const nowMs = useFreshnessBoundary(inputs);
  return useMemo(() => ({ assessedAt, nowMs }), [assessedAt, nowMs]);
}
