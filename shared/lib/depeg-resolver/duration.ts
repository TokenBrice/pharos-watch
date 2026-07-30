/**
 * Stage 2 — Expected Duration (conditional on recovery).
 *
 * Empirical landmark estimate over recovered, grouped, non-quarantined incidents,
 * stratified by direction × depth × structural class × peg currency with
 * most-dependable-first fallback. For an active event of age t we look at
 * comparable incidents that reached age t and ask: by each horizon, what share
 * had resolved, and what is the typical total duration. Honest about support.
 */

import type { DdrDuration, DdrHorizon, DdrHorizonCell } from "../../types/depeg-resolver";
import { DDR_HORIZON_VALUES } from "../../types/depeg-resolver";
import { groupDurationLabelIncidents, type DdrIncident } from "./incident-groups";
import { candidateStrata, depthBucket, stratumLabel, stratumMatches, type DdrStratumCandidate, type DdrStratumKey } from "./strata";

export const HORIZON_SECONDS: Record<DdrHorizon, number> = {
  "6h": 6 * 3600,
  "24h": 24 * 3600,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
};

const Z90 = 1.64;
const MIN_TRAINING_DURATION_SEC = 30 * 60;
const MIN_TRAINING_PEAK_BPS = 250;
const STRATUM_MIN_COMPARABLE_INCIDENTS = 10;
const STRATUM_MIN_UNIQUE_COINS = 5;
const BENCHMARKED_MIN_COMPARABLE_INCIDENTS = 30;
const BENCHMARKED_MIN_UNIQUE_COINS = 10;
const BENCHMARKED_MIN_EFFECTIVE_N = 10;
const BENCHMARKED_MIN_WEIGHTED_CLOSURES = 5;
const BENCHMARKED_MIN_WEIGHTED_NON_CLOSURES = 5;
const THIN_SUPPORT_MIN_EFFECTIVE_N = 5;
const THIN_SUPPORT_MIN_WEIGHTED_CLOSURES = 1;

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, (sortedAsc.length - 1) * p));
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedAsc[lower];
  return sortedAsc[lower] + (sortedAsc[upper] - sortedAsc[lower]) * (idx - lower);
}

function wilson(k: number, n: number): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 1 };
  const p = k / n;
  const z2 = Z90 * Z90;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z90 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

function displayInterval(lower: number, upper: number): string {
  const lo = Math.max(1, Math.floor((lower * 100) / 5) * 5);
  const hi = Math.min(99, Math.ceil((upper * 100) / 5) * 5);
  return `${lo}-${hi}%`;
}

interface WeightedClosureStats {
  probability: number;
  effectiveN: number;
  weightedClosures: number;
  weightedNonClosures: number;
}

function incidentDepthAtAge(incident: DdrIncident, ageSec: number): DdrIncident["depth"] {
  const fragments = incident.fragments?.filter((f) => f.offsetSec <= ageSec) ?? [];
  if (fragments.length === 0) return incident.depth;
  let worst = fragments[0].peakDeviationBps;
  for (const fragment of fragments.slice(1)) {
    if (Math.abs(fragment.peakDeviationBps) > Math.abs(worst)) {
      worst = fragment.peakDeviationBps;
    }
  }
  return depthBucket(worst);
}

function incidentMatchesAtAge(candidate: DdrStratumCandidate, incident: DdrIncident, ageSec: number): boolean {
  return stratumMatches(candidate, {
    direction: incident.direction,
    depth: incidentDepthAtAge(incident, ageSec),
    structural: incident.structural,
    currency: incident.currency,
  });
}

function isTrainableIncident(incident: DdrIncident): boolean {
  if (!incident.recovered || incident.durationSec == null) return false;
  return incident.durationSec >= MIN_TRAINING_DURATION_SEC || Math.abs(incident.peakDeviationBps) >= MIN_TRAINING_PEAK_BPS;
}

function coinMedianRemainingDurations(comparable: DdrIncident[], ageSec: number): number[] {
  const byCoin = new Map<string, number[]>();
  for (const incident of comparable) {
    const durations = byCoin.get(incident.stablecoinId) ?? [];
    durations.push((incident.durationSec as number) - ageSec);
    byCoin.set(incident.stablecoinId, durations);
  }
  return [...byCoin.values()]
    .map((durations) => percentile(durations.sort((a, b) => a - b), 0.5))
    .sort((a, b) => a - b);
}

export function buildDurationTrainingCorpus(
  incidents: DdrIncident[],
  quarantined: Set<string>,
): DdrIncident[] {
  return groupDurationLabelIncidents(incidents).filter(
    (incident) => isTrainableIncident(incident) && !quarantined.has(incident.stablecoinId),
  );
}

/** Coin-capped weighted closure probability (each coin contributes ≤ 1.0). */
function weightedClosureStats(comparable: DdrIncident[], horizonEndSec: number, ageSec: number): WeightedClosureStats {
  const byCoin = new Map<string, { closed: number; total: number }>();
  for (const inc of comparable) {
    const e = byCoin.get(inc.stablecoinId) ?? { closed: 0, total: 0 };
    e.total += 1;
    if (inc.durationSec != null && inc.durationSec <= ageSec + horizonEndSec) e.closed += 1;
    byCoin.set(inc.stablecoinId, e);
  }
  let weightedClosures = 0;
  for (const { closed, total } of byCoin.values()) weightedClosures += closed / total;
  const probability = byCoin.size === 0 ? 0 : weightedClosures / byCoin.size;
  return {
    probability,
    effectiveN: byCoin.size,
    weightedClosures,
    weightedNonClosures: Math.max(0, byCoin.size - weightedClosures),
  };
}

