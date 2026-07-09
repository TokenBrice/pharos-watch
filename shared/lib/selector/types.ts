/**
 * Stablecoin Picker — type vocabulary.
 *
 * Single source of truth for selector enums and shapes. Every enumerable
 * string vocabulary is declared once as an `as const` tuple; types are
 * derived via `(typeof X_VALUES)[number]` so adding a value is a one-file
 * change and cross-profile typos surface at compile time.
 *
 * Binding: see `docs/screener-picker-page.md` for the maintained type contract.
 */
import type { BluechipGrade, PegCurrency, ReportCardGrade, YieldType } from "../../types";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const SELECTOR_PROFILES = ["treasury", "yield", "trading"] as const;
export type SelectorProfile = (typeof SELECTOR_PROFILES)[number];

// Initial non-USD rollout: pegs with enough active rows and live signal
// coverage to avoid empty selector routes. BRL remains gated until the
// peggedREAL alias path is audited.
export const SELECTOR_ELIGIBLE_PEG_CURRENCIES = [
  "USD",
  "EUR",
  "CHF",
  "GOLD",
] as const satisfies readonly PegCurrency[];
export type SelectorEligiblePegCurrency =
  (typeof SELECTOR_ELIGIBLE_PEG_CURRENCIES)[number];

const SELECTOR_ELIGIBLE_PEG_SET = new Set<string>(SELECTOR_ELIGIBLE_PEG_CURRENCIES);

export function isSelectorEligiblePegCurrency(
  value: string | null | undefined,
): value is SelectorEligiblePegCurrency {
  return value != null && SELECTOR_ELIGIBLE_PEG_SET.has(value);
}

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

export const TREASURY_VENUE_VALUES = ["custody", "some", "active"] as const;
export type SelectorTreasuryVenue = (typeof TREASURY_VENUE_VALUES)[number];

export const YIELD_VENUE_VALUES = ["lend", "dex", "wrap", "all"] as const;
export type SelectorYieldVenue = (typeof YIELD_VENUE_VALUES)[number];

export const TRADING_VENUE_VALUES = ["cex", "perps", "spot", "all"] as const;
export type SelectorTradingVenue = (typeof TRADING_VENUE_VALUES)[number];

export type SelectorVenuePreference =
  | SelectorTreasuryVenue
  | SelectorYieldVenue
  | SelectorTradingVenue;

export interface SelectorInput {
  profile: SelectorProfile;
  pegCurrency: SelectorEligiblePegCurrency;
  horizon: SelectorHorizon;
  depegTolerance: SelectorDepegTolerance;
  composability: SelectorComposability;
  exitSpeed: SelectorExitSpeed;
  /**
   * Raw venue answers from the wizard. `composability` remains the broad
   * scoring bucket; this preserves the user's specific rail preference for
   * yield-source selection and audit output. Optional for legacy snapshots.
   */
  venuePreferences?: readonly SelectorVenuePreference[];
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
  sourceKey?: string | null;
  protocol: string;
  chain: string;
  yieldType?: YieldType | null;
  apy30d: number;
  pharosYieldScore: number | null;
  sourceTvlUsd?: number | null;
  sourceRiskTier: "low" | "mid" | "high";
  freshness: { capturedAt: number; ageSeconds: number };
  selectionReason?: string | null;
}

export interface SelectorChainHints {
  topByLiquidity: string[];
  topByYield: string[];
  primary: string | null;
}

export type SelectorRankRobustnessLabel =
  | "clear-margin"
  | "crowded-field"
  | "narrow-margin"
  | "concentration-adjusted";

export interface SelectorRankRobustness {
  label: SelectorRankRobustnessLabel;
  scoreMargin: number | null;
}

