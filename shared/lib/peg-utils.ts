import type { DepegEvent } from "../types";
import { median } from "./stats";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "./depeg-closure";

/**
 * Closed legacy/replay rows retain their recorded duration. An uninstrumented
 * open row has no defensible duration: its whole span is unknown.
 */
function depegObservedIntervals(event: DepegEvent): Array<[number, number]> {
  if (event.priceCoverage != null) return event.priceCoverage.intervals;
  return event.endedAt == null ? [] : [[event.startedAt, event.endedAt]];
}

export function hasCurrentTrustedDepegObservation(event: DepegEvent, now: number): boolean {
  const coverage = event.priceCoverage;
  return event.endedAt == null && coverage != null && coverage.gapStartedAt == null &&
    coverage.lastTrustedObservationAt != null &&
    now >= coverage.lastTrustedObservationAt &&
    now - coverage.lastTrustedObservationAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC;
}

/** Merge unknown complements too, so overlapping incidents do not double-count blind time. */
export function mergeUnknownDepegSeconds(events: DepegEvent[], windowStart: number, now: number): number {
  const intervals: Array<[number, number]> = [];
  for (const event of events) {
    const end = Math.min(event.endedAt ?? now, now);
    let cursor = Math.max(event.startedAt, windowStart);
    const known = mergeDepegIntervals([...depegObservedIntervals(event), ...(event.priceCoverage?.atParIntervals ?? [])]);
    for (const [start, observedEnd] of known) {
      if (start > cursor) intervals.push([cursor, Math.min(start, end)]);
      cursor = Math.max(cursor, Math.min(observedEnd, end));
    }
    if (end > cursor) intervals.push([cursor, end]);
  }
  const unknown = mergeDepegIntervals(intervals);
  const trusted = mergeDepegIntervals(events.flatMap((event) => [
    ...depegObservedIntervals(event), ...(event.priceCoverage?.atParIntervals ?? []),
  ].map(
    ([start, end]) => [Math.max(start, windowStart), Math.min(end, now)] as [number, number],
  )));
  let coveredUnknown = 0;
  let i = 0;
  let j = 0;
  while (i < unknown.length && j < trusted.length) {
    coveredUnknown += Math.max(0, Math.min(unknown[i][1], trusted[j][1]) - Math.max(unknown[i][0], trusted[j][0]));
    if (unknown[i][1] <= trusted[j][1]) i++;
    else j++;
  }
  return unknown.reduce((sum, [start, end]) => sum + end - start, 0) - coveredUnknown;
}

/**
 * Merge overlapping depeg intervals and return total depeg seconds.
 * Clamps intervals to [windowStart, now] and filters out zero-length intervals.
 */
export function mergeDepegSeconds(
  events: DepegEvent[],
  windowStart: number,
  now: number,
): number {
  const intervals = events.flatMap((event) => depegObservedIntervals(event).map(
    ([start, end]) => [Math.max(start, windowStart), Math.min(end, now)] as [number, number],
  ));
  return mergeIntervalsSeconds(intervals);
}

export function mergeDepegIntervals(input: Array<[number, number]>): Array<[number, number]> {
  const intervals = input.filter(([start, end]) => end >= start).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function mergeIntervalsSeconds(input: Array<[number, number]>): number {
  return mergeDepegIntervals(input).reduce((sum, [start, end]) => sum + end - start, 0);
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

export function medianOfRounded(values: readonly number[]): number {
  const result = median(values);
  return result == null ? 0 : Math.round(result);
}
