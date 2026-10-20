/**
 * Stablecoin Picker — type vocabulary.
 *
 * Single source of truth for selector enums and shapes. Every enumerable
 * string vocabulary is declared once as an `as const` tuple; types are
 * derived via `(typeof X_VALUES)[number]` so adding a value is a one-file
 * change and cross-profile typos surface at compile time.
 *
 * Binding: see `docs/screener-page.md#input-and-engine-contract` for the maintained type contract.
 */
import { z } from "zod";
import { ApiMetaEnvelopeSchema } from "@pharos/contracts/api-meta";
import type {
  SelectorInputSchema,
  SelectorComponentSchema,
  LowestSubDimensionSchema,
  RecommendedSourceSchema,
  SelectorChainHintsSchema,
  SelectorRankRobustnessSchema,
  SelectorConfidenceReasonSchema,
  TreasuryRecommendationSchema,
  YieldRecommendationSchema,
  TradingRecommendationSchema,
  SelectorRecommendationSchema,
  SelectorLowerRankedSchema,
  SkippedCoinSchema,
  SelectorCoverageWarningsSchema,
  MethodologyVersionsSchema,
  SelectorExclusionSummaryItemSchema,
  SelectorClosestSurvivorSchema,
  SelectorRelaxableConstraintSchema,
  SelectorSnapshotVerificationSchema,
  SelectorOutputSchema,
} from "./snapshot";
import type {
  BluechipGrade,
  CustodyModel,
  GovernanceType,
  PegCurrency,
  ReportCardGrade,
  SafetyScoreV9Cap,
  V9EvidenceLevel,
  V9QualityPillar,
  YieldType,
} from "../../types";

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

export type SelectorInput = z.output<typeof SelectorInputSchema>;

// ---------------------------------------------------------------------------
// Scoring vocabulary
// ---------------------------------------------------------------------------

/**
 * Every weight slot the engine has ever emitted.
 *
 * Retired slots stay listed: signed snapshots are retained for five years and
 * are shape-validated against this vocabulary on read, so dropping a name here
 * would make historical snapshots unreadable. What a *current* run emits is
 * decided by `WEIGHT_VECTORS`, which since `selector-v2.0` no longer contains
 * `resilience`, `dependencyRisk`, `decentralization`, or `effectiveExit` —
 * those are V9 pillars (or, for `dependencyRisk`, a Selector-side
 * re-derivation of V9's graph) already priced inside `safetyOverall`.
 */
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

export type SelectorComponent = z.output<typeof SelectorComponentSchema>;

// ---------------------------------------------------------------------------
// Lowest sub-dimension
// ---------------------------------------------------------------------------

/**
 * Every "what to watch" axis the engine has ever emitted. Retired axes stay
 * listed for the same stored-snapshot reason as `WEIGHT_KEYS`; the live
 * candidate sets are in `lowest-sub-dimension.ts`.
 */
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

export type LowestSubDimension = z.output<typeof LowestSubDimensionSchema>;

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

export type RecommendedSource = z.output<typeof RecommendedSourceSchema>;
export type SelectorChainHints = z.output<typeof SelectorChainHintsSchema>;
export type SelectorRankRobustness = z.output<typeof SelectorRankRobustnessSchema>;
export type SelectorRankRobustnessLabel = SelectorRankRobustness["label"];

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
export type BaseConfidenceReasonKey = (typeof BASE_CONFIDENCE_REASON_KEYS)[number];
export type MissingCriticalConfidenceReason = `missing-critical-${WeightKey}`;
export type SelectorConfidenceReason = z.output<typeof SelectorConfidenceReasonSchema>;
export type TreasuryRecommendation = z.output<typeof TreasuryRecommendationSchema>;
export type YieldRecommendation = z.output<typeof YieldRecommendationSchema>;
export type TradingRecommendation = z.output<typeof TradingRecommendationSchema>;
export type SelectorRecommendation = z.output<typeof SelectorRecommendationSchema>;

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

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

export type SelectorLowerRanked = z.output<typeof SelectorLowerRankedSchema>;

// ---------------------------------------------------------------------------
// Coverage warnings
// ---------------------------------------------------------------------------

export type SkippedCoin = z.output<typeof SkippedCoinSchema>;
export type SelectorCoverageWarnings = z.output<typeof SelectorCoverageWarningsSchema>;

// ---------------------------------------------------------------------------
// Methodology versions
// ---------------------------------------------------------------------------

export type MethodologyVersions = z.output<typeof MethodologyVersionsSchema>;

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
  filters: SelectorScreenerFilterProjection;
  divergenceWarnings: ScreenerDivergenceWarning[];
}

