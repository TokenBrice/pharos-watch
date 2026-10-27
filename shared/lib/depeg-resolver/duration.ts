/**
 * Stage 2 — Expected Duration (DDRv5: unconditional cumulative incidence).
 *
 * Landmark Aalen–Johansen estimate over grouped, non-quarantined incidents,
 * stratified by direction × depth × structural class × peg currency with
 * most-dependable-first fallback. For an active event of age t we take the
 * comparable incidents still unresolved at age t and estimate, for each
 * horizon, the share that recovered — with terminal incidents as a competing
 * outcome (they never recover) and still-open or non-recovery closures
 * right-censored at their last trusted observation. Each coin carries at most
 * one unit of weight across its incidents in the risk set. Quantiles that the
 * cumulative-incidence curve never reaches stay null ("may not resolve").
 */

import type { DdrDuration, DdrHorizon, DdrHorizonCell } from "../../types/depeg-resolver";
import { DDR_DURATION_BAND_META, DDR_DURATION_ESTIMAND, DDR_HORIZON_VALUES } from "../../types/depeg-resolver";
import { groupDurationLabelIncidents, type DdrIncident } from "./incident-groups";
import { candidateStrata, depthBucket, stratumLabel, stratumMatches, type DdrStratumCandidate, type DdrStratumKey } from "./strata";
import { percentileLinear } from "../stats";

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

/**
 * Horizons whose landmark odds failed the DDRv5 replay skill gate (Brier skill
 * against out-of-sample base rates < 0). Methodology-owned; see
 * docs/depeg-resolver.md "Stage 2 — Expected Duration".
 */
const DDR_NOT_INFORMATIVE_HORIZONS: ReadonlySet<DdrHorizon> = new Set<DdrHorizon>([]);

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


function incidentDepthAtAge(incident: DdrIncident, ageSec: number): DdrIncident["depth"] | null {
  let worst: number | null = null;
  for (const fragment of incident.fragments ?? []) {
    if (fragment.offsetSec > ageSec) continue;
    if (worst == null || Math.abs(fragment.peakDeviationBps) > Math.abs(worst)) {
      worst = fragment.peakDeviationBps;
    }
  }
  return worst == null ? null : depthBucket(worst);
}

function incidentMatchesAtAge(candidate: DdrStratumCandidate, incident: DdrIncident, ageSec: number): boolean {
  const depth = incidentDepthAtAge(incident, ageSec);
  if (depth == null) return false;
  return stratumMatches(candidate, {
    direction: incident.direction,
    depth,
    structural: incident.structural,
    currency: incident.currency,
  });
}

/** A comparable incident's observed outcome, measured from its own onset. */
type DdrIncidentOutcome =
  | { kind: "recovery"; timeSec: number }
  | { kind: "terminal"; timeSec: number }
  | { kind: "censored"; timeSec: number };

/** Non-recovery closures shortly before a lifecycle freeze count toward that terminal outcome. */
const TERMINAL_CLOSURE_ATTRIBUTION_SEC = 30 * 86400;

function incidentOutcome(incident: DdrIncident, nowSec: number | undefined): DdrIncidentOutcome | null {
  if (incident.recovered && incident.durationSec != null) {
    return { kind: "recovery", timeSec: incident.durationSec };
  }
  const terminalAt = incident.terminalAt;
  if (
    terminalAt != null &&
    (incident.endedAt == null || incident.endedAt >= terminalAt - TERMINAL_CLOSURE_ATTRIBUTION_SEC)
  ) {
    return { kind: "terminal", timeSec: Math.max(0, terminalAt - incident.startedAt) };
  }
  if (incident.durationSec != null) return { kind: "censored", timeSec: incident.durationSec };
  // An open incident is observed until the evaluation clock; without one its
  // exposure is unknown and it cannot enter the estimate.
  if (nowSec == null) return null;
  return { kind: "censored", timeSec: Math.max(0, nowSec - incident.startedAt) };
}

function isTrainableIncident(incident: DdrIncident, nowSec: number | undefined): boolean {
  const outcome = incidentOutcome(incident, nowSec);
  if (outcome == null) return false;
  return outcome.timeSec >= MIN_TRAINING_DURATION_SEC || Math.abs(incident.peakDeviationBps) >= MIN_TRAINING_PEAK_BPS;
}

/** Comparable at landmark age t: unresolved and still under observation at t. */
function atRiskAtAge(incident: DdrIncident, ageSec: number, nowSec: number | undefined): boolean {
  const outcome = incidentOutcome(incident, nowSec);
  if (outcome == null) return false;
  return outcome.kind === "censored" ? outcome.timeSec > ageSec : outcome.timeSec >= ageSec;
}

