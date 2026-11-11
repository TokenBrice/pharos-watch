import {
  SELECTOR_PROFILES,
  SELECTOR_ELIGIBLE_PEG_CURRENCIES,
  HORIZON_VALUES,
  DEPEG_TOLERANCE_VALUES,
  COMPOSABILITY_VALUES,
  EXIT_SPEED_VALUES,
  DECENTRALIZATION_VALUES,
  CUSTODY_OK_VALUES,
  TREASURY_VENUE_VALUES,
  YIELD_VENUE_VALUES,
  TRADING_VENUE_VALUES,
  WEIGHT_KEYS,
  LOWEST_SUB_DIMENSION_KEYS,
  CONTEXT_KEYS,
  WHY_KEYS,
  BASE_CONFIDENCE_REASON_KEYS,
  EXCLUSION_REASONS,
  SelectorCanonicalSourceEvidenceSchema,
} from "./vocabulary";
export {
  SELECTOR_PROFILES,
  SELECTOR_ELIGIBLE_PEG_CURRENCIES,
  isSelectorEligiblePegCurrency,
  HORIZON_VALUES,
  DEPEG_TOLERANCE_VALUES,
  COMPOSABILITY_VALUES,
  EXIT_SPEED_VALUES,
  DECENTRALIZATION_VALUES,
  CUSTODY_OK_VALUES,
  TREASURY_VENUE_VALUES,
  YIELD_VENUE_VALUES,
  TRADING_VENUE_VALUES,
  WEIGHT_KEYS,
  LOWEST_SUB_DIMENSION_KEYS,
  CONTEXT_KEYS,
  WHY_KEYS,
  BASE_CONFIDENCE_REASON_KEYS,
  EXCLUSION_REASONS,
  SELECTOR_SNAPSHOT_VERIFICATION_KIND,
  SelectorCanonicalSourceEvidenceSchema,
} from "./vocabulary";
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
} from "./snapshot-schemas";
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

export type SelectorProfile = (typeof SELECTOR_PROFILES)[number];

// Initial non-USD rollout: pegs with enough active rows and live signal
// coverage to avoid empty selector routes. BRL remains gated until the
// peggedREAL alias path is audited.

export type SelectorEligiblePegCurrency =
  (typeof SELECTOR_ELIGIBLE_PEG_CURRENCIES)[number];

export type SelectorHorizon = (typeof HORIZON_VALUES)[number];

export type SelectorDepegTolerance = (typeof DEPEG_TOLERANCE_VALUES)[number];

export type SelectorComposability = (typeof COMPOSABILITY_VALUES)[number];

export type SelectorExitSpeed = (typeof EXIT_SPEED_VALUES)[number];

export type SelectorDecentralization = (typeof DECENTRALIZATION_VALUES)[number];

export type SelectorCustodyOk = (typeof CUSTODY_OK_VALUES)[number];

export type SelectorTreasuryVenue = (typeof TREASURY_VENUE_VALUES)[number];

export type SelectorYieldVenue = (typeof YIELD_VENUE_VALUES)[number];

export type SelectorTradingVenue = (typeof TRADING_VENUE_VALUES)[number];

export type SelectorVenuePreference =
  | SelectorTreasuryVenue
  | SelectorYieldVenue
  | SelectorTradingVenue;

export type SelectorInput = z.output<typeof SelectorInputSchema>;

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

/**
 * Every "what to watch" axis the engine has ever emitted. Retired axes stay
 * listed for the same stored-snapshot reason as `WEIGHT_KEYS`; the live
 * candidate sets are in `lowest-sub-dimension.ts`.
 */

export type LowestSubDimensionKey = (typeof LOWEST_SUB_DIMENSION_KEYS)[number];

export type ContextKey = (typeof CONTEXT_KEYS)[number];

export type LowestSubDimension = z.output<typeof LowestSubDimensionSchema>;

export type WhyKey = (typeof WHY_KEYS)[number];

export type RecommendedSource = z.output<typeof RecommendedSourceSchema>;
export type SelectorChainHints = z.output<typeof SelectorChainHintsSchema>;
export type SelectorRankRobustness = z.output<typeof SelectorRankRobustnessSchema>;
export type SelectorRankRobustnessLabel = SelectorRankRobustness["label"];

export type BaseConfidenceReasonKey = (typeof BASE_CONFIDENCE_REASON_KEYS)[number];
export type MissingCriticalConfidenceReason = `missing-critical-${WeightKey}`;
export type SelectorConfidenceReason = z.output<typeof SelectorConfidenceReasonSchema>;
export type TreasuryRecommendation = z.output<typeof TreasuryRecommendationSchema>;
export type YieldRecommendation = z.output<typeof YieldRecommendationSchema>;
export type TradingRecommendation = z.output<typeof TradingRecommendationSchema>;
export type SelectorRecommendation = z.output<typeof SelectorRecommendationSchema>;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface ExclusionRecord {
  id: string;
  reason: ExclusionReason;
  severity: "info" | "soft" | "hard";
  detail?: string;
}

export type SelectorLowerRanked = z.output<typeof SelectorLowerRankedSchema>;

export type SkippedCoin = z.output<typeof SkippedCoinSchema>;
export type SelectorCoverageWarnings = z.output<typeof SelectorCoverageWarningsSchema>;

export type MethodologyVersions = z.output<typeof MethodologyVersionsSchema>;

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

export type SelectorExclusionSummaryItem = z.output<typeof SelectorExclusionSummaryItemSchema>;
export type SelectorClosestSurvivor = z.output<typeof SelectorClosestSurvivorSchema>;
export type SelectorRelaxableConstraint = z.output<typeof SelectorRelaxableConstraintSchema>;

export type SelectorCanonicalSourceEvidence = z.output<typeof SelectorCanonicalSourceEvidenceSchema>;

export type SelectorSnapshotVerification = z.output<typeof SelectorSnapshotVerificationSchema>;

export type SelectorOutput = z.output<typeof SelectorOutputSchema>;

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