/** Shared-side mirror of the Screener URL fields the Picker is allowed to emit. */
export interface SelectorScreenerFilterProjection {
  coins?: readonly string[];
  dewsMax?: number;
  supplyMin?: number;
  safetyGrades?: readonly ReportCardGrade[];
  safetyBackingMin?: number;
  safetyExitMin?: number;
  pegScoreMin?: number;
  liquidityScoreMin?: number;
  custodyModels?: readonly CustodyModel[];
  types?: readonly GovernanceType[];
  pegs?: readonly SelectorEligiblePegCurrency[];
  lifecycle?: readonly ["active"];
  blacklistable?: readonly ("no" | "possible")[];
}

// ---------------------------------------------------------------------------
// Engine-owned empty-state diagnostics
// ---------------------------------------------------------------------------

export type SelectorExclusionSummaryItem = z.output<typeof SelectorExclusionSummaryItemSchema>;
export type SelectorClosestSurvivor = z.output<typeof SelectorClosestSurvivorSchema>;
export type SelectorRelaxableConstraint = z.output<typeof SelectorRelaxableConstraintSchema>;
export const SELECTOR_SNAPSHOT_VERIFICATION_KIND = "pharos-server-recomputed-v1" as const;

export const SelectorCanonicalSourceEvidenceSchema = z.object({
  source: z.literal("stablecoins"),
  /** Producer-owned source clock, verdict and named budgets; null means unknown. */
  freshness: ApiMetaEnvelopeSchema.nullable(),
}).strict();
export type SelectorCanonicalSourceEvidence = z.output<typeof SelectorCanonicalSourceEvidenceSchema>;

export type SelectorSnapshotVerification = z.output<typeof SelectorSnapshotVerificationSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type SelectorOutput = z.output<typeof SelectorOutputSchema>;

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
  governance: "centralized" | "centralized-dependent" | "decentralized" | null;
  canBeBlacklisted: boolean | "possible" | "inherited" | null;
  mechanismArchetype: string | null;

  /** `null` when the run had no usable current-supply reading for the coin — never a stand-in zero. */
  supplyUsd: number | null;

  /** Peg domain's published PegScore. Every peg weight slot reads this one field. */
  pegScore: number | null;
  activeDepeg: boolean;
  currentDeviationBps: number | null;
  depegEventCount: number;
  lastEventAt: number | null;

  dewsScore: number | null;
  safetyGrade: ReportCardGrade | null;
  safetyScore: number | null;
  /**
   * Where `safetyScore` / `safetyGrade` came from. Structured-tranche rows are
   * graded by the yield model, not by Safety Score V9, and that substitution
   * must never reach a shortlist card unlabelled.
   */
  safetyProvenance: "safety-score-v9" | "yield-opportunity";
  /** Public V9 evidence context; absent on frozen historical fixtures. */
  safetyEvidenceLevel?: V9EvidenceLevel | null;
  safetyWeakestPillar?: { pillar: V9QualityPillar; score: number } | null;
  safetyBindingCap?: SafetyScoreV9Cap | null;
  safetyNrReasons?: readonly string[];
  /**
   * Published V9 pillars. They are read by exclusion gates, why-keys, and the
   * "what to watch" axis — surfaces that re-bin a published output — and are
   * deliberately absent from the weight vectors, which already carry the
   * composite these roll up into.
   */
  safetyResilienceScore: number | null;
  safetyDecentralizationScore: number | null;
  safetyLiquidityScore: number | null;
  custodyModel: string | null;
  bluechipGrade: BluechipGrade | null;

  liquidityScore: number | null;
  effectiveTvlUsd: number | null;
  concentrationHhi: number | null;
  chainTvl: Record<string, number>;

  pharosYieldScore: number | null;
  apy30d: number | null;
  apyVariance30d: number | null;
  benchmarkRate: number | null;
  sourceRiskScore: number | null;
  venueRiskTier: "low" | "mid" | "high" | null;
  /** Null when the selected alternate publishes no warning evidence. */
  warningSignals: string[] | null;
  deploymentPlace: "native-wrapper" | "issuer-savings" | "lp" | "lending" | null;
  sourceSwitch: boolean;
  yieldProtocolSlug: string | null;
  yieldVenueChain: string | null;
  /** Distinct UTC observation days represented in the trailing 30-day window. */
  yieldObservationDays30d: number | null;
  yieldFreshness: { capturedAt: number; ageSeconds: number } | null;
  /** Selected venue depth, kept separate from coin-level DEX liquidity. */
  yieldSourceTvlUsd?: number | null;
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