// Test seam (keep exported): the DDR duration suite pins the trainable-corpus
// size directly; `computeDuration` cannot expose it. Not a production export.
export function buildDurationTrainingCorpus(
  incidents: DdrIncident[],
  quarantined: Set<string>,
  nowSec?: number,
): DdrIncident[] {
  return groupDurationLabelIncidents(incidents).filter(
    (incident) => isTrainableIncident(incident, nowSec) && !quarantined.has(incident.stablecoinId),
  );
}

interface CumulativeIncidenceCurve {
  /** Recovery cumulative incidence after each distinct event time (remaining seconds). */
  points: { remainingSec: number; cif: number }[];
  effectiveN: number;
}

/**
 * Coin-weighted Aalen–Johansen estimate of recovery with terminal as a
 * competing risk. Weights are fixed at the landmark: each coin's comparable
 * incidents share one unit.
 */
function recoveryCumulativeIncidence(comparable: DdrIncident[], ageSec: number, nowSec: number | undefined): CumulativeIncidenceCurve {
  const perCoin = new Map<string, number>();
  for (const incident of comparable) perCoin.set(incident.stablecoinId, (perCoin.get(incident.stablecoinId) ?? 0) + 1);
  const items = comparable.map((incident) => {
    const outcome = incidentOutcome(incident, nowSec)!;
    return {
      remainingSec: Math.max(0, outcome.timeSec - ageSec),
      kind: outcome.kind,
      weight: 1 / (perCoin.get(incident.stablecoinId) ?? 1),
    };
  }).sort((a, b) => a.remainingSec - b.remainingSec);

  let atRisk = roundWeight(items.reduce((sum, item) => sum + item.weight, 0));
  let survival = 1;
  let cif = 0;
  const points: CumulativeIncidenceCurve["points"] = [];
  let i = 0;
  while (i < items.length) {
    const time = items[i].remainingSec;
    let recovered = 0;
    let terminal = 0;
    let leaving = 0;
    while (i < items.length && items[i].remainingSec === time) {
      if (items[i].kind === "recovery") recovered += items[i].weight;
      else if (items[i].kind === "terminal") terminal += items[i].weight;
      leaving += items[i].weight;
      i += 1;
    }
    if (atRisk > 0 && recovered + terminal > 0) {
      cif = roundWeight(cif + survival * (recovered / atRisk));
      survival = roundWeight(survival * (1 - (recovered + terminal) / atRisk));
      points.push({ remainingSec: time, cif: Math.min(1, cif) });
    }
    atRisk = roundWeight(atRisk - leaving);
  }
  return { points, effectiveN: perCoin.size };
}

