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

// Definition order is the registry/wire order; execution and policy-map orders remain explicit.
export const YIELD_BENCHMARK_DEFINITIONS = {
  USD: {
    label: "USD 3M T-Bill",
    currency: "USD",
    isProxy: false,
    recordMaxAgeDays: 5,
    maxRelativeChange: 0.3,
    nativePeg: true,
    metadataPrefix: "usd",
    fetchOrder: 0,
    degradationOrder: 0,
    includeInCache: true,
  },
  USD_EFFR: {
    label: "USD effective federal funds rate",
    currency: "USD",
    isProxy: false,
    recordMaxAgeDays: 5,
    maxRelativeChange: 0.3,
    nativePeg: false,
    metadataPrefix: "usdEffr",
    fetchOrder: 1,
    degradationOrder: 1,
    includeInCache: true,
  },
  EUR: {
    label: "EUR 3M compounded €STR",
    currency: "EUR",
    isProxy: false,
    recordMaxAgeDays: 5,
    maxRelativeChange: 0.3,
    nativePeg: true,
    metadataPrefix: "eur",
    fetchOrder: 2,
    degradationOrder: 2,
    includeInCache: true,
  },
  // SAR3MC publishes T+1; Good Friday + Easter Monday can leave the newest print exactly 5d old.
  CHF: {
    label: "CHF 3M compounded SARON",
    currency: "CHF",
    isProxy: false,
    recordMaxAgeDays: 7,
    maxRelativeChange: 0.3,
    nativePeg: true,
    metadataPrefix: "chf",
    fetchOrder: 3,
    degradationOrder: 3,
    includeInCache: true,
  },
  // Bank of England IADB IUDZOS2 SONIA Compounded Index, annualized over a trailing 3M window.
  GBP: {
    label: "GBP 3M compounded SONIA",
    currency: "GBP",
    isProxy: false,
    recordMaxAgeDays: 5,
    maxRelativeChange: 0.3,
    nativePeg: true,
    metadataPrefix: "gbp",
    fetchOrder: 4,
    degradationOrder: 4,
    includeInCache: true,
  },
  // Bank of Japan STRDCLUCON uncollateralized overnight call rate (TONA-equivalent proxy).
  JPY: {
    label: "JPY overnight call (TONA proxy)",
    currency: "JPY",
    isProxy: true,
    recordMaxAgeDays: 5,
    maxRelativeChange: 0.3,
    nativePeg: true,
    metadataPrefix: "jpy",
    fetchOrder: 5,
    degradationOrder: 5,
    includeInCache: true,
  },
  // Banxico SF43936 — CETES 28-day primary auction yield.
  MXN: {
    label: "MXN CETES 28d",
    currency: "MXN",
    isProxy: false,
    recordMaxAgeDays: 5,
    maxRelativeChange: 1,
    nativePeg: true,
    metadataPrefix: "mxn",
    fetchOrder: 7,
    degradationOrder: 6,
    includeInCache: true,
  },
  // Effective SELIC over: SGS11 daily compounded over 252 days, or SGS1178 already annualized.
  BRL: {
    label: "BRL SELIC over",
    currency: "BRL",
    isProxy: false,
    recordMaxAgeDays: 5,
    maxRelativeChange: 1,
    nativePeg: true,
    metadataPrefix: "brl",
    fetchOrder: 8,
    degradationOrder: 7,
    includeInCache: true,
  },
  // Reserve Bank of Australia F1 cash-rate target.
  AUD: {
    label: "AUD cash-rate target",
    currency: "AUD",
    isProxy: false,
    recordMaxAgeDays: 5,
    maxRelativeChange: 0.3,
    nativePeg: true,
    metadataPrefix: "aud",
    fetchOrder: 6,
    degradationOrder: 8,
    includeInCache: true,
  },
  // BoC Valet V122530 is the monthly administered Bank rate, not daily CORRA.
  CAD: {
    label: "CAD Bank rate (policy, monthly)",
    currency: "CAD",
    isProxy: true,
    recordMaxAgeDays: 45,
    maxRelativeChange: 0.3,
    nativePeg: true,
    metadataPrefix: "cad",
    fetchOrder: 9,
    degradationOrder: 9,
    includeInCache: true,
  },
  // CBR DailyInfo KeyRateXML; prints can sit ~9-10 days old across Jan 1-8 closures.
  RUB: {
    label: "RUB CBR key rate",
    currency: "RUB",
    isProxy: false,
    recordMaxAgeDays: 12,
    maxRelativeChange: 1,
    nativePeg: true,
    metadataPrefix: "rub",
    fetchOrder: 10,
    degradationOrder: 10,
    includeInCache: true,
  },
  // CBRT EVDS TP.BISTTLREF.ORAN; Kurban/Bayram holidays can leave prints past 5d.
  TRY: {
    label: "TRY BIST TLREF overnight",
    currency: "TRY",
    isProxy: false,
    recordMaxAgeDays: 10,
    maxRelativeChange: 1,
    nativePeg: true,
    metadataPrefix: "try",
    fetchOrder: 11,
    degradationOrder: 11,
    includeInCache: true,
  },
  // TODO: wire MAS SORA when a stable public endpoint is identified; SGD pegs fall back to USD.
  SGD: {
    label: "SGD SORA (unavailable)",
    currency: "SGD",
    isProxy: false,
    recordMaxAgeDays: 5,
    maxRelativeChange: 0.3,
    nativePeg: false,
    metadataPrefix: null,
    fetchOrder: null,
    degradationOrder: null,
    includeInCache: true,
  },
} as const;
export type YieldBenchmarkKey = keyof typeof YIELD_BENCHMARK_DEFINITIONS;
export const YIELD_BENCHMARK_KEY_VALUES = Object.keys(YIELD_BENCHMARK_DEFINITIONS) as unknown as readonly [YieldBenchmarkKey, ...YieldBenchmarkKey[]];

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
export const YIELD_BENCHMARK_KEY_CURRENCY: Record<YieldBenchmarkKey, string> = Object.fromEntries(
  YIELD_BENCHMARK_KEY_VALUES.map((key) => [key, YIELD_BENCHMARK_DEFINITIONS[key].currency]),
) as Record<YieldBenchmarkKey, string>;
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
