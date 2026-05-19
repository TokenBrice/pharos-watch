/**
 * Stablecoin Selector — type vocabulary.
 *
 * Single source of truth for selector enums and shapes. Every enumerable
 * string vocabulary is declared once as an `as const` tuple; types are
 * derived via `(typeof X_VALUES)[number]` so adding a value is a one-file
 * change and cross-profile typos surface at compile time.
 *
 * Binding: `agents/selector-implementation-plan.md` §3 + `agents/selector-design.md` §3.6.
 */
import type { BluechipGrade, PegCurrency, ReportCardGrade } from "../../types";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const SELECTOR_PROFILES = ["treasury", "yield", "trading"] as const;
export type SelectorProfile = (typeof SELECTOR_PROFILES)[number];

export const HORIZON_VALUES = ["lt24h", "1to7d", "1to4w", "1to6m", "6mplus"] as const;
export type SelectorHorizon = (typeof HORIZON_VALUES)[number];

export const DEPEG_TOLERANCE_VALUES = ["zero", "tight", "moderate"] as const;
export type SelectorDepegTolerance = (typeof DEPEG_TOLERANCE_VALUES)[number];

export const COMPOSABILITY_VALUES = ["none", "moderate", "high"] as const;
export type SelectorComposability = (typeof COMPOSABILITY_VALUES)[number];

export const EXIT_SPEED_VALUES = ["1h", "24h", "any"] as const;
export type SelectorExitSpeed = (typeof EXIT_SPEED_VALUES)[number];

export const DECENTRALIZATION_VALUES = ["any", "leaning", "required"] as const;
export type SelectorDecentralization = (typeof DECENTRALIZATION_VALUES)[number];

export const CUSTODY_OK_VALUES = ["any", "regulated-only", "onchain-only"] as const;
export type SelectorCustodyOk = (typeof CUSTODY_OK_VALUES)[number];

export interface SelectorInput {
  profile: SelectorProfile;
  /** MVP locked to USD. Wired through for Phase 2 non-USD pegs. */
  pegCurrency: "USD";
  horizon: SelectorHorizon;
  depegTolerance: SelectorDepegTolerance;
  composability: SelectorComposability;
  exitSpeed: SelectorExitSpeed;
  /** MVP-internal: not collected from the wizard in Phase 1. */
  minApy: number | null;
  /** MVP-internal default `false`. */
  yieldNativeOnly: boolean;
  /** MVP-internal default `"any"`. */
  decentralization: SelectorDecentralization;
  /** MVP-internal default `"any"`. */
  custodyOk: SelectorCustodyOk;
}

// ---------------------------------------------------------------------------
// Scoring vocabulary
// ---------------------------------------------------------------------------

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
export type WeightKey = (typeof WEIGHT_KEYS)[number];

/**
 * Generic over the profile that the vector applies to. Cross-profile typos
 * (e.g. assigning `pharosYieldScore` weight to a Treasury vector) surface at
 * compile time when the caller is parameterized over `P`.
 */
export type WeightVector<P extends SelectorProfile = SelectorProfile> = Readonly<
  Partial<Record<WeightKey, number>>
> & {
  /** Phantom field that pins the vector to a profile at the type level. */
  readonly __profile?: P;
};

export interface SelectorComponent {
  key: WeightKey;
  /** Weight applied to this slot after redistribution. */
  weight: number;
  rawValue: number | null;
  /** Normalized to [0, 100]; higher is better. */
  normalizedValue: number | null;
  /** `weight × normalizedValue / 100`. */
  contribution: number;
  /** True when the raw value was null and the slot was Penalty + redistribute. */
  redistributed: boolean;
}

// ---------------------------------------------------------------------------
// Lowest sub-dimension
// ---------------------------------------------------------------------------

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
export type LowestSubDimensionKey = (typeof LOWEST_SUB_DIMENSION_KEYS)[number];

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
export type ContextKey = (typeof CONTEXT_KEYS)[number];

export interface LowestSubDimension {
  key: LowestSubDimensionKey;
  /** Normalized [0, 100], higher = better. */
  score: number;
  contextKeys: ContextKey[];
}

// ---------------------------------------------------------------------------
// Why-keys (canonical reason vocabulary)
// ---------------------------------------------------------------------------

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
export type WhyKey = (typeof WHY_KEYS)[number];

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

