/**
 * Stratification for the Stage 2 duration estimate.
 *
 * Spike-validated: below-peg recovered duration is sharply monotonic in depth
 * (minor ~1h p50 → moderate ~6h → severe ~25h with a fat tail), so depth and
 * direction are the load-bearing axes. Structural class and peg currency refine
 * when support allows, and are dropped first under the "most-dependable" rule.
 */

import type { DepegDirection } from "../../types/market";
import type { DdrCoinStructural } from "./inputs";

export type DdrDepthBucket = "minor" | "moderate" | "severe" | "catastrophic";
export type DdrStructuralClass = "robust" | "fragile";
export type DdrCurrencyClass = "USD" | "non-USD";

/** Sentinel used in candidate strata to mean "ignore this dimension". */
export const STRATUM_ANY = "__any__";

export interface DdrStratumKey {
  direction: DepegDirection;
  depth: DdrDepthBucket;
  structural: DdrStructuralClass;
  currency: DdrCurrencyClass;
}

export interface DdrStratumCandidate {
  direction: DepegDirection;
  depths: readonly DdrDepthBucket[];
  structural: DdrStructuralClass | typeof STRATUM_ANY;
  currency: DdrCurrencyClass | typeof STRATUM_ANY;
}

/** Depth bucket from absolute peak deviation in bps (spike thresholds). */
export function depthBucket(peakDeviationBps: number): DdrDepthBucket {
  const bps = Math.abs(peakDeviationBps);
  if (bps <= 250) return "minor";
  if (bps <= 1000) return "moderate";
  if (bps <= 2500) return "severe";
  return "catastrophic";
}

const ROBUST_ARCHETYPES = new Set(["cdp", "fiat-cash", "tbill", "rwa-credit-fund"]);
// `unbounded-reconciled` is a supervisory refinement *within* the unbounded
// class, not an exit from it: the claim can still be expanded at will, and
// reconciliation is after-the-fact evidence rather than a bound. It stays
// fragile so adopting the finer curated vocabulary moves no depeg verdict.
const FRAGILE_POSTURES = new Set([
  "concentrated-admin",
  "unbounded-reconciled",
  "unbounded-or-compromised",
]);

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
export function stratumLabel(key: DdrStratumKey | DdrStratumCandidate): string {
  const structural = key.structural === STRATUM_ANY ? "any" : key.structural;
  const currency = key.currency === STRATUM_ANY ? "any" : key.currency;
  const depths = "depths" in key ? key.depths : [key.depth];
  const depthLabel = depths.length === 1 ? depths[0] : depths.join("+");
  return `${key.direction} · ${depthLabel} · ${structural} · ${currency}`;
}

/**
 * Candidate strata for an active event, from most specific to coarsest:
 * USD subjects drop currency before structure. Non-USD subjects preserve their
 * currency while dropping structure, so their clock cannot borrow USD history
 * merely to retain a structural class. Severe/catastrophic events never borrow
 * the minor-flap clock.
 */
export function candidateStrata(active: DdrStratumKey): DdrStratumCandidate[] {
  const exact: readonly DdrDepthBucket[] = [active.depth];
  const collapsed: readonly DdrDepthBucket[] =
    active.depth === "catastrophic" || active.depth === "severe"
      ? ["severe", "catastrophic"]
      : active.depth === "moderate"
        ? ["moderate", "severe", "catastrophic"]
        : ["minor"];
  const broad: readonly DdrDepthBucket[] =
    active.depth === "minor"
      ? ["minor"]
      : ["moderate", "severe", "catastrophic"];
  const collapsedAddsDepthCoverage = collapsed.length > exact.length || collapsed[0] !== exact[0];
  const broadAddsDepthCoverage = broad.length > collapsed.length || broad.some((d) => !collapsed.includes(d));

  const out: DdrStratumCandidate[] = [
    { direction: active.direction, depths: exact, structural: active.structural, currency: active.currency },
  ];
  const retainCurrency = active.currency === "non-USD";
  const refinedCurrency = retainCurrency ? active.currency : STRATUM_ANY;

  if (retainCurrency) {
    out.push({ direction: active.direction, depths: exact, structural: STRATUM_ANY, currency: active.currency });
  } else {
    out.push({ direction: active.direction, depths: exact, structural: active.structural, currency: STRATUM_ANY });
  }
  if (collapsedAddsDepthCoverage) {
    out.push({
      direction: active.direction,
      depths: collapsed,
      structural: retainCurrency ? STRATUM_ANY : active.structural,
      currency: refinedCurrency,
    });
  }
  if (broadAddsDepthCoverage) {
    out.push({
      direction: active.direction,
      depths: broad,
      structural: retainCurrency ? STRATUM_ANY : active.structural,
      currency: refinedCurrency,
    });
  }
  out.push({ direction: active.direction, depths: exact, structural: STRATUM_ANY, currency: STRATUM_ANY });
  if (collapsedAddsDepthCoverage) {
    out.push({ direction: active.direction, depths: collapsed, structural: STRATUM_ANY, currency: STRATUM_ANY });
  }
  if (broadAddsDepthCoverage) {
    out.push({ direction: active.direction, depths: broad, structural: STRATUM_ANY, currency: STRATUM_ANY });
  }
  return out;
}

/** Whether a historical incident's key matches a (possibly wildcarded) candidate. */
export function stratumMatches(
  candidate: DdrStratumCandidate,
  incident: Pick<DdrStratumKey, "direction" | "depth" | "structural" | "currency">,
): boolean {
  if (candidate.direction !== incident.direction) return false;
  if (!candidate.depths.includes(incident.depth)) return false;
  if (candidate.structural !== STRATUM_ANY && candidate.structural !== incident.structural) return false;
  if (candidate.currency !== STRATUM_ANY && candidate.currency !== incident.currency) return false;
  return true;
}
