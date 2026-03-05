import type { DepegEvent } from "../types";

/**
 * Merge overlapping depeg intervals and return total depeg seconds.
 * Clamps intervals to [windowStart, now] and filters out zero-length intervals.
 */
export function mergeDepegSeconds(
  events: DepegEvent[],
  windowStart: number,
  now: number,
): number {
  const intervals = events
    .map((e) => [Math.max(e.startedAt, windowStart), e.endedAt ?? now] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let i = 0;
  while (i < intervals.length) {
    const mergedStart = intervals[i][0]; let mergedEnd = intervals[i][1];
    while (i + 1 < intervals.length && intervals[i + 1][0] <= mergedEnd) {
      i++;
      mergedEnd = Math.max(mergedEnd, intervals[i][1]);
    }
    total += mergedEnd - mergedStart;
    i++;
  }
  return total;
}

/**
 * Find the worst (largest absolute value) peak deviation among events.
 * Returns the signed bps value, or null if no events.
 */
export function worstDeviation(events: DepegEvent[]): number | null {
  let worst: number | null = null;
  for (const e of events) {
    if (worst === null || Math.abs(e.peakDeviationBps) > Math.abs(worst)) {
      worst = e.peakDeviationBps;
    }
  }
  return worst;
}
