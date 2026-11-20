import type { DepegEvent } from "../types/peg";
import { z } from "zod";
import { median } from "./stats";
import { isPegScoreExcludedAuditVerdict } from "./depeg-audit";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "./depeg-closure";
import { DEPEG_SEVERITY_BPS } from "./depeg-config";
import { getReferenceSessionState, isReferenceMarketClosed, replayReferenceMarketEventStart, type ReferenceMarket } from "./reference-market-hours";
import { getPegTaxonomyByType } from "./peg-taxonomy";

export const PegReferenceHoldSchema = z.strictObject({
  reason: z.literal("reference-market-closed"),
  declaredAtSec: z.number().int().positive(),
  refreshedAtSec: z.number().int().positive().optional(),
  lastTrustedAtSec: z.number().int().positive(),
  lastTrustedPeakBps: z.number().finite(),
});
export type PegScoreEvent = DepegEvent & {
  referenceHold?: z.output<typeof PegReferenceHoldSchema>;
};

/** Reviewed artifact repairs document zero eligible coverage. Other empty coverage is blind time. */
export function isScoredPegEvent(event: DepegEvent): boolean {
  return event.provenance?.pegScoreEligible !== false &&
    !isPegScoreExcludedAuditVerdict(event.provenance?.auditVerdict) &&
    !(event.disposition === "repaired" && event.admittedCoverage?.length === 0);
}

/**
 * Explicitly admitted coverage takes precedence over the legacy closure
 * projection. An uninstrumented open row has no defensible duration.
 */
export function depegObservedIntervals(event: PegScoreEvent, closures: Array<[number, number]> = []): Array<[number, number]> {
  if (event.admittedCoverage !== undefined) {
    return event.admittedCoverage.map(({ fromSec, toSec }) => [fromSec, toSec]);
  }
  if (event.priceCoverage != null) {
    // The legacy detector recorded trusted off-peg observations through a severe closure move.
    const peak = Math.abs(event.currentFragmentPeakBps ?? event.peakDeviationBps);
    return Number.isFinite(peak) && peak >= DEPEG_SEVERITY_BPS.severe
      ? event.priceCoverage.intervals
      : subtractIntervals(event.priceCoverage.intervals, closures);
  }
  if (event.endedAt == null) return [];
  const start = legacyPegEventStart(event);
  return start === null ? [] : subtractIntervals([[start, event.endedAt]], closures);
}

export function legacyPegOnsetPeakBps(event: DepegEvent): number | null {
  return event.onsetFragmentPeakBps !== undefined ? event.onsetFragmentPeakBps : event.currentFragmentPeakBps ?? event.peakDeviationBps;
}

export function legacyPegEventStart(event: DepegEvent): number | null {
  const peak = legacyPegOnsetPeakBps(event);
  if (peak === null) return null;
  return replayReferenceMarketEventStart(
    getPegTaxonomyByType(event.pegType)?.currency, event.startedAt, event.endedAt, peak,
  );
}

const closureCache = new Map<ReferenceMarket, { from: number; to: number; intervals: Array<[number, number]> }>();

export function scheduledPegClosures(market: ReferenceMarket | null, from: number, to: number): Array<[number, number]> {
  if (!market || to <= from) return [];
  const cached = closureCache.get(market);
  if (cached && cached.from <= from && cached.to === to) return cached.intervals;
  const intervals: Array<[number, number]> = [];
  let cursor = to;
  while (cursor > from) {
    const session = getReferenceSessionState(market, cursor - 1);
    if (!session.open) intervals.push([session.closureStartSec, session.nextOpenSec]);
    cursor = session.open ? session.sessionOpenedAtSec : session.closureStartSec;
  }
  intervals.reverse();
  closureCache.set(market, { from, to, intervals });
  return intervals;
}

/** A rollback writer cannot renew the detector's confirmation of a continuing coverage gap. */
export function isCurrentPegReferenceHold(hold: z.output<typeof PegReferenceHoldSchema>, now: number): boolean {
  const checkedAt = hold.refreshedAtSec ?? hold.declaredAtSec;
  return checkedAt >= hold.declaredAtSec && checkedAt <= now && now - checkedAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC;
}