export interface RecommendedSource {
  protocol: string;
  chain: string;
  apy30d: number;
  pharosYieldScore: number | null;
  sourceRiskTier: "low" | "mid" | "high";
  freshness: { capturedAt: number; ageSeconds: number };
}

export interface SelectorChainHints {
  topByLiquidity: string[];
  topByYield: string[];
  primary: string | null;
}

interface SelectorRecommendationBase {
  id: string;
  symbol: string;
  name: string;
  rank: 1 | 2 | 3;
  score: number;
  confidence: number;
  components: SelectorComponent[];
  whyKeys: WhyKey[];
  lowestSubDimension: LowestSubDimension;
  chainHints: SelectorChainHints;
  isRecentListing: boolean;
  bluechipGrade: BluechipGrade | null;
  safetyGrade: ReportCardGrade;
  supplyUsd: number;
  isBeta: true;
}

export interface TreasuryRecommendation extends SelectorRecommendationBase {
  profile: "treasury";
  recommendedSource: null;
  perInputStaleness: null;
}

export interface YieldRecommendation extends SelectorRecommendationBase {
  profile: "yield";
  /** Non-null for Yield profile entries (the rail the user is being pointed at). */
  recommendedSource: RecommendedSource;
  perInputStaleness: null;
}

export interface TradingRecommendation extends SelectorRecommendationBase {
  profile: "trading";
  recommendedSource: null;
  /** Trading-only: per-input data freshness in seconds. */
  perInputStaleness: Record<string, number>;
}

/**
 * Discriminated union by `profile`. Frontend rendering code switches on the
 * variant; engine emits the exact variant whose `recommendedSource` /
 * `perInputStaleness` slot is populated.
 */
export type SelectorRecommendation =
  | TreasuryRecommendation
  | YieldRecommendation
  | TradingRecommendation;

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

