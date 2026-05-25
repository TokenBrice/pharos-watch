/**
 * Stratification for the Stage 2 duration estimate.
 *
 * Spike-validated: below-peg recovered duration is sharply monotonic in depth
 * (minor ~1h p50 → moderate ~6h → severe ~25h with a fat tail), so depth and
 * direction are the load-bearing axes. Structural class and peg currency refine
 * when support allows, and are dropped first under the "most-dependable" rule.
 */

import type { DdrCoinStructural } from "./inputs";

export type DdrDepthBucket = "minor" | "moderate" | "severe" | "catastrophic";
export type DdrStructuralClass = "robust" | "fragile";
export type DdrCurrencyClass = "USD" | "non-USD";

/** Sentinel used in candidate strata to mean "ignore this dimension". */
export const STRATUM_ANY = "__any__";

export interface DdrStratumKey {
  direction: "above" | "below";
  depth: DdrDepthBucket;
  structural: DdrStructuralClass;
  currency: DdrCurrencyClass;
}

const DEPTH_ORDER: DdrDepthBucket[] = ["minor", "moderate", "severe", "catastrophic"];

/** Depth bucket from absolute peak deviation in bps (spike thresholds). */
export function depthBucket(peakDeviationBps: number): DdrDepthBucket {
  const bps = Math.abs(peakDeviationBps);
  if (bps <= 250) return "minor";
  if (bps <= 1000) return "moderate";
  if (bps <= 2500) return "severe";
  return "catastrophic";
}

const ROBUST_ARCHETYPES = new Set(["cdp", "fiat-cash", "tbill", "rwa-credit-fund"]);
const FRAGILE_POSTURES = new Set(["concentrated-admin", "unbounded-or-compromised"]);

/**
 * Coarse 2-way structural class. Robust = a real-collateral mechanism with a
 * non-concentrated minter; everything algorithmic/synthetic/concentrated/exotic
 * is fragile. Defaults to fragile when unknown (conservative).
 */
export function structuralClass(coin: DdrCoinStructural): DdrStructuralClass {
  const archetype = coin.mechanismArchetype ?? null;
  const posture = coin.authorityPosture ?? null;
  if (posture && FRAGILE_POSTURES.has(posture)) return "fragile";
  if (coin.collateralQuality === "exotic") return "fragile";
  if (archetype && ROBUST_ARCHETYPES.has(archetype)) return "robust";
  if (coin.mintPath === "immutable-user-collateralized" || posture === "none-resolved") return "robust";
  return "fragile";
}

export function currencyClass(pegCurrency: string): DdrCurrencyClass {
  return pegCurrency === "USD" ? "USD" : "non-USD";
}

/** Human label for a stratum, used in the payload for transparency. */
export function stratumLabel(key: DdrStratumKey): string {
  const structural = (key.structural as string) === STRATUM_ANY ? "any" : key.structural;
  const currency = (key.currency as string) === STRATUM_ANY ? "any" : key.currency;
  return `${key.direction} · ${key.depth} · ${structural} · ${currency}`;
}

/**
 * Candidate strata for an active event, from most specific to coarsest.
 * For each depth level (active → collapsed toward minor) we try:
 * full → drop currency → drop structural+currency. direction+depth is retained.
 */
export function candidateStrata(active: DdrStratumKey): DdrStratumKey[] {
  const startIdx = DEPTH_ORDER.indexOf(active.depth);
  const depths = DEPTH_ORDER.slice(0, startIdx + 1).reverse(); // active depth down to minor
  const out: DdrStratumKey[] = [];
  for (const depth of depths) {
    out.push({ direction: active.direction, depth, structural: active.structural, currency: active.currency });
    out.push({ direction: active.direction, depth, structural: active.structural, currency: STRATUM_ANY as DdrCurrencyClass });
    out.push({ direction: active.direction, depth, structural: STRATUM_ANY as DdrStructuralClass, currency: STRATUM_ANY as DdrCurrencyClass });
  }
  return out;
}

/** Whether a historical incident's key matches a (possibly wildcarded) candidate. */
export function stratumMatches(
  candidate: DdrStratumKey,
  incident: Pick<DdrStratumKey, "direction" | "depth" | "structural" | "currency">,
): boolean {
  if (candidate.direction !== incident.direction) return false;
  if (candidate.depth !== incident.depth) return false;
  if ((candidate.structural as string) !== STRATUM_ANY && candidate.structural !== incident.structural) return false;
  if ((candidate.currency as string) !== STRATUM_ANY && candidate.currency !== incident.currency) return false;
  return true;
}
