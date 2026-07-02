/**
 * Select the lowest sub-dimension to surface as the "What to watch" line.
 *
 * Binding: `agents/impl-plan-drafts/02-engine.md` §9.
 */
import type {
  ContextKey,
  LowestSubDimension,
  LowestSubDimensionKey,
  MergedRow,
  SelectorComponent,
  SelectorProfile,
  WeightKey,
} from "./types";
import { round1 } from "../math";
import { WEIGHT_VECTORS } from "./weights";
import { yieldVariance as normYieldVariance, sourceRiskInverted } from "./normalization";

const SAFETY_NINE = [
  "pegStability",
  "liquidity",
  "resilience",
  "decentralization",
  "dependencyRisk",
  "collateralQuality",
  "custodyModel",
  "governanceOverride",
  "activeDepegHistory",
] as const satisfies readonly LowestSubDimensionKey[];

export const LOWEST_SUB_DIMENSION_CANDIDATES: Record<
  SelectorProfile,
  readonly LowestSubDimensionKey[]
> = {
  treasury: SAFETY_NINE,
  trading: SAFETY_NINE,
  yield: [...SAFETY_NINE, "yieldVariance", "sourceRisk"] as const,
};

const CUSTODY_LADDER: Record<string, number> = {
  "institutional-top": 100,
  "institutional-regulated": 85,
  "institutional-unregulated": 60,
  "institutional-sanctioned": 50,
  cex: 40,
  onchain: 90,
};

/**
 * Look up the normalized value of a candidate sub-dimension on a row.
 * Returns `null` when the underlying signal is absent.
 */
export function lookupNormalizedSubDimension(
  row: MergedRow,
  key: LowestSubDimensionKey,
): number | null {
  switch (key) {
    case "pegStability":
      return row.pegStabilityScore;
    case "liquidity":
      return row.safetyLiquidityScore;
    case "resilience":
      return row.safetyResilienceScore;
    case "decentralization":
      return row.safetyDecentralizationScore;
    case "dependencyRisk":
      return row.safetyDependencyRiskScore;
    case "collateralQuality":
      return row.collateralQuality;
    case "custodyModel":
      return row.custodyModel != null ? (CUSTODY_LADDER[row.custodyModel] ?? null) : null;
    case "governanceOverride":
      if (row.canBeBlacklisted === true) return 0;
      if (row.canBeBlacklisted === "inherited") return 30;
      if (row.canBeBlacklisted === "possible") return 60;
      return 100;
    case "activeDepegHistory":
      return 100 - Math.min(100, (row.depegEventCount / 5) * 100);
    case "yieldVariance":
      return normYieldVariance(row.apyVariance30d);
    case "sourceRisk":
      return sourceRiskInverted(row.sourceRiskScore);
  }
}

/**
 * Tie-break helper: pick the candidate key whose corresponding weight in the
 * profile's vector is highest. Returns `null` when neither key maps cleanly.
 */
function profileWeightFor(
  profile: SelectorProfile,
  key: LowestSubDimensionKey,
): number {
  const vector = WEIGHT_VECTORS[profile];
  // Map sub-dimension key → closest weight slot in the profile vector.
  const slot: WeightKey | null = (() => {
    switch (key) {
      case "pegStability":
        return profile === "treasury" ? "pegStabilityHistory" : "pegStabilityLive";
      case "liquidity":
        return "liquidity";
      case "resilience":
        return "resilience";
      case "decentralization":
        return "decentralization";
      case "dependencyRisk":
        return "dependencyRisk";
      case "yieldVariance":
        return "yieldVariance";
      case "sourceRisk":
        return "sourceRiskInverted";
      default:
        return null;
    }
  })();
  if (slot == null) return 0;
  return (vector as Record<string, number | undefined>)[slot] ?? 0;
}

function deriveContextKeys(row: MergedRow): ContextKey[] {
  const keys: ContextKey[] = [];
  if (row.isRecentListing) keys.push("recent-listing");
  if (row.sourceSwitch) keys.push("yield-source-switched");
  if (row.bluechipGrade === "D" || row.bluechipGrade === "F") {
    keys.push("bluechip-weakness");
  }
  if (row.depegEventCount >= 1) keys.push("depeg-history");
  if (row.venueRiskTier === "high") keys.push("high-venue-risk");
  if (row.warningSignals.includes("unstable-apy")) keys.push("unstable-apy");
  if (row.warningSignals.includes("thin-tvl")) keys.push("thin-tvl");
  if (row.currentDeviationBps != null && Math.abs(row.currentDeviationBps) > 25) {
    keys.push("current-deviation");
  }
  return keys;
}

/**
 * Select the lowest-scoring sub-dimension on the row for the given profile.
 * Returns `null` when every candidate dimension is null — the engine treats
 * that as a `template-coverage-gap` exclusion so no shortlist entry ships
 * without a watch line.
 *
 * `components` is accepted for API symmetry with the engine pipeline; we
 * read raw sub-dimensions from the row directly because the weight-vector
 * components are restricted to scoring slots and don't cover the full
 * candidate set.
 */
export function selectLowestSubDimension(
  row: MergedRow,
  profile: SelectorProfile,
  _components: SelectorComponent[],
): LowestSubDimension | null {
  const candidates = LOWEST_SUB_DIMENSION_CANDIDATES[profile];

  let lowestKey: LowestSubDimensionKey | null = null;
  let lowestVal = Infinity;

  for (const key of candidates) {
    const value = lookupNormalizedSubDimension(row, key);
    if (value == null) continue;
    if (value < lowestVal) {
      lowestVal = value;
      lowestKey = key;
    } else if (value === lowestVal && lowestKey != null) {
      // Tie-break: profile-relevance (higher weight wins).
      if (profileWeightFor(profile, key) > profileWeightFor(profile, lowestKey)) {
        lowestKey = key;
      }
    }
  }

  if (lowestKey == null) {
    return null;
  }

  return {
    key: lowestKey,
    score: round1(lowestVal),
    contextKeys: deriveContextKeys(row),
  };
}
