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
import type { DdrIncident } from "./incident-groups";
import { candidateStrata, stratumLabel, stratumMatches, type DdrStratumKey } from "./strata";

export const HORIZON_SECONDS: Record<DdrHorizon, number> = {
  "6h": 6 * 3600,
  "24h": 24 * 3600,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
};

const Z90 = 1.64;

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((sortedAsc.length - 1) * p)));
  return sortedAsc[idx];
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

/** Coin-capped weighted closure probability (each coin contributes ≤ 1.0). */
function weightedProbability(comparable: DdrIncident[], horizonEndSec: number, ageSec: number): number {
  const byCoin = new Map<string, { closed: number; total: number }>();
  for (const inc of comparable) {
    const e = byCoin.get(inc.stablecoinId) ?? { closed: 0, total: 0 };
    e.total += 1;
    if (inc.durationSec != null && inc.durationSec <= ageSec + horizonEndSec) e.closed += 1;
    byCoin.set(inc.stablecoinId, e);
  }
  let weightedClosures = 0;
  for (const { closed, total } of byCoin.values()) weightedClosures += closed / total;
  return byCoin.size === 0 ? 0 : weightedClosures / byCoin.size;
}

function selectStratum(
  activeKey: DdrStratumKey,
  trainable: DdrIncident[],
): { matched: DdrIncident[]; key: DdrStratumKey; label: string } {
  const candidates = candidateStrata(activeKey);
  let fallbackKey: DdrStratumKey | null = null;
  let fallbackMatched: DdrIncident[] = [];
  for (const cand of candidates) {
    const matched = trainable.filter((inc) => stratumMatches(cand, inc));
    const uniqueCoins = new Set(matched.map((m) => m.stablecoinId)).size;
    if (fallbackKey == null) {
      fallbackKey = cand;
      fallbackMatched = matched;
    }
    if (matched.length >= 10 && uniqueCoins >= 5) {
      return { matched, key: cand, label: stratumLabel(cand) };
    }
  }
  const key = fallbackKey ?? activeKey;
  return { matched: fallbackMatched, key, label: stratumLabel(key) };
}

export function computeDuration(
  activeKey: DdrStratumKey,
  ageSec: number,
  incidents: DdrIncident[],
  quarantined: Set<string>,
): DdrDuration {
  const trainable = incidents.filter(
    (i) => i.recovered && i.durationSec != null && !quarantined.has(i.stablecoinId),
  );
  const { matched, label } = selectStratum(activeKey, trainable);

  const durationsAll = matched.map((m) => m.durationSec as number).sort((a, b) => a - b);
  const comparable = matched.filter((m) => (m.durationSec as number) >= ageSec);
  const comparableDur = comparable.map((m) => m.durationSec as number).sort((a, b) => a - b);
  const uniqueCoinsComparable = new Set(comparable.map((m) => m.stablecoinId)).size;

  // age status from the full matched-stratum distribution
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

    let state: DdrHorizonCell["state"];
    if (n === 0) state = "unsupported";
    else if (ageStatus === "chronic_tail") state = "chronic_tail";
    else if (n >= 30 && uniqueCoinsComparable >= 10 && closures >= 5 && nonClosures >= 5) state = "benchmarked";
    else if (n >= 10 && uniqueCoinsComparable >= 5 && closures >= 1) state = "thin_support";
    else if (closures === 0) state = "no_comparable_closures";
    else state = "unsupported";

    const displayable = (state === "benchmarked" || state === "thin_support") && closures > 0;
    const interval = displayable ? wilson(closures, n) : null;
    const probability = displayable ? weightedProbability(comparable, hSec, ageSec) : null;

    return {
      horizon: h,
      state,
      probability,
      probabilityDisplay: interval ? displayInterval(interval.lower, interval.upper) : null,
      probabilityInterval: interval,
      rawAtRisk: n,
      uniqueCoins: uniqueCoinsComparable,
      intervalClosures: closures,
      intervalNonClosures: nonClosures,
    };
  });

  const hasSupport = comparable.length >= 10 && uniqueCoinsComparable >= 5;

  return {
    suppressed: !hasSupport,
    suppressedReason: hasSupport ? null : "insufficient_support",
    stratum: label,
    medianSec: hasSupport ? percentile(comparableDur, 0.5) : null,
    iqrSec: hasSupport ? [percentile(comparableDur, 0.25), percentile(comparableDur, 0.75)] : null,
    ageStatus,
    horizons,
  };
}
