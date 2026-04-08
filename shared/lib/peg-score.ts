import type { DepegEvent } from "../types";
import { mergeDepegSeconds, worstDeviation } from "./peg-utils";
import { DAY_SECONDS } from "./time-constants";

export const PEG_SCORE_LOOKBACK_SEC = Math.ceil(4 * 365.25 * DAY_SECONDS);

/**
 * Compute the tracking window start for a coin, respecting both the 4-year
 * lookback cap and the coin's actual first-seen date.
 *
 * Without `firstSeenSec`, young coins get their depeg time diluted across a
 * full 4-year window they didn't exist for.
 *
 * Returns null when neither supply history nor events are available — the
 * caller should treat this as "insufficient data" (no peg score).
 */
export function coinTrackingStart(
  events: DepegEvent[],
  fourYearsAgoSec: number,
  firstSeenSec?: number | null,
): number | null {
  // If we know when the coin first appeared, don't go further back than that
  // (but also don't go further back than the 4-year lookback cap).
  if (firstSeenSec != null) {
    return Math.max(firstSeenSec, fourYearsAgoSec);
  }
  // Fallback: use earliest event if available
  if (events.length > 0) {
    const earliest = events.reduce((m, e) => Math.min(m, e.startedAt), Infinity);
    return Math.max(earliest, fourYearsAgoSec);
  }
  // No supply history and no events → insufficient data, not a perfect score
  return null;
}

/**
 * Wrapper around computePegScore that applies a 4-year lookback window.
 * Used by the detail page to score a single coin from its depeg events.
 */
export function computePegScoreWithWindow(
  isNavToken: boolean,
  events: DepegEvent[] | null,
  earliestTrackingDate: number | null,
): PegScoreResult | null {
  if (isNavToken || !events) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const fourYearsAgo = nowSec - PEG_SCORE_LOOKBACK_SEC;
  const firstSeenSec = earliestTrackingDate != null ? Math.floor(earliestTrackingDate) : null;
  return computePegScore(events, coinTrackingStart(events, fourYearsAgo, firstSeenSec), nowSec);
}

export interface PegScoreResult {
  /** Composite score 0-100, or null if insufficient data (<7 days tracking) */
  pegScore: number | null;
  /** Time-at-peg percentage (0-100) */
  pegPct: number;
  /** Severity component (0-100) */
  severityScore: number;
  /** Deviation spread penalty (0-15) — stddev of peak deviations across events */
  spreadPenalty: number;
  /** Total depeg events */
  eventCount: number;
  /** Worst peak deviation in bps (signed), or null */
  worstDeviationBps: number | null;
  /** Whether there is an ongoing depeg event */
  activeDepeg: boolean;
  /** Most recent event startedAt, or null */
  lastEventAt: number | null;
  /** Tracking span in days */
  trackingSpanDays: number;
}

/**
 * Compute peg score from depeg events.
 *
 * @param events     All depeg events for this coin (from DB)
 * @param trackingStartSec  Earliest known data timestamp (unix seconds).
 *                          If unknown, pass null and we'll use the earliest event.
 * @param nowSec     Current time in unix seconds (defaults to Date.now()/1000)
 */
