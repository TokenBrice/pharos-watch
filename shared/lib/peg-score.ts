import type { DepegEvent } from "../types";
import { mergeDepegSeconds, worstDeviation } from "./peg-utils";
import { DAY_SECONDS } from "./time-constants";

export const PEG_SCORE_LOOKBACK_SEC = Math.ceil(4 * 365.25 * DAY_SECONDS);
export const RECENT_PEG_WINDOW_DAYS = 90;
const LOW_CONFIDENCE_WEIGHT = 0.5;
const MAGNITUDE_FLOOR_DIVISOR = 2000;
const ACTIVE_DEPEG_FLOOR = 5;
const ACTIVE_DEPEG_CAP = 50;
const ACTIVE_DEPEG_BPS_PER_POINT = 50;
const SPREAD_PENALTY_MAX = 15;
const SPREAD_STDDEV_SCALE = 1000;
const PEG_COMPOSITE_WEIGHT = 0.5;

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
  /** Deviation spread penalty (0-15) — stddev of severity-weighted peak deviations across events */
  spreadPenalty: number;
  /** Total depeg events */
  eventCount: number;
  /** Events included after provenance/audit-quality filtering */
  scoredEventCount: number;
  /** Events excluded because audit provenance marked them false-positive/disputed */
  excludedEventCount: number;
  /** Included low-confidence events that receive reduced severity weight */
  lowConfidenceEventCount: number;
  /** True when provenance/audit quality changed the score inputs */
  qualityAdjusted: boolean;
  /** Worst peak deviation in bps (signed), or null */
  worstDeviationBps: number | null;
  /** Whether there is an ongoing depeg event */
  activeDepeg: boolean;
  /** Most recent event startedAt, or null */
  lastEventAt: number | null;
  /** Tracking span in days */
  trackingSpanDays: number;
}

export interface RecentPegStats {
  windowDays: typeof RECENT_PEG_WINDOW_DAYS;
  observedDays: number;
  coverageLimited: boolean;
  pegPct: number;
  incidentCount: number;
  thresholdCrossingCount: number;
  worstDeviationBps: number | null;
}

export const NULL_PEG_SCORE_RESULT: PegScoreResult = {
  pegScore: null,
  pegPct: 100,
  severityScore: 100,
  spreadPenalty: 0,
  eventCount: 0,
  scoredEventCount: 0,
  excludedEventCount: 0,
  lowConfidenceEventCount: 0,
  qualityAdjusted: false,
  worstDeviationBps: null,
  activeDepeg: false,
  lastEventAt: null,
  trackingSpanDays: 0,
};

function isExcludedByAudit(event: DepegEvent): boolean {
  const verdict = event.provenance?.auditVerdict;
  return verdict === "false_positive" || verdict === "disputed";
}

function eventSeverityWeight(event: DepegEvent): number {
  const confidenceTier = event.provenance?.confidenceTier;
  if (confidenceTier === "low") return LOW_CONFIDENCE_WEIGHT;
  return 1;
}

/**
 * Summarize recent realized peg behavior without treating time before the
 * verified/assumed tracking anchor as observed stability.
 */
