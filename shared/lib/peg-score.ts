import type { DepegEvent } from "../types/peg";
import { activePegPeakBps, depegObservedIntervals, isScoredPegEvent, legacyPegEventStart, mergeDepegSeconds, mergeUnknownDepegSeconds, scheduledPegClosures, worstDeviation } from "./peg-utils";
import { getReferenceMarket, isReferenceDeviationHeld, isReferenceMarketClosed } from "./reference-market-hours";
import { getPegTaxonomyByType } from "./peg-taxonomy";
import { DAY_SECONDS } from "./time-constants";

export const PEG_SCORE_LOOKBACK_SEC = Math.ceil(4 * 365.25 * DAY_SECONDS);
/** Hero Peg Scores below this tracking span are marked early. */
export const PEG_SCORE_EARLY_MAX_DAYS = 30;
const RECENT_PEG_WINDOW_DAYS = 90;
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

export interface PegScoreResult {
  /** Composite score 0-100, or null if insufficient data (<7 days tracking) */
  pegScore: number | null;
  /** Time-at-peg percentage (0-100) */
  pegPct: number | null;
  /** Severity component (0-100) */
  severityScore: number;
  /** Deviation spread penalty (0-15) — confidence-weighted stddev of below-peg peak deviations */
  spreadPenalty: number;
  /** Total depeg events */
  eventCount: number;
  /** Events included after provenance/audit-quality filtering */
  scoredEventCount: number;
  /** Events excluded because audit provenance is false-positive, disputed, or unknown */
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
  /** End of the most recent admitted off-peg interval, for Safety's quiet-history rule. */
  lastAffectedAtSec?: number | null;
  /** Upper bound for scored incidents whose affected endpoint was unobserved. */
  lastUncertainAffectedAtSec?: number | null;
  /** Tracking span in days */
  trackingSpanDays: number;
  /** Unknown coverage is neither off peg nor verified at peg. */
  unknownCoverageSeconds?: number;
}

export interface RecentPegStats {
  windowDays: typeof RECENT_PEG_WINDOW_DAYS;
  observedDays: number;
  coverageLimited: boolean;
  pegPct: number | null;
  incidentCount: number;
  thresholdCrossingCount: number;
  worstDeviationBps: number | null;
}

export const NULL_PEG_SCORE_RESULT: PegScoreResult = {
  pegScore: null,
  pegPct: null,
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
  unknownCoverageSeconds: 0,
};


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
  pegCurrency?: string,
): RecentPegStats | null {
  if (trackingStartSec == null || trackingStartSec >= nowSec) return null;

  const nominalStartSec = nowSec - RECENT_PEG_WINDOW_DAYS * DAY_SECONDS;
  const observedStartSec = Math.max(trackingStartSec, nominalStartSec);
  const observedSpanSec = Math.max(nowSec - observedStartSec, 1);
  const { coverageEvents, eligibleEvents, closures } = getPegIncidentCoverage(events, observedStartSec, nowSec, pegCurrency, "recent");
  const coveredEvents = coverageEvents.filter(isScoredPegEvent);
  const recentEvents = eligibleEvents.filter(isScoredPegEvent);
  const depegSec = mergeDepegSeconds(recentEvents, observedStartSec, nowSec, closures);
  const unknownSec = mergeUnknownDepegSeconds(coveredEvents, observedStartSec, nowSec, closures);
  const knownSpanSec = Math.max(0, observedSpanSec - unknownSec);

  return {
    windowDays: RECENT_PEG_WINDOW_DAYS,
    observedDays: knownSpanSec / DAY_SECONDS,
    coverageLimited: observedStartSec > nominalStartSec || unknownSec > 0,
    pegPct: knownSpanSec > 0 ? Math.max(0, (1 - depegSec / knownSpanSec) * 100) : null,
    incidentCount: recentEvents.length,
    thresholdCrossingCount: recentEvents.reduce((sum, event) => sum + Math.max(1, event.constituentEventCount ?? 1), 0),
    worstDeviationBps: worstDeviation(recentEvents),
  };
}