export function computePegScore(
  events: DepegEvent[],
  trackingStartSec: number | null,
  nowSec?: number,
): PegScoreResult {
  const now = nowSec ?? Math.floor(Date.now() / 1000);

  // Determine tracking window start
  const earliestEvent = events.length > 0
    ? events.reduce((m, e) => Math.min(m, e.startedAt), Infinity)
    : null;
  const startSec = trackingStartSec ?? earliestEvent;

  // No events and no known tracking start -> assume stable, default score
  if (startSec === null) {
    return {
      pegScore: null,
      pegPct: 100,
      severityScore: 100,
      spreadPenalty: 0,
      eventCount: 0,
      worstDeviationBps: null,
      activeDepeg: false,
      lastEventAt: null,
      trackingSpanDays: 0,
    };
  }

  const spanSec = Math.max(now - startSec, 1);
  const spanDays = spanSec / DAY_SECONDS;
  const insufficientData = spanDays < 7;

  // --- Time score (pegPct) ---
  const totalDepegSec = mergeDepegSeconds(events, startSec, now);
  const pegPct = Math.max(0, (1 - totalDepegSec / spanSec) * 100);

  // --- Severity score ---
  // Each event's penalty = max(durationPenalty, magnitudeFloor).
  // durationPenalty scales with peak × duration × recency (original formula).
  // magnitudeFloor ensures even very short events (minutes/hours) carry a
  // minimum penalty proportional to their magnitude — a 2-hour 400 bps depeg
  // is not negligible just because it was brief.
  let totalPenalty = 0;
  for (const e of events) {
    const rawBps = Math.abs(e.peakDeviationBps);
    const peakBps = Number.isFinite(rawBps) ? rawBps : 0;
    const endSec = e.endedAt ?? now;
    const durationDays = Math.min((endSec - e.startedAt) / DAY_SECONDS, 90);
    const yearsAgo = (now - e.startedAt) / (365.25 * DAY_SECONDS);
    const recencyWeight = 1 / (1 + yearsAgo);

    const durationPenalty = (peakBps / 100) * (durationDays / 30) * recencyWeight;
    const magnitudeFloor = (peakBps / 2000) * recencyWeight;
    totalPenalty += Math.max(durationPenalty, magnitudeFloor);
  }
  const severityScore = Math.max(0, 100 - totalPenalty);

  // --- Spread penalty (deviation variance proxy) ---
  // Coins with erratic, unpredictable depeg magnitudes get penalized.
  // stddev of |peakDeviationBps| scaled into 0-15 range.
  let spreadPenalty = 0;
  if (events.length >= 2) {
    const absBpsList = events.map((e) => { const v = Math.abs(e.peakDeviationBps); return Number.isFinite(v) ? v : 0; });
    const mean = absBpsList.reduce((s, v) => s + v, 0) / absBpsList.length;
    const variance = absBpsList.reduce((s, v) => s + (v - mean) ** 2, 0) / absBpsList.length;
    const stdDev = Math.sqrt(variance);
    spreadPenalty = Number.isFinite(stdDev) ? Math.min(15, (stdDev / 1000) * 15) : 0;
  }

  // --- Active depeg penalty ---
  // If there's an ongoing depeg, penalize based on its current peak severity.
  // A coin at -7800 bps shouldn't score 51 just because old events decayed.
  let activeDepegPenalty = 0;
  for (const e of events) {
    if (e.endedAt === null) {
      // Scale: 100 bps (threshold) = 5 penalty (floor), 2500+ bps = 50 penalty (hard cap)
      // Use worst active event when multiple concurrent depegs exist.
      const rawAbsBps = Math.abs(e.peakDeviationBps);
      const absBps = Number.isFinite(rawAbsBps) ? rawAbsBps : 0;
      activeDepegPenalty = Math.max(activeDepegPenalty, Math.min(50, Math.max(5, absBps / 50)));
    }
  }

  // --- Composite ---
  const raw = 0.5 * pegPct + 0.5 * severityScore - activeDepegPenalty - spreadPenalty;
  const pegScore = insufficientData ? null : Math.max(0, Math.min(100, Math.round(raw)));

  // --- Worst deviation ---
  const worstDeviationBps = worstDeviation(events);

  return {
    pegScore,
    pegPct,
    severityScore,
    spreadPenalty,
    eventCount: events.length,
    worstDeviationBps,
    activeDepeg: events.some((e) => e.endedAt === null),
    lastEventAt: events.length > 0
      ? events.reduce((m, e) => Math.max(m, e.startedAt), -Infinity)
      : null,
    trackingSpanDays: Math.floor(spanDays),
  };
}