export function activePegPeakBps(event: PegScoreEvent, now: number, market: ReferenceMarket | null): number | null {
  if (event.endedAt !== null) return null;
  const coverage = event.priceCoverage;
  const lastTrusted = coverage?.lastTrustedObservationAt;
  if (lastTrusted == null || !coverage || lastTrusted > now || coverage.lastObservationKind === "trusted-at-par") return null;
  const currentTrusted = hasCurrentTrustedDepegObservation(event, now);
  const fragmentPeak = event.currentFragmentPeakBps ?? event.peakDeviationBps;
  const admitted = event.admittedCoverage === undefined
    ? !isReferenceMarketClosed(market, lastTrusted) || (currentTrusted && coverage.lastObservationKind !== "blind" &&
      Number.isFinite(fragmentPeak) && Math.abs(fragmentPeak) >= DEPEG_SEVERITY_BPS.severe)
    : event.admittedCoverage.some(({ fromSec, toSec }) => fromSec <= lastTrusted && lastTrusted < toSec);
  if (!admitted) return null;
  if (currentTrusted) return event.peakDeviationBps;
  const hold = event.referenceHold;
  if (!hold || !isCurrentPegReferenceHold(hold, now) || coverage.gapStartedAt == null || hold.lastTrustedAtSec !== lastTrusted ||
      hold.lastTrustedPeakBps !== fragmentPeak ||
      hold.declaredAtSec < coverage.gapStartedAt || hold.declaredAtSec > now ||
      hold.declaredAtSec < lastTrusted || !isReferenceMarketClosed(market, hold.declaredAtSec)) return null;
  return event.peakDeviationBps;
}

function subtractIntervals(intervals: Array<[number, number]>, exclusions: Array<[number, number]>): Array<[number, number]> {
  if (exclusions.length === 0) return intervals;
  return intervals.flatMap(([start, end]) => {
    if (start === end) return exclusions.some(([from, to]) => from <= start && start < to) ? [] : [[start, end]];
    const result: Array<[number, number]> = [];
    let cursor = start;
    for (const [from, to] of exclusions) {
      if (to <= cursor) continue;
      if (from >= end) break;
      if (from > cursor) result.push([cursor, from]);
      cursor = to;
    }
    if (cursor < end) result.push([cursor, end]);
    return result;
  });
}

function knownDepegIntervals(event: DepegEvent, closures: Array<[number, number]>): Array<[number, number]> {
  return [
    ...depegObservedIntervals(event, closures),
    ...subtractIntervals(event.priceCoverage?.atParIntervals ?? [], closures),
  ];
}

export function hasCurrentTrustedDepegObservation(event: DepegEvent, now: number): boolean {
  const coverage = event.priceCoverage;
  return event.endedAt == null && coverage != null && coverage.gapStartedAt == null &&
    coverage.lastTrustedObservationAt != null &&
    now >= coverage.lastTrustedObservationAt &&
    now - coverage.lastTrustedObservationAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC;
}

/** Merge unknown complements too, so overlapping incidents do not double-count blind time. */
export function mergeUnknownDepegSeconds(events: DepegEvent[], windowStart: number, now: number, closures: Array<[number, number]> = []): number {
  const intervals: Array<[number, number]> = closures.map(([from, to]) => [Math.max(from, windowStart), Math.min(to, now)]);
  for (const event of events) {
    const end = Math.min(event.endedAt ?? now, now);
    let cursor = Math.max(event.startedAt, windowStart);
    const known = mergeDepegIntervals(knownDepegIntervals(event, closures));
    for (const [start, observedEnd] of known) {
      if (start > cursor) intervals.push([cursor, Math.min(start, end)]);
      cursor = Math.max(cursor, Math.min(observedEnd, end));
    }
    if (end > cursor) intervals.push([cursor, end]);
  }
  const unknown = mergeDepegIntervals(intervals);
  const trusted = mergeDepegIntervals(events.flatMap((event) => knownDepegIntervals(event, closures).map(
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
  closures: Array<[number, number]> = [],
): number {
  const intervals = events.flatMap((event) => depegObservedIntervals(event, closures).map(
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

export function medianOfRounded(values: readonly number[]): number | null {
  const result = median(values);
  return result == null ? null : Math.round(result);
}