export function computeRecentPegStats(
  events: DepegEvent[],
  trackingStartSec: number | null,
  nowSec: number,
): RecentPegStats | null {
  if (trackingStartSec == null || trackingStartSec >= nowSec) return null;

  const nominalStartSec = nowSec - RECENT_PEG_WINDOW_DAYS * DAY_SECONDS;
  const observedStartSec = Math.max(trackingStartSec, nominalStartSec);
  const observedSpanSec = Math.max(nowSec - observedStartSec, 1);
  const recentEvents = events.filter((event) => {
    if (isExcludedByAudit(event)) return false;
    const eventEndSec = event.endedAt ?? nowSec;
    return event.startedAt <= nowSec && eventEndSec >= observedStartSec;
  });
  const depegSec = mergeDepegSeconds(recentEvents, observedStartSec, nowSec);

  return {
    windowDays: RECENT_PEG_WINDOW_DAYS,
    observedDays: observedSpanSec / DAY_SECONDS,
    coverageLimited: observedStartSec > nominalStartSec,
    pegPct: Math.max(0, (1 - depegSec / observedSpanSec) * 100),
    incidentCount: recentEvents.length,
    thresholdCrossingCount: recentEvents.reduce(
      (sum, event) => sum + Math.max(1, event.constituentEventCount ?? 1),
      0,
    ),
    worstDeviationBps: worstDeviation(recentEvents),
  };
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
  // Only compute earliestEvent when trackingStartSec is absent (all production callers supply it).
  const earliestEvent = trackingStartSec == null && events.length > 0
    ? events.reduce((m, e) => Math.min(m, e.startedAt), Infinity)
    : null;
  const startSec = trackingStartSec ?? earliestEvent;

  // No events and no known tracking start -> assume stable, default score
  if (startSec === null) {
    return { ...NULL_PEG_SCORE_RESULT };
  }

  const spanSec = Math.max(now - startSec, 1);
  const spanDays = spanSec / DAY_SECONDS;
  const insufficientData = spanDays < 7;
  const scoringEvents = events.filter((event) => !isExcludedByAudit(event));
  const excludedEventCount = events.length - scoringEvents.length;
  const lowConfidenceEventCount = scoringEvents.filter((event) => eventSeverityWeight(event) < 1).length;
  const qualityAdjusted = excludedEventCount > 0 || lowConfidenceEventCount > 0;

  // --- Time score (pegPct) ---
  const totalDepegSec = mergeDepegSeconds(scoringEvents, startSec, now);
  const pegPct = Math.max(0, (1 - totalDepegSec / spanSec) * 100);

  // --- Severity score ---
  // Each event's penalty = max(durationPenalty, magnitudeFloor).
  // durationPenalty scales with peak × duration × recency (original formula).
  // magnitudeFloor ensures even very short events (minutes/hours) carry a
  // minimum penalty proportional to their magnitude — a 2-hour 400 bps depeg
  // is not negligible just because it was brief.
  let totalPenalty = 0;
  for (const e of scoringEvents) {
    const rawBps = Math.abs(e.peakDeviationBps);
    const peakBps = Number.isFinite(rawBps) ? rawBps : 0;
    const endSec = e.endedAt ?? now;
    const durationDays = Math.min((endSec - e.startedAt) / DAY_SECONDS, 90);
    const yearsAgo = (now - e.startedAt) / (365.25 * DAY_SECONDS);
    const recencyWeight = 1 / (1 + yearsAgo);

    const durationPenalty = (peakBps / 100) * (durationDays / 30) * recencyWeight;
    const magnitudeFloor = (peakBps / MAGNITUDE_FLOOR_DIVISOR) * recencyWeight;
    totalPenalty += Math.max(durationPenalty, magnitudeFloor) * eventSeverityWeight(e);
  }
  const severityScore = Math.max(0, 100 - totalPenalty);

  // --- Spread penalty (deviation variance proxy) ---
  // Coins with erratic, unpredictable depeg magnitudes get penalized.
  // stddev of |peakDeviationBps| scaled into 0-15 range.
  let spreadPenalty = 0;
  if (scoringEvents.length >= 2) {
    const absBpsList = scoringEvents.map((e) => {
      const v = Math.abs(e.peakDeviationBps) * eventSeverityWeight(e);
      return Number.isFinite(v) ? v : 0;
    });
    const mean = absBpsList.reduce((s, v) => s + v, 0) / absBpsList.length;
    const variance = absBpsList.reduce((s, v) => s + (v - mean) ** 2, 0) / absBpsList.length;
    const stdDev = Math.sqrt(variance);
    spreadPenalty = Number.isFinite(stdDev)
      ? Math.min(SPREAD_PENALTY_MAX, (stdDev / SPREAD_STDDEV_SCALE) * SPREAD_PENALTY_MAX)
      : 0;
  }

  // --- Active depeg penalty ---
  // If there's an ongoing depeg, penalize based on its current peak severity.
  // A coin at -7800 bps shouldn't score 51 just because old events decayed.
  let activeDepegPenalty = 0;
  for (const e of scoringEvents) {
    if (e.endedAt === null) {
      // Scale: floor 5 below 250 bps, 2500+ bps = 50 penalty (hard cap).
      // Use worst active event when multiple concurrent depegs exist.
      const rawAbsBps = Math.abs(e.peakDeviationBps);
      const absBps = Number.isFinite(rawAbsBps) ? rawAbsBps : 0;
      activeDepegPenalty = Math.max(
        activeDepegPenalty,
        Math.min(ACTIVE_DEPEG_CAP, Math.max(ACTIVE_DEPEG_FLOOR, absBps / ACTIVE_DEPEG_BPS_PER_POINT)),
      );
    }
  }

  // --- Composite ---
  const raw =
    PEG_COMPOSITE_WEIGHT * pegPct +
    PEG_COMPOSITE_WEIGHT * severityScore -
    activeDepegPenalty -
    spreadPenalty;
  const pegScore = insufficientData ? null : Math.max(0, Math.min(100, Math.round(raw)));

  // --- Worst deviation ---
  const worstDeviationBps = worstDeviation(scoringEvents);

  return {
    pegScore,
    pegPct,
    severityScore,
    spreadPenalty,
    eventCount: events.length,
    scoredEventCount: scoringEvents.length,
    excludedEventCount,
    lowConfidenceEventCount,
    qualityAdjusted,
    worstDeviationBps,
    activeDepeg: scoringEvents.some((e) => e.endedAt === null),
    lastEventAt: scoringEvents.length > 0
      ? scoringEvents.reduce((m, e) => Math.max(m, e.startedAt), -Infinity)
      : null,
    trackingSpanDays: Math.floor(spanDays),
  };
}