function selectStratum(
  activeKey: DdrStratumKey,
  trainable: DdrIncident[],
  ageSec: number,
): { matched: DdrIncident[]; key: DdrStratumCandidate; label: string } {
  const candidates = candidateStrata(activeKey);
  let fallbackKey: DdrStratumCandidate | null = null;
  let fallbackMatched: DdrIncident[] = [];
  let fallbackComparableCount = -1;
  for (const cand of candidates) {
    const matched = trainable.filter((inc) => incidentMatchesAtAge(cand, inc, ageSec));
    const comparable = matched.filter((inc) => (inc.durationSec as number) >= ageSec);
    const uniqueCoins = new Set(comparable.map((m) => m.stablecoinId)).size;
    if (comparable.length > fallbackComparableCount) {
      fallbackKey = cand;
      fallbackMatched = matched;
      fallbackComparableCount = comparable.length;
    }
    if (comparable.length >= STRATUM_MIN_COMPARABLE_INCIDENTS && uniqueCoins >= STRATUM_MIN_UNIQUE_COINS) {
      return { matched, key: cand, label: stratumLabel(cand) };
    }
  }
  const key = fallbackKey ?? candidates[0];
  return { matched: fallbackMatched, key, label: stratumLabel(key) };
}

export function computeDuration(
  activeKey: DdrStratumKey,
  ageSec: number,
  incidents: DdrIncident[],
  quarantined: Set<string>,
): DdrDuration {
  const trainable = buildDurationTrainingCorpus(incidents, quarantined);
  const { matched, label } = selectStratum(activeKey, trainable, ageSec);

  const durationsAll = matched.map((m) => m.durationSec as number).sort((a, b) => a - b);
  const comparable = matched.filter((m) => (m.durationSec as number) >= ageSec);
  const coinMedianRemainingDur = coinMedianRemainingDurations(comparable, ageSec);
  const uniqueCoinsComparable = new Set(comparable.map((m) => m.stablecoinId)).size;

  // Age status uses the full matched-stratum duration distribution, not only
  // incidents still comparable at the current landmark age.
  const p90 = percentile(durationsAll, 0.9);
  const p99 = percentile(durationsAll, 0.99);
  let ageStatus: DdrDuration["ageStatus"] = durationsAll.length === 0 ? "data_issue" : "ordinary";
  if (durationsAll.length > 0) {
    if (ageSec > p99) ageStatus = "chronic_tail";
    else if (ageSec > p90) ageStatus = "extended";
  }

  const horizons: DdrHorizonCell[] = DDR_HORIZON_VALUES.map((h) => {
    const hSec = HORIZON_SECONDS[h];
    const closures = comparable.filter((m) => (m.durationSec as number) <= ageSec + hSec).length;
    const nonClosures = comparable.length - closures;
    const n = comparable.length;
    const weighted = weightedClosureStats(comparable, hSec, ageSec);
    const effectiveClosures = weighted.weightedClosures;
    const effectiveNonClosures = weighted.weightedNonClosures;

    let state: DdrHorizonCell["state"];
    if (n === 0) state = "unsupported";
    else if (ageStatus === "chronic_tail") state = "chronic_tail";
    else if (
      n >= BENCHMARKED_MIN_COMPARABLE_INCIDENTS &&
      uniqueCoinsComparable >= BENCHMARKED_MIN_UNIQUE_COINS &&
      weighted.effectiveN >= BENCHMARKED_MIN_EFFECTIVE_N &&
      effectiveClosures >= BENCHMARKED_MIN_WEIGHTED_CLOSURES &&
      effectiveNonClosures >= BENCHMARKED_MIN_WEIGHTED_NON_CLOSURES
    ) state = "benchmarked";
    else if (
      n >= STRATUM_MIN_COMPARABLE_INCIDENTS &&
      uniqueCoinsComparable >= STRATUM_MIN_UNIQUE_COINS &&
      weighted.effectiveN >= THIN_SUPPORT_MIN_EFFECTIVE_N &&
      effectiveClosures >= THIN_SUPPORT_MIN_WEIGHTED_CLOSURES
    ) state = "thin_support";
    else if (closures === 0) state = "no_comparable_closures";
    else state = "unsupported";

    const displayable = (state === "benchmarked" || state === "thin_support") && closures > 0;
    const interval = displayable ? wilson(effectiveClosures, weighted.effectiveN) : null;
    const probability = displayable ? weighted.probability : null;

    return {
      horizon: h,
      state,
      probability,
      probabilityDisplay: interval ? displayInterval(interval.lower, interval.upper) : null,
      probabilityInterval: interval,
      rawAtRisk: n,
      uniqueCoins: uniqueCoinsComparable,
      // Raw interval counts preserve historical row volume; support gates above
      // use coin-capped weighted counts to avoid one flappy coin dominating.
      intervalClosures: closures,
      intervalNonClosures: nonClosures,
    };
  });

  const hasSupport =
    comparable.length >= STRATUM_MIN_COMPARABLE_INCIDENTS &&
    uniqueCoinsComparable >= STRATUM_MIN_UNIQUE_COINS;

  return {
    suppressed: !hasSupport,
    suppressedReason: hasSupport ? null : "insufficient_support",
    stratum: label,
    medianSec: hasSupport ? percentile(coinMedianRemainingDur, 0.5) : null,
    iqrSec: hasSupport ? [percentile(coinMedianRemainingDur, 0.15), percentile(coinMedianRemainingDur, 0.85)] : null,
    ageStatus,
    horizons,
  };
}