function countsPegIncident(
  event: DepegEvent, from: number, now: number, currency: string | undefined, closures: Array<[number, number]>, scope: "history" | "recent",
): boolean {
  const market = getReferenceMarket(currency);
  const startBound = scope === "history" && event.endedAt === null ? event.startedAt : from;
  if (event.admittedCoverage === undefined) {
    // A recorded opening in an eligible session establishes the incident
    // independently of whether duration tracking later went blind.
    if (scope === "history" && market === null) return true;
    if (event.startedAt >= startBound && !isReferenceDeviationHeld(currency, event.startedAt, event.peakDeviationBps)) return true;
  }
  return depegObservedIntervals(event, closures).some(([start, end]) => {
    if (start === end) {
      return start >= startBound && start <= now && !isReferenceMarketClosed(market, start);
    }
    const elapsedOverlap = start < end && start < now && end > startBound;
    const admittedAtClock = event.admittedCoverage !== undefined && now >= startBound && start <= now && now < end;
    return elapsedOverlap || admittedAtClock;
  });
}

/** Shared census for scoring, exact provenance and active Safety cap witnesses. */
export function getPegIncidentCoverage<T extends DepegEvent>(
  events: T[], from: number, now: number, pegCurrency?: string, scope: "history" | "recent" = "history",
) {
  const currency = pegCurrency ?? getPegTaxonomyByType(events[0]?.pegType)?.currency;
  const market = getReferenceMarket(currency);
  const coverageEvents = events.filter((event) => event.startedAt <= now &&
    (from >= now || (event.endedAt ?? now) > from));
  const closureStart = scope === "recent" ? from : coverageEvents.reduce((start, event) =>
    event.endedAt === null ? Math.min(start, event.startedAt) : start, from);
  const closures = scheduledPegClosures(market, closureStart, now);
  const eligibleEvents = coverageEvents.filter((event) => countsPegIncident(event, from, now, currency, closures, scope));
  return { market, closures, coverageEvents, eligibleEvents };
}

function isPremiumDepegEvent(event: DepegEvent): boolean {
  // Premiums are classified by sign, never by `direction`: historical rows
  // disagree with their own sign (e.g. bean-beanstalk: "above", -10000 bps).
  // A non-finite peak is not provably a premium, so it keeps full weight.
  return Number.isFinite(event.peakDeviationBps) && event.peakDeviationBps > 0;
}

function roundPegScore(raw: number | null): number | null {
  return raw == null ? null : Math.max(0, Math.min(100, Math.round(raw)));
}

interface PegScoreCoreResult {
  result: PegScoreResult;
  premiumWeightedPegScore: number | null;
}

/**
 * Shared peg-score core. `premiumWeight` scales above-peg event time, severity
 * and active penalties; the public score calls it with 1, which must reproduce
 * the historical result exactly. `result` is meaningful only at weight 1: the
 * weighted call reads only `premiumWeightedPegScore`.
 */