/** Coin weights are reciprocals; round away float drift so exact support floors stay exact. */
function roundWeight(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function cifAt(curve: CumulativeIncidenceCurve, remainingSec: number): number {
  let value = 0;
  for (const point of curve.points) {
    if (point.remainingSec > remainingSec) break;
    value = point.cif;
  }
  return value;
}

/** Smallest remaining time at which recovery incidence reaches q; null when it never does. */
function cifQuantile(curve: CumulativeIncidenceCurve, q: number): number | null {
  for (const point of curve.points) {
    if (point.cif >= q - 1e-12) return point.remainingSec;
  }
  return null;
}

/** Incidents whose horizon outcome is known: an event before t+h, or follow-up past t+h. */
function observableAtHorizon(comparable: DdrIncident[], ageSec: number, horizonSec: number, nowSec: number | undefined): DdrIncident[] {
  return comparable.filter((incident) => {
    const outcome = incidentOutcome(incident, nowSec)!;
    return outcome.kind !== "censored" || outcome.timeSec >= ageSec + horizonSec;
  });
}

function selectStratum(
  activeKey: DdrStratumKey,
  trainable: DdrIncident[],
  ageSec: number,
  nowSec: number | undefined,
): { matched: DdrIncident[]; key: DdrStratumCandidate; label: string } {
  const candidates = candidateStrata(activeKey);
  let fallbackKey: DdrStratumCandidate | null = null;
  let fallbackMatched: DdrIncident[] = [];
  let fallbackComparableCount = -1;
  for (const cand of candidates) {
    const matched = trainable.filter((inc) => incidentMatchesAtAge(cand, inc, ageSec));
    const comparable = matched.filter((inc) => atRiskAtAge(inc, ageSec, nowSec));
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
  nowSec?: number,
  activeStablecoinId?: string,
): DdrDuration {
  // The active incident's own open history is the thing being forecast, not a
  // comparable censored observation.
  const trainable = buildDurationTrainingCorpus(incidents, quarantined, nowSec).filter((incident) =>
    !(incident.endedAt == null && incident.stablecoinId === activeStablecoinId && incident.direction === activeKey.direction));
  const { matched, label } = selectStratum(activeKey, trainable, ageSec, nowSec);

  // Age status compares the open event with completed recoveries in the matched stratum.
  const durationsAll = matched
    .filter((m) => m.recovered && m.durationSec != null)
    .map((m) => m.durationSec as number)
    .sort((a, b) => a - b);
  const comparable = matched.filter((m) => atRiskAtAge(m, ageSec, nowSec));
  const uniqueCoinsComparable = new Set(comparable.map((m) => m.stablecoinId)).size;
  const curve = recoveryCumulativeIncidence(comparable, ageSec, nowSec);

  const p90 = percentileLinear(durationsAll, 90) ?? 0;
  const p99 = percentileLinear(durationsAll, 99) ?? 0;
  let ageStatus: DdrDuration["ageStatus"] = durationsAll.length === 0 ? "data_issue" : "ordinary";
  if (durationsAll.length > 0) {
    if (ageSec > p99) ageStatus = "chronic_tail";
    else if (ageSec > p90) ageStatus = "extended";
  }

  const horizons: DdrHorizonCell[] = DDR_HORIZON_VALUES.map((h) => {
    const hSec = HORIZON_SECONDS[h];
    const observable = observableAtHorizon(comparable, ageSec, hSec, nowSec);
    const n = observable.length;
    const closures = observable.filter((m) => {
      const outcome = incidentOutcome(m, nowSec)!;
      return outcome.kind === "recovery" && outcome.timeSec <= ageSec + hSec;
    }).length;
    const nonClosures = n - closures;
    const probabilityRaw = cifAt(curve, hSec);
    const observableCoins = new Set(observable.map((m) => m.stablecoinId)).size;
    const effectiveClosures = roundWeight(probabilityRaw * observableCoins);
    const effectiveNonClosures = roundWeight(Math.max(0, observableCoins - effectiveClosures));

    let state: DdrHorizonCell["state"];
    if (comparable.length === 0) state = "unsupported";
    else if (ageStatus === "chronic_tail") state = "chronic_tail";
    else if (
      n >= BENCHMARKED_MIN_COMPARABLE_INCIDENTS &&
      observableCoins >= BENCHMARKED_MIN_UNIQUE_COINS &&
      observableCoins >= BENCHMARKED_MIN_EFFECTIVE_N &&
      effectiveClosures >= BENCHMARKED_MIN_WEIGHTED_CLOSURES &&
      effectiveNonClosures >= BENCHMARKED_MIN_WEIGHTED_NON_CLOSURES
    ) state = "benchmarked";
    else if (
      n >= STRATUM_MIN_COMPARABLE_INCIDENTS &&
      observableCoins >= STRATUM_MIN_UNIQUE_COINS &&
      observableCoins >= THIN_SUPPORT_MIN_EFFECTIVE_N &&
      effectiveClosures >= THIN_SUPPORT_MIN_WEIGHTED_CLOSURES
    ) state = "thin_support";
    else if (closures === 0) state = "no_comparable_closures";
    else state = "unsupported";

    // Replay-gated skill: a supported cell that does not beat the base rate at
    // this horizon is published as not informative rather than as a percentage.
    if ((state === "benchmarked" || state === "thin_support") && DDR_NOT_INFORMATIVE_HORIZONS.has(h)) {
      state = "not_informative";
    }

    const displayable = state === "benchmarked" || state === "thin_support";
    const interval = displayable ? wilson(effectiveClosures, observableCoins) : null;
    const probability = displayable ? probabilityRaw : null;

    return {
      horizon: h,
      state,
      probability,
      probabilityDisplay: interval ? displayInterval(interval.lower, interval.upper) : null,
      probabilityInterval: interval,
      rawAtRisk: comparable.length,
      uniqueCoins: uniqueCoinsComparable,
      // Raw counts cover incidents whose horizon outcome is observed; support
      // gates use coin-weighted incidence to avoid one flappy coin dominating.
      intervalClosures: closures,
      intervalNonClosures: nonClosures,
    };
  });

  const hasSupport =
    comparable.length >= STRATUM_MIN_COMPARABLE_INCIDENTS &&
    uniqueCoinsComparable >= STRATUM_MIN_UNIQUE_COINS;
  const lower = hasSupport ? cifQuantile(curve, DDR_DURATION_BAND_META.lowerPercentile / 100) : null;
  const upper = hasSupport ? cifQuantile(curve, DDR_DURATION_BAND_META.upperPercentile / 100) : null;

  return {
    suppressed: !hasSupport,
    suppressedReason: hasSupport ? null : "insufficient_support",
    stratum: label,
    medianSec: hasSupport ? cifQuantile(curve, 0.5) : null,
    iqrSec: lower != null && upper != null ? [lower, upper] : null,
    ageStatus,
    horizons,
    estimand: DDR_DURATION_ESTIMAND,
    unresolvedShare30d: hasSupport ? Math.max(0, 1 - cifAt(curve, HORIZON_SECONDS["30d"])) : null,
  };
}
