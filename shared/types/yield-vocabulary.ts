export const YIELD_ADAPTER_LIFECYCLE_VALUES = ["active", "quarantined", "intentional-gap", "experimental"] as const;
export type YieldAdapterLifecycle = (typeof YIELD_ADAPTER_LIFECYCLE_VALUES)[number];

export interface YieldAdapterLifecycleReason {
  /** Canonical short code such as "convert-to-assets-empty" or "no-public-yield-source". */
  code: string;
  /** ISO date (YYYY-MM-DD) the entry entered this lifecycle state. */
  since: string;
  /** Optional ISO date by which an operator should re-review the entry. */
  nextReviewAt?: string;
  /** Optional URL to docs, runbook, or evidence. */
  evidenceUrl?: string;
  /** Short free-form note (legacy rationale text lives here). */
  note?: string;
}

export const YIELD_BENCHMARK_KEY_VALUES = [
  "USD",
  "USD_EFFR",
  "EUR",
  "CHF",
  "GBP",
  "JPY",
  "MXN",
  "BRL",
  "AUD",
  "CAD",
  "RUB",
  "TRY",
  "SGD",
] as const;
export type YieldBenchmarkKey = (typeof YIELD_BENCHMARK_KEY_VALUES)[number];

/**
 * Closed vocabulary of per-source yield warning keys. `detectWarningSignals()`
 * in `worker/src/cron/yield-helpers.ts` is typed to this list and DEWS pins its
 * `YIELD_WARNING_SCORES` table against it, so a new key cannot reach the stress
 * score without a reviewed weight (R5).
 */
export const YIELD_WARNING_SIGNAL_KEYS = [
  "yield-spike",
  "yield-divergence",
  "negative-trend",
  "reward-heavy",
  "tvl-outflow",
  "zero-yield",
] as const;
export type YieldWarningSignalKey = (typeof YIELD_WARNING_SIGNAL_KEYS)[number];

/**
 * Currency each benchmark key is quoted in. Every key names its own currency
 * except `USD_EFFR`, an alternative USD curve: the yield v8.43 hurdle re-base is
 * skipped when the row's benchmark currency is already USD (B24), so callers
 * replaying stored inputs need the key → currency mapping.
 */
export const YIELD_BENCHMARK_KEY_CURRENCY: Record<YieldBenchmarkKey, string> = {
  USD: "USD",
  USD_EFFR: "USD",
  EUR: "EUR",
  CHF: "CHF",
  GBP: "GBP",
  JPY: "JPY",
  MXN: "MXN",
  BRL: "BRL",
  AUD: "AUD",
  CAD: "CAD",
  RUB: "RUB",
  TRY: "TRY",
  SGD: "SGD",
};
export const YIELD_PYS_NULL_REASONS = [
  "apy-non-positive",
  "effective-yield-non-positive",
  "scaling-invalid",
  "missing-inputs",
  "source-stale",
  "source-freshness-unknown",
  "benchmark-stale",
  "safety-unrated",
  "opportunity-evidence-missing",
] as const;
export type YieldPysNullReason = (typeof YIELD_PYS_NULL_REASONS)[number];
export type YieldBenchmarkSelectionMode = "native" | "fallback-usd" | "manual-override";
export type YieldSafetyProvenance =
  | "live-report-card"
  | "cached-publish"
  | "default-safety"
  | "opportunity-safety"
  | "safety-snapshot-unavailable";
export const YIELD_SAFETY_REASON_VALUES = [
  "report-card-score-missing",
  "report-card-grade-not-rated",
  "underlying-report-card-score-missing",
  "safety-snapshot-unavailable",
  "safety-identity-missing",
  "safety-identity-mismatch",
] as const;
export type YieldSafetyReason = (typeof YIELD_SAFETY_REASON_VALUES)[number];
export type YieldVenueRiskTier = "low" | "medium" | "high" | "unknown";
export type YieldTrancheSide = "senior" | "junior";
export type YieldMarketStatus = "normal" | "protected" | "unhealthy" | "critical";
export const YIELD_SOURCE_CONFIDENCE_TIER_VALUES = ["deterministic", "curated", "discovered", "fallback"] as const;
export type YieldSourceConfidenceTier = (typeof YIELD_SOURCE_CONFIDENCE_TIER_VALUES)[number];
export const YIELD_CALCULATION_MODE_VALUES = [
  "direct-read",
  "exchange-rate-math",
  "market-api",
  "benchmark-model",
  "price-return",
] as const;
export type YieldCalculationMode = (typeof YIELD_CALCULATION_MODE_VALUES)[number];
export const YIELD_EVIDENCE_CLASS_VALUES = [
  "direct-first-party",
  "direct-onchain",
  "curated-observation",
  "discovered-observation",
  "modeled-proxy",
  "fallback",
] as const;
export type YieldEvidenceClass = (typeof YIELD_EVIDENCE_CLASS_VALUES)[number];
export const YIELD_SCORE_QUALIFICATION_VALUES = ["rated", "estimated", "partial", "NR"] as const;
export type YieldScoreQualification = (typeof YIELD_SCORE_QUALIFICATION_VALUES)[number];
export const YIELD_SOURCE_ROLE_VALUES = [
  "canonical-holder",
  "external-opportunity",
  "fallback-proxy",
  "audit-alternate",
  "degraded-canonical",
] as const;
export type YieldSourceRole = (typeof YIELD_SOURCE_ROLE_VALUES)[number];
export const YIELD_DEPLOYMENT_PLACE_VALUES = [
  "native-wrapper",
  "issuer-savings",
  "lending-market",
  "strategy-vault",
  "structured-tranche",
  "lp-or-dex",
  "rwa-fund",
  "reward-program",
  "rate-derived",
  "price-derived",
] as const;
export type YieldDeploymentPlace = (typeof YIELD_DEPLOYMENT_PLACE_VALUES)[number];
export const YIELD_RANK_CHANGE_DRIVER_VALUES = [
  "apy",
  "benchmark",
  "stablecoin-safety",
  "source-risk",
  "source-switch",
  "freshness",
  "volatility",
  "tvl-depth",
  // A methodology release moved the published score independently of the row's
  // own inputs (e.g. the v8.43 hurdle re-base), so no evidence field explains it.
  "methodology",
] as const;
export type YieldRankChangeDriver = (typeof YIELD_RANK_CHANGE_DRIVER_VALUES)[number];

export const YIELD_DECISION_REASON_CODES = [
  "best-by-confidence-and-apy",
  "deterministic-preferred",
  "curated-over-discovered",
  "tier-preference",
  "tvl-floor",
  "freshness-tiebreaker",
  "fallback",
  "no-alternatives",
] as const;
export type YieldDecisionReasonCode = (typeof YIELD_DECISION_REASON_CODES)[number];

export const YIELD_DECISION_REJECTION_REASON_CODES = [
  "thinner",
  "stale",
  "lower-confidence",
  "rewards-only",
  "smaller",
  "unspecified",
] as const;
export type YieldDecisionRejectionReasonCode = (typeof YIELD_DECISION_REJECTION_REASON_CODES)[number];

export const YIELD_OPPORTUNITY_CLASS_VALUES = ["lending", "fixed-yield", "structured-tranche"] as const;
export type YieldOpportunityClass = (typeof YIELD_OPPORTUNITY_CLASS_VALUES)[number];

export const YIELD_OPPORTUNITY_CRITICAL_EVIDENCE_VALUES = ["venue-review", "market-size", "market-status"] as const;
export type YieldOpportunityCriticalEvidence = (typeof YIELD_OPPORTUNITY_CRITICAL_EVIDENCE_VALUES)[number];