export const BASE_CONFIDENCE_REASON_KEYS = [
  "recent-listing",
  "yield-source-switched",
  "short-yield-history",
  "treasury-depeg-history",
  "redistributed-missing-data",
  "source-risk-missing",
  "relaxed-fallback",
  "narrow-margin",
] as const;
export type BaseConfidenceReasonKey = (typeof BASE_CONFIDENCE_REASON_KEYS)[number];
export type MissingCriticalConfidenceReason = `missing-critical-${WeightKey}`;
export type SelectorConfidenceReason =
  | BaseConfidenceReasonKey
  | MissingCriticalConfidenceReason;

interface SelectorRecommendationBase {
  id: string;
  symbol: string;
  name: string;
  rank: 1 | 2 | 3;
  score: number;
  confidence: number;
  confidenceReasons?: SelectorConfidenceReason[];
  components: SelectorComponent[];
  whyKeys: WhyKey[];
  /** Authored, data-anchored prose for visible result cards. */
  whyText?: string;
  /** Authored "what to watch" prose derived from the lowest sub-dimension. */
  watchText?: string;
  lowestSubDimension: LowestSubDimension;
  chainHints: SelectorChainHints;
  rankRobustness?: SelectorRankRobustness;
  relaxedReason?: ExclusionReason | null;
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
  "bluechip-d-or-f",
  "peg-score-floor",
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
  "custody-regulated-only-violation",
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
  /** Authored visible headline that avoids exposing `reasonKey`. */
  verdictText?: string;
  /** Authored teaching line keyed by `reasonKey` / `failedComponent`. */
  teachingText?: string;
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
  /** Equals `ENGINE_VERSION`. */
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
// Engine-owned empty-state diagnostics
// ---------------------------------------------------------------------------

export interface SelectorExclusionSummaryItem {
  reason: ExclusionReason;
  count: number;
  severity: ExclusionRecord["severity"];
  sampleIds: string[];
}

export interface SelectorClosestSurvivor {
  id: string;
  symbol: string;
  failingDimension: string;
  liveReading: string;
  reason: ExclusionReason;
  hypotheticalScore: number | null;
}

export interface SelectorRelaxableConstraint {
  key: "depegTolerance" | "venue" | "exitSpeed";
  label: string;
  description: string;
  reason: ExclusionReason | "input-strictness";
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
  usedRelaxedFallback: boolean;
  relaxedReasons: ExclusionReason[];
  exclusionSummary: SelectorExclusionSummaryItem[];
  closestSurvivors: SelectorClosestSurvivor[];
  relaxableConstraints: SelectorRelaxableConstraint[];
  /** Caller-provided `Date.now()` snapshot; threaded so the engine stays pure. */
  timestamp: number;
  engineVersion: string;
  methodologyVersions: MethodologyVersions;
  /** Stable content hash over content-only fields of the merged universe. */
  datasetHash: string;
  /** Added by the snapshot boundary; live engine output is not server-attested. */
  provenance?: "client-unverified";
  /** Exact persisted projection version added by the snapshot boundary. */
  snapshotSchemaVersion?: 2;
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
  canBeBlacklisted: boolean | "possible" | "inherited" | null;
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
  yieldSources?: readonly YieldSourceCandidate[];

  trackingSpanDays: number;
  isRecentListing: boolean;
  pegSummaryAgeSec: number | null;
  dexTvlAgeSec: number | null;
  dewsAgeSec: number | null;
}

export interface YieldSourceCandidate {
  sourceKey: string;
  protocol: string;
  chain: string | null;
  yieldType: YieldType | null;
  apy30d: number;
  pharosYieldScore: number | null;
  sourceTvlUsd: number | null;
  dataSource: string | null;
  sourceRiskScore: number | null;
  venueRiskTier: "low" | "mid" | "high" | null;
  deploymentPlace: MergedRow["deploymentPlace"];
  sourceDepthRatio: number | null;
  sourceSwitchCount30d: number | null;
  observationCount30d: number | null;
  freshness: { capturedAt: number; ageSeconds: number } | null;
  isPrimary: boolean;
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