function computePegScoreCore(
  events: DepegEvent[],
  trackingStartSec: number | null,
  now: number,
  premiumWeight: number,
  pegCurrency?: string,
): PegScoreCoreResult {
  // Determine tracking window start
  // Only compute earliestEvent when trackingStartSec is absent (all production callers supply it).
  const earliestEvent =
    trackingStartSec == null && events.length > 0 ? events.reduce((m, e) => Math.min(m, e.startedAt), Infinity) : null;
  const startSec = trackingStartSec ?? earliestEvent;

  // No events and no known tracking start -> assume stable, default score
  if (startSec === null) {
    return { result: { ...NULL_PEG_SCORE_RESULT }, premiumWeightedPegScore: null };
  }

  // A tracking anchor at or after the scoring clock proves no observed second:
  // do not clamp the non-positive span to a pseudocount of one second. The event
  // census still reports what was observed up to the clock.
  const spanSec = Math.max(now - startSec, 0);
  const spanDays = spanSec / DAY_SECONDS;
  const { coverageEvents, eligibleEvents, market, closures } = getPegIncidentCoverage(events, startSec, now, pegCurrency);
  const auditEvents = coverageEvents.filter(isScoredPegEvent);
  const scoringEvents = eligibleEvents.filter(isScoredPegEvent);
  const excludedEventCount = eligibleEvents.length - scoringEvents.length;
  const lowConfidenceEventCount = scoringEvents.filter((event) => eventSeverityWeight(event) < 1).length;
  const qualityAdjusted = excludedEventCount > 0 || lowConfidenceEventCount > 0;

  const unknownCoverageSeconds = mergeUnknownDepegSeconds(auditEvents, startSec, now, closures);
  const knownSpanSec = Math.max(0, spanSec - unknownCoverageSeconds);
  const insufficientData = knownSpanSec < 7 * DAY_SECONDS;
  // --- Time score (pegPct) ---
  // Discounts are below-peg peaks; premiums are above-peg peaks, by sign.
  // Below-peg time is merged first so overlaps are attributed to discounts.
  const belowPegEvents = scoringEvents.filter((e) => e.peakDeviationBps <= 0);
  const totalDepegSec = mergeDepegSeconds(scoringEvents, startSec, now, closures);
  // Anything not provably a premium (including a non-finite peak) keeps full weight.
  const belowPegSec = mergeDepegSeconds(scoringEvents.filter((e) => !isPremiumDepegEvent(e)), startSec, now, closures);
  const abovePegSec = totalDepegSec - belowPegSec;
  // A premium second counts `premiumWeight` seconds in the Safety peg input.
  // Weight 1 keeps the merged total itself rather than a `below + (total - below)`
  // round trip, so the public time-at-peg value stays byte-identical.
  const premiumOffPegSec = premiumWeight === 1 ? totalDepegSec : belowPegSec + premiumWeight * abovePegSec;
  const pegPct = knownSpanSec > 0 ? Math.max(0, (1 - totalDepegSec / knownSpanSec) * 100) : null;
  const premiumWeightedPegPct = knownSpanSec > 0
    ? Math.max(0, (1 - premiumOffPegSec / knownSpanSec) * 100)
    : null;

  // --- Severity score ---
  // Each event's penalty = max(durationPenalty, magnitudeFloor).
  // durationPenalty scales with peak × duration × recency (original formula).
  // magnitudeFloor ensures even very short events (minutes/hours) carry a
  // minimum penalty proportional to their magnitude — a 2-hour 400 bps depeg
  // is not negligible just because it was brief.
  let totalPenalty = 0;
  let lastAffectedAtSec: number | null = null;
  let lastUncertainAffectedAtSec: number | null = null;
  for (const e of scoringEvents) {
    const rawBps = Math.abs(e.peakDeviationBps);
    const peakBps = Number.isFinite(rawBps) ? rawBps : 0;
    const intervals = depegObservedIntervals(e, closures).filter(([start, end]) => start <= now && end >= startSec);
    const onset = market !== null || e.admittedCoverage !== undefined ? intervals[0]?.[0] ?? legacyPegEventStart(e) : e.startedAt;
    const observedStartSec = Math.max(onset ?? e.startedAt, startSec);
    for (const [, end] of intervals) lastAffectedAtSec = Math.max(lastAffectedAtSec ?? 0, Math.min(end, now));
    if (intervals.length === 0 && e.endedAt !== null) {
      lastUncertainAffectedAtSec = Math.max(lastUncertainAffectedAtSec ?? 0, e.endedAt);
    }
    const durationDays = Math.min(mergeDepegSeconds([e], startSec, now, closures) / DAY_SECONDS, 90);
    const yearsAgo = (now - observedStartSec) / (365.25 * DAY_SECONDS);
    const recencyWeight = 1 / (1 + yearsAgo);

    const durationPenalty = (peakBps / 100) * (durationDays / 30) * recencyWeight;
    const magnitudeFloor = (peakBps / MAGNITUDE_FLOOR_DIVISOR) * recencyWeight;
    // A premium event's severity penalty counts at `premiumWeight` of its magnitude.
    const premiumFactor = isPremiumDepegEvent(e) ? premiumWeight : 1;
    totalPenalty += Math.max(durationPenalty, magnitudeFloor) * eventSeverityWeight(e) * premiumFactor;
  }
  const severityScore = Math.max(0, 100 - totalPenalty);

  // --- Spread penalty (deviation variance proxy) ---
  // Only below-peg magnitudes enter the spread: premiums are not downside depegs.
  // Confidence weights are observation weights, not scaled magnitudes: the
  // weighted mean and variance both divide by the weight sum, so a half-weight
  // row keeps its observed peak instead of shrinking into artificial dispersion.
  // stddev of |peakDeviationBps| scaled into 0-15 range. `belowPegEvents` is
  // the discount subset from the time score: premiums never enter the spread.
  let spreadPenalty = 0;
  if (belowPegEvents.length >= 2) {
    const observations = belowPegEvents.map((e) => {
      const rawMag = Math.abs(e.peakDeviationBps);
      return {
        weight: eventSeverityWeight(e),
        magnitude: Number.isFinite(rawMag) ? rawMag : 0,
      };
    });
    const weightSum = observations.reduce((s, o) => s + o.weight, 0);
    const mean = observations.reduce((s, o) => s + o.weight * o.magnitude, 0) / weightSum;
    const variance = observations.reduce((s, o) => s + o.weight * (o.magnitude - mean) ** 2, 0) / weightSum;
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
    const trustedPeak = activePegPeakBps(e, now, market);
    if (trustedPeak !== null) {
      // Scale: floor 5 below 250 bps, 2500+ bps = 50 penalty (hard cap).
      // Use worst active event when multiple concurrent depegs exist.
      const rawAbsBps = Math.abs(trustedPeak);
      const absBps = Number.isFinite(rawAbsBps) ? rawAbsBps : 0;
      // A premium's whole active penalty counts at `premiumWeight`: floor `5w`, cap `50w`.
      const premiumFactor = trustedPeak > 0 ? premiumWeight : 1;
      activeDepegPenalty = Math.max(
        activeDepegPenalty,
        Math.min(ACTIVE_DEPEG_CAP, Math.max(ACTIVE_DEPEG_FLOOR, absBps / ACTIVE_DEPEG_BPS_PER_POINT)) * premiumFactor,
      );
    }
  }

  // --- Composite ---
  const composite = (timeAtPeg: number | null): number | null =>
    timeAtPeg == null
      ? null
      : PEG_COMPOSITE_WEIGHT * timeAtPeg + PEG_COMPOSITE_WEIGHT * severityScore - activeDepegPenalty - spreadPenalty;
  const pegScore = insufficientData ? null : roundPegScore(composite(pegPct));
  const premiumWeightedPegScore = insufficientData ? null : roundPegScore(composite(premiumWeightedPegPct));

  // --- Worst deviation ---
  const worstDeviationBps = worstDeviation(scoringEvents);

  return {
    result: {
      pegScore,
      pegPct,
      severityScore,
      spreadPenalty,
      eventCount: eligibleEvents.length,
      scoredEventCount: scoringEvents.length,
      excludedEventCount,
      lowConfidenceEventCount,
      qualityAdjusted,
      worstDeviationBps,
      activeDepeg: scoringEvents.some((e) => e.endedAt === null),
      lastEventAt: scoringEvents.length > 0 ? scoringEvents.reduce((m, e) => Math.max(m, e.startedAt), -Infinity) : null,
      lastAffectedAtSec,
      ...(lastUncertainAffectedAtSec === null ? {} : { lastUncertainAffectedAtSec }),
      trackingSpanDays: Math.floor(spanDays),
      unknownCoverageSeconds,
    },
    premiumWeightedPegScore,
  };
}

/**
 * Compute the Safety peg input with premium (above-peg) events counted at
 * `premiumWeight`: off-peg time, per-event severity and the active penalty all
 * scale, while the spread penalty stays discount-only. Returns null exactly
 * when the public peg score is null. `premiumWeight` must be finite and in
 * [0, 1].
 */
export function computePremiumWeightedPegScore(
  events: DepegEvent[],
  trackingStartSec: number | null,
  nowSec: number,
  premiumWeight: number,
  pegCurrency?: string,
): number | null {
  if (!Number.isFinite(premiumWeight) || premiumWeight < 0 || premiumWeight > 1) {
    throw new RangeError(`premiumWeight must be finite and within [0, 1]; received ${premiumWeight}`);
  }
  return computePegScoreCore(events, trackingStartSec, nowSec, premiumWeight, pegCurrency).premiumWeightedPegScore;
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
  pegCurrency?: string,
): PegScoreResult {
  return computePegScoreCore(events, trackingStartSec, nowSec ?? Math.floor(Date.now() / 1000), 1, pegCurrency).result;
}