export const EXCLUSION_REASONS = [
  "below-supply-floor",
  "active-depeg",
  "safety-grade-floor",
  "safety-resilience-floor",
  "safety-dependency-risk-floor",
  "dews-ceiling",
  "depeg-event-count",
  "bluechip-d-or-f",
  "peg-stability-floor",
  "pys-null",
  "apy-below-floor",
  "yield-warning-unstable",
  "yield-warning-thin-tvl",
  "high-venue-on-c-tier",
  "liquidity-floor",
  "liquidity-diversification-floor",
  "effective-exit-floor",
  "supply-tvl-floor-1h",
  "lifecycle-non-active",
  "peg-currency-mismatch",
  "yield-native-only-violation",
  "decentralization-required-violation",
  "custody-onchain-only-violation",
  "howey-uncertain",
  "template-coverage-gap",
  "coverage-too-thin",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface ExclusionRecord {
  id: string;
  reason: ExclusionReason;
  severity: "info" | "soft" | "hard";
  detail?: string;
}

// ---------------------------------------------------------------------------
// Lower-ranked
// ---------------------------------------------------------------------------

export interface SelectorLowerRanked {
  id: string;
  symbol: string;
  name: string;
  slot: "A" | "B";
  /** Canonical key the editorial layer maps to prose. */
  reasonKey: string;
  failedComponent: string | null;
  hypotheticalScore: number | null;
}

// ---------------------------------------------------------------------------
// Coverage warnings
// ---------------------------------------------------------------------------

export interface SkippedCoin {
  id: string;
  symbol: string;
  missingSignals: string[];
}

export interface SelectorCoverageWarnings {
  skippedForCoverageCount: number;
  skippedForCoverage: SkippedCoin[];
  /** True when >25% of the universe was skipped for coverage. */
  sparse: boolean;
  /** True when 15–25% of the universe was skipped (and not sparse). */
  uneven: boolean;
  newListingCount: number;
  redistributionCount: number;
}

// ---------------------------------------------------------------------------
// Methodology versions
// ---------------------------------------------------------------------------

export interface MethodologyVersions {
  safetyScore: string;
  pegScoreAndDews: string;
  yieldIntelligence: string;
  bluechipAlignment: string;
  /** Equals `ENGINE_VERSION` ("selector-v1.0"). */
  exclusionFilters: string;
}

// ---------------------------------------------------------------------------
// Screener handoff
// ---------------------------------------------------------------------------

export interface ScreenerDivergenceWarning {
  /** Canonical exclusion reason or input key the Screener cannot express. */
  kind: "screener-cannot-express";
  reason: string;
  affectedIds: string[];
}

/**
 * Result of `selectorAnswersToScreenerFilters`. The engine returns a
 * `Partial<ScreenerFilters>` slice; the frontend composes it with the
 * Screener defaults to build the final URL. Divergence warnings surface
 * constraints the Screener cannot filter on (e.g. yield warning signals).
 */
export interface SelectorScreenerHandoff {
  filters: Record<string, unknown>;
  divergenceWarnings: ScreenerDivergenceWarning[];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface SelectorOutput {
  profile: SelectorProfile;
  input: SelectorInput;
  universe: { active: number; surviving: number };
  /** 0–3 entries, ranked highest fit first. */
  recommended: SelectorRecommendation[];
  /** 0–2 entries. */
  lowerRanked: SelectorLowerRanked[];
  coverageWarnings: SelectorCoverageWarnings;
  lowConfidence: boolean;
  /** Caller-provided `Date.now()` snapshot; threaded so the engine stays pure. */
  timestamp: number;
  engineVersion: string;
  methodologyVersions: MethodologyVersions;
  /** SHA-256 over content-only fields of the merged universe. */
  datasetHash: string;
  /**
   * Debug-only: full ranked survivor list, gated by `SELECTOR_DEBUG=true` at
   * build time. Tests read this; production output omits the field.
   * @internal
   */
  debug?: { allSurvivors: SelectorRecommendation[] };
}

// ---------------------------------------------------------------------------
// Engine-internal: merged row + data + dataset metadata
// ---------------------------------------------------------------------------

/**
 * @internal
 * Engine-internal merged row consumed by the scoring pipeline. Frontend
 * agents should NOT depend on this shape — it is exported only because
 * tests and the integration agent reference it directly.
 */
export interface MergedRow {
  id: string;
  symbol: string;
  name: string;
  protocolSlug: string | null;
  variantOf: string | null;
  isYieldBearing: boolean;
  pegCurrency: PegCurrency;
  lifecycle: "active" | "frozen" | "pre-launch";
  governance: "centralized" | "centralized-dependent" | "decentralized" | null;
  canBeBlacklisted: boolean | "possible" | "dilutable" | "inherited" | null;
  mechanismArchetype: string | null;

  supplyUsd: number;

  pegScore: number | null;
  pegStabilityScore: number | null;
  activeDepeg: boolean;
  currentDeviationBps: number | null;
  depegEventCount: number;
  lastEventAt: number | null;

  dewsScore: number | null;
  safetyGrade: ReportCardGrade | null;
  safetyScore: number | null;
  safetyResilienceScore: number | null;
  safetyDependencyRiskScore: number | null;
  safetyDecentralizationScore: number | null;
  safetyLiquidityScore: number | null;
  collateralQuality: number | null;
  custodyModel: string | null;
  bluechipGrade: BluechipGrade | null;

  liquidityScore: number | null;
  effectiveTvlUsd: number | null;
  concentrationHhi: number | null;
  chainTvl: Record<string, number>;
  effectiveExitScore: number | null;

  pharosYieldScore: number | null;
  apy30d: number | null;
  apyVariance30d: number | null;
  benchmarkRate: number | null;
  sourceRiskScore: number | null;
  venueRiskTier: "low" | "mid" | "high" | null;
  warningSignals: string[];
  deploymentPlace: "native-wrapper" | "issuer-savings" | "lp" | "lending" | null;
  sourceSwitch: boolean;
  yieldProtocolSlug: string | null;
  yieldVenueChain: string | null;
  yieldHistoryDays: number;
  yieldFreshness: { capturedAt: number; ageSeconds: number } | null;

  trackingSpanDays: number;
  isRecentListing: boolean;
  pegSummaryAgeSec: number | null;
  dexTvlAgeSec: number | null;
  dewsAgeSec: number | null;
}

/**
 * @internal
 * Engine input. The frontend assembles this map from its TanStack Query
 * caches before calling `runSelector`.
 */
export interface SelectorData {
  /** Per-coin merged signal map keyed by stablecoin id. */
  rows: ReadonlyMap<string, MergedRow>;
}

/**
 * @internal
 * Caller-supplied dataset metadata. `timestamp` is read once at the top of
 * `useSelector` so the engine stays pure; `datasetHash` is computed by the
 * caller (or upstream) and threaded through.
 */
export interface DatasetMetadata {
  timestamp: number;
  methodologyVersions: MethodologyVersions;
  datasetHash: string;
}
