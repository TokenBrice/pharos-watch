import { z } from "zod";
import { ApiMetaEnvelopeSchema } from "@pharos/contracts/api-meta";
import type { PegCurrency } from "../../types/core";

export const SELECTOR_PROFILES = ["treasury", "yield", "trading"] as const;

export const SELECTOR_ELIGIBLE_PEG_CURRENCIES = [
  "USD",
  "EUR",
  "CHF",
  "GOLD",
] as const satisfies readonly PegCurrency[];

const SELECTOR_ELIGIBLE_PEG_SET = new Set<string>(SELECTOR_ELIGIBLE_PEG_CURRENCIES);

export function isSelectorEligiblePegCurrency(
  value: string | null | undefined,
): value is (typeof SELECTOR_ELIGIBLE_PEG_CURRENCIES)[number] {
  return value != null && SELECTOR_ELIGIBLE_PEG_SET.has(value);
}

export const HORIZON_VALUES = ["lt24h", "1to7d", "1to4w", "1to6m", "6mplus"] as const;

export const DEPEG_TOLERANCE_VALUES = ["zero", "tight", "moderate"] as const;

export const COMPOSABILITY_VALUES = ["none", "moderate", "high"] as const;

export const EXIT_SPEED_VALUES = ["1h", "24h", "any"] as const;

export const DECENTRALIZATION_VALUES = ["any", "leaning", "required"] as const;

export const CUSTODY_OK_VALUES = ["any", "regulated-only", "onchain-only"] as const;

export const TREASURY_VENUE_VALUES = ["custody", "some", "active"] as const;

export const YIELD_VENUE_VALUES = ["lend", "dex", "wrap", "all"] as const;

export const TRADING_VENUE_VALUES = ["cex", "perps", "spot", "all"] as const;

export const WEIGHT_KEYS = [
  "safetyOverall",
  "resilience",
  "dependencyRisk",
  "pegStabilityHistory",
  "pegStabilityLive",
  "pegScoreNow",
  "decentralization",
  "dewsInverted",
  "bluechip",
  "supplyLog",
  "pharosYieldScore",
  "excessApy",
  "yieldVariance",
  "liquidity",
  "sourceRiskInverted",
  "effectiveExit",
  "liquidityDiversification",
] as const;

export const LOWEST_SUB_DIMENSION_KEYS = [
  "pegStability",
  "liquidity",
  "resilience",
  "decentralization",
  "dependencyRisk",
  "collateralQuality",
  "custodyModel",
  "governanceOverride",
  "activeDepegHistory",
  "yieldVariance",
  "sourceRisk",
] as const;

export const CONTEXT_KEYS = [
  "recent-listing",
  "yield-source-switched",
  "bluechip-weakness",
  "depeg-history",
  "high-venue-risk",
  "unstable-apy",
  "thin-tvl",
  "current-deviation",
  "coverage-thin",
] as const;

export const WHY_KEYS = [
  // Universal
  "top-safety",
  "strong-bluechip",
  "low-dews",
  "clean-peg-history",
  "strong-resilience",
  "wide-chain-presence",
  "recent-listing",
  // Treasury
  "regulated-custody",
  "low-dependency-risk",
  "dao-governance",
  "long-tracking-span",
  // Yield
  "top-pys",
  "yield-above-benchmark",
  "low-variance",
  "clean-yield-source",
  "native-wrapper-rail",
  "yield-source-recently-switched",
  "liquid-on-multiple-chains",
  // Trading
  "deepest-liquidity",
  "multi-dex-presence",
  "tight-peg",
  "low-stress",
  "strong-exit",
] as const;

export const BASE_CONFIDENCE_REASON_KEYS = [
  "recent-listing",
  "yield-source-switched",
  "short-yield-history",
  "treasury-depeg-history",
  "redistributed-missing-data",
  "source-risk-missing",
  "relaxed-fallback",
  "narrow-margin",
  "limited-v9-evidence",
  "v9-binding-cap",
] as const;

export const EXCLUSION_REASONS = [
  "supply-unavailable",
  "below-supply-floor",
  "active-depeg",
  "safety-grade-floor",
  "safety-resilience-floor",
  /** Retired before `selector-v2.0`; kept so v1.x snapshots still replay. */
  "safety-dependency-risk-floor",
  "dews-ceiling",
  "bluechip-d-or-f",
  "peg-score-floor",
  "pys-null",
  "apy-below-floor",
  "yield-warning-unstable",
  "yield-warning-thin-tvl",
  "high-venue-on-c-tier",
  "liquidity-floor",
  "effective-exit-floor",
  "supply-tvl-floor-1h",
  "peg-currency-mismatch",
  "yield-native-only-violation",
  "decentralization-required-violation",
  "insufficient-control-evidence",
  "custody-regulated-only-violation",
  "custody-onchain-only-violation",
  "howey-uncertain",
  "template-coverage-gap",
  "coverage-too-thin",
] as const;

export const SELECTOR_SNAPSHOT_VERIFICATION_KIND = "pharos-server-recomputed-v1" as const;

export const SelectorCanonicalSourceEvidenceSchema = z.object({
  source: z.literal("stablecoins"),
  /** Producer-owned source clock, verdict and named budgets; null means unknown. */
  freshness: ApiMetaEnvelopeSchema.nullable(),
}).strict();
