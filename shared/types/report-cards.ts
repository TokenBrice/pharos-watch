import { z } from "zod";
import {
  BLUECHIP_GRADE_VALUES,
  BluechipGradeSchema,
  BridgeRouteRiskConfidenceSchema,
  BridgeRouteRiskSourceSchema,
  BridgeRouteRiskTierSchema,
  ChainTierSchema,
  CollateralQualitySchema,
  CustodyModelSchema,
  DependencyTypeSchema,
  DeploymentModelSchema,
  GovernanceQualitySchema,
  GovernanceTypeSchema,
  OracleRiskConfidenceSchema,
  OracleRiskTierSchema,
  VARIANT_KIND_VALUES,
} from "./core";
import type { BluechipGrade, CustodyModel } from "./core";
import { RedemptionModelConfidenceSchema, RedemptionRouteFamilySchema } from "./redemption";
import { DependencyWeightSchema, StablecoinLinkSchema } from "./stablecoin-meta-schemas";
import { DexExitEvidenceKindSchema, LiquidityCoverageClassSchema, LiquidityEvidenceClassSchema } from "./market";
import { SafetyScoreV8PublicationIdentitySchema } from "./safety-score-publication";

export type ReportCardGrade = BluechipGrade | "NR";
const REPORT_CARD_GRADE_VALUES = [...BLUECHIP_GRADE_VALUES, "NR"] as const;
export const ReportCardGradeSchema = z.enum(REPORT_CARD_GRADE_VALUES);

export type DimensionKey = "pegStability" | "liquidity" | "resilience" | "decentralization" | "dependencyRisk";

const SafetyScoreHistoryPointSchema = z.object({
  date: z.number(),
  grade: ReportCardGradeSchema,
  score: z.number().nullable(),
  prevGrade: ReportCardGradeSchema.nullable(),
  prevScore: z.number().nullable(),
  methodologyVersion: z.string(),
});
export type SafetyScoreHistoryPoint = z.infer<typeof SafetyScoreHistoryPointSchema>;

export const SafetyScoreHistoryResponseSchema = z.array(SafetyScoreHistoryPointSchema);
export type SafetyScoreHistoryResponse = z.infer<typeof SafetyScoreHistoryResponseSchema>;

const DependencyDimensionDiagnosticsSchema = z.object({
  rawTotalWeight: z.number().finite().nonnegative(),
  normalizedTotalWeight: z.number().finite().min(0).max(1),
  selfBackedFraction: z.number().finite().min(0).max(1),
  availableWeight: z.number().finite().nonnegative(),
  unavailableWeight: z.number().finite().nonnegative(),
  availableIds: z.array(z.string()),
  unavailableIds: z.array(z.string()),
  contributions: z.array(
    z.object({
      id: z.string(),
      type: DependencyTypeSchema,
      rawWeight: z.number().finite().positive(),
      normalizedWeight: z.number().finite().positive(),
      score: z.number().finite(),
      available: z.boolean(),
    }),
  ),
  weakPenalty: z.number().finite().nonpositive(),
  bindingCeiling: z
    .object({
      id: z.string(),
      type: z.enum(["wrapper", "mechanism"]),
      score: z.number().finite(),
    })
    .nullable(),
});

const ReportCardDimensionSchema = z.object({
  grade: ReportCardGradeSchema,
  score: z.number().nullable(),
  detail: z.string(),
  detailItems: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        detail: z.string().optional(),
      }),
    )
    .optional(),
  dependencyDiagnostics: DependencyDimensionDiagnosticsSchema.optional(),
});
export type ReportCardDimension = z.infer<typeof ReportCardDimensionSchema>;
export type ReportCardDetailItem = NonNullable<ReportCardDimension["detailItems"]>[number];

export { DependencyWeightSchema };

// Wire-compatible schema: accepts legacy "possible-inherited" and "dilutable"
// from old snapshots, mapping them into the current four-status model.
const ReportCardBlacklistStatusSchema = z.union([
  z.boolean(),
  z.literal("possible"),
  z.literal("inherited"),
  z.literal("dilutable").transform((): "possible" => "possible"),
  z.literal("possible-inherited").transform((): "inherited" => "inherited"),
]);

// Wire-compatible schema: accepts legacy "institutional" from old worker snapshots
// and maps it to "institutional-regulated". Remove once all D1 rows are refreshed.
const CustodyModelWireSchema = CustodyModelSchema.or(
  z.literal("institutional").transform((): CustodyModel => "institutional-regulated"),
);

const RawDimensionInputsSchema = z.object({
  pegScore: z.number().nullable(),
  activeDepeg: z.boolean(),
  activeDepegBps: z.number().nullable().optional().default(null),
  depegEventCount: z.number(),
  lastEventAt: z.number().nullable(),
  liquidityScore: z.number().nullable(),
  liquidityObservedScore: z.number().nullable().optional(),
  liquidityCoverageClass: LiquidityCoverageClassSchema.nullable().optional(),
  liquidityCoverageConfidence: z.number().min(0).max(1).nullable().optional(),
  liquidityEvidenceClass: LiquidityEvidenceClassSchema.nullable().optional(),
  liquidityExitEvidenceKind: DexExitEvidenceKindSchema.nullable().optional(),
  liquidityEvidenceCeiling: z.number().min(0).max(100).nullable().optional(),
  liquidityHasMeasuredEvidence: z.boolean().nullable().optional(),
  liquidityEffectiveTvlUsd: z.number().nonnegative().nullable().optional(),
  liquidityBalanceMeasuredTvlUsd: z.number().nonnegative().nullable().optional(),
  liquidityOrganicMeasuredTvlUsd: z.number().nonnegative().nullable().optional(),
  liquidityDeploymentCoverage: z
    .object({
      observedPools: z.number().int().nonnegative(),
      verifiedNoPools: z.number().int().nonnegative(),
      providerInaccessible: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
  effectiveExitScore: z.number().nullable(),
  redemptionBackstopScore: z.number().nullable(),
  redemptionRouteFamily: RedemptionRouteFamilySchema.nullable(),
  redemptionModelConfidence: RedemptionModelConfidenceSchema.nullable(),
  redemptionUsedForLiquidity: z.boolean(),
  redemptionImmediateCapacityUsd: z.number().nullable(),
  redemptionImmediateCapacityRatio: z.number().nullable(),
  concentrationHhi: z.number().nullable(),
  bluechipGrade: BluechipGradeSchema.nullable(),
  canBeBlacklisted: ReportCardBlacklistStatusSchema,
  chainTier: ChainTierSchema,
  deploymentModel: DeploymentModelSchema,
  collateralQuality: CollateralQualitySchema,
  custodyModel: CustodyModelWireSchema,
  governanceTier: GovernanceTypeSchema,
  governanceQuality: GovernanceQualitySchema,
  /** Mint Authority Score input to the v8 decentralization blend; absent on pre-v8 cached snapshots. */
  mintAuthorityScore: z.number().nullable().optional(),
  /** Oracle setup tier used by the branch-aware CDP-only v8.11 decentralization blend; absent on pre-v8.1 cached snapshots. */
  oracleRiskTier: OracleRiskTierSchema.nullable().optional(),
  /** Oracle setup score used by the branch-aware CDP-only v8.11 decentralization blend; absent on pre-v8.1 cached snapshots. */
  oracleRiskScore: z.number().nullable().optional(),
  /** Reviewed bridge-route tier used by the v8.12 decentralization blend; absent on pre-v8.12 cached snapshots. */
  bridgeRouteRiskTier: BridgeRouteRiskTierSchema.nullable().optional(),
  /** Reviewed bridge-route score used by the v8.12 decentralization blend; absent on pre-v8.12 cached snapshots. */
  bridgeRouteRiskScore: z.number().nullable().optional(),
  /** P7 route/materiality diagnostics; v8 scoring continues to use bridgeRouteRiskTier until a versioned activation. */
  bridgeRouteEffectiveTier: BridgeRouteRiskTierSchema.nullable().optional(),
  bridgeRouteMaterialityStatus: z.enum(["complete", "partial", "unavailable", "not-applicable"]).optional(),
  bridgeRouteMatchedSupplyRatio: z.number().min(0).max(1).nullable().optional(),
  bridgeRouteUnknownSupplyRatio: z.number().min(0).max(1).nullable().optional(),
  bridgeRouteSelectedRouteId: z.string().nullable().optional(),
  bridgeRouteUnknownChains: z.array(z.string()).optional(),
  dependencies: z.array(DependencyWeightSchema),
  variantParentId: z.string().nullable().optional(),
  variantKind: z.enum(VARIANT_KIND_VALUES).nullable().optional(),
  navToken: z.boolean(),
  collateralFromLive: z.boolean().optional().default(false),
  dependencyFromLive: z.boolean().optional().default(false),
  dependencySource: z
    .enum(["live-reserve", "live-unmapped", "curated-reserve", "manual", "none", "variant"])
    .optional(),
  dependencyBaseSource: z.enum(["live-reserve", "live-unmapped", "curated-reserve", "manual", "none"]).optional(),
  mappedLiveReserveWeight: z.number().finite().nonnegative().nullable().optional(),
  dependencyFallbackReason: z
    .enum(["live-unmapped-to-curated-reserve", "live-unmapped-to-manual", "live-cycle-to-curated"])
    .nullable()
    .optional(),
  dependencySnapshotSource: z.string().nullable().optional(),
  dependencySnapshotUpdatedAt: z.number().finite().nonnegative().nullable().optional(),
});

export type RawDimensionInputs = z.infer<typeof RawDimensionInputsSchema>;

const ReportCardOracleRiskBranchSchema = z.object({
  id: z.string(),
  label: z.string(),
  tier: OracleRiskTierSchema,
  score: z.number(),
  summary: z.string(),
  collateralAssets: z.array(z.string()).optional(),
  chains: z.array(z.string()).optional(),
  feeds: z
    .array(
      z.object({
        provider: z.string(),
        path: z.string(),
        address: z.string().optional(),
        chain: z.string(),
        heartbeatSec: z.number().optional(),
        stalenessBoundSec: z.number().optional(),
      }),
    )
    .optional(),
  fallbackBehavior: z.string().optional(),
  observedAt: z.string().optional(),
  observedBlock: z.number().optional(),
  collateralParameters: z
    .array(
      z.object({
        asset: z.string(),
        maximumLtvPct: z.number().optional(),
        minimumCollateralRatioPct: z.number().optional(),
        shutdownCollateralRatioPct: z.number().optional(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  liquidationMechanism: z.string().optional(),
  liquidationDelaySec: z.number().optional(),
  backstop: z.string().optional(),
  shutdownOrBadDebtBehavior: z.string().optional(),
  sources: z.array(StablecoinLinkSchema).optional(),
});

const ReportCardOracleRiskSchema = z.object({
  tier: OracleRiskTierSchema,
  score: z.number(),
  label: z.string(),
  summary: z.string(),
  reviewedAt: z.string().optional(),
  reviewer: z.string().optional(),
  confidence: OracleRiskConfidenceSchema.optional(),
  sources: z.array(StablecoinLinkSchema).optional(),
  inheritedFrom: z
    .object({
      id: z.string(),
      name: z.string(),
      symbol: z.string(),
    })
    .nullable()
    .optional(),
  selectedBranch: ReportCardOracleRiskBranchSchema.nullable().optional(),
  branches: z.array(ReportCardOracleRiskBranchSchema).optional(),
});

const ReportCardBridgeRouteProtocolSchema = z.object({
  source: BridgeRouteRiskSourceSchema,
  name: z.string(),
  slug: z.string().optional(),
  url: z.string().optional(),
  bridgeTypes: z.array(z.string()).optional(),
  note: z.string().optional(),
});

const ReportCardBridgeRouteRiskSchema = z.object({
  tier: BridgeRouteRiskTierSchema,
  score: z.number(),
  label: z.string(),
  summary: z.string(),
  reviewedAt: z.string(),
  reviewer: z.string(),
  confidence: BridgeRouteRiskConfidenceSchema,
  protocols: z.array(ReportCardBridgeRouteProtocolSchema).optional(),
  sources: z.array(StablecoinLinkSchema).optional(),
  materiality: z
    .object({
      status: z.enum(["complete", "partial", "unavailable", "not-applicable"]),
      effectiveTier: BridgeRouteRiskTierSchema.nullable(),
      selectedRouteId: z.string().nullable(),
      matchedSupplyRatio: z.number().min(0).max(1),
      unknownSupplyRatio: z.number().min(0).max(1),
      unknownChains: z.array(z.string()),
      reason: z.string(),
    })
    .optional(),
});

export type ReportCardOracleRiskBranch = z.infer<typeof ReportCardOracleRiskBranchSchema>;

export type ReportCardOracleRisk = z.infer<typeof ReportCardOracleRiskSchema>;

export type ReportCardBridgeRouteRisk = z.infer<typeof ReportCardBridgeRouteRiskSchema>;

export const ReportCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  overallGrade: ReportCardGradeSchema,
  overallScore: z.number().nullable(),
  baseScore: z.number().nullable(),
  overallCapped: z.boolean().optional(),
  uncappedOverallScore: z.number().nullable().optional(),
  dimensions: z.object({
    pegStability: ReportCardDimensionSchema,
    liquidity: ReportCardDimensionSchema,
    resilience: ReportCardDimensionSchema,
    decentralization: ReportCardDimensionSchema,
    dependencyRisk: ReportCardDimensionSchema,
  }),
  ratedDimensions: z.number(),
  rawInputs: RawDimensionInputsSchema,
  oracleRisk: ReportCardOracleRiskSchema.nullable().optional(),
  bridgeRouteRisk: ReportCardBridgeRouteRiskSchema.nullable().optional(),
  isDefunct: z.boolean(),
});

export type ReportCard = z.infer<typeof ReportCardSchema>;

const ReportCardsMethodologySchema = z.object({
  version: z.string(),
  weights: z.object({
    pegStability: z.number(),
    liquidity: z.number(),
    resilience: z.number(),
    decentralization: z.number(),
    dependencyRisk: z.number(),
  }),
  pegMultiplierExponent: z.number(),
  activeDepegSeveritySource: z.string().optional(),
  activeDepegCaps: z
    .object({
      d: z.object({ thresholdBps: z.number(), score: z.number() }),
      f: z.object({ thresholdBps: z.number(), score: z.number() }),
    })
    .optional(),
  thresholds: z.array(z.object({ grade: ReportCardGradeSchema, min: z.number() })),
});

const ReportCardsDependencyGraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  weight: z.number(),
  type: DependencyTypeSchema,
});

const ReportCardsDependencyGraphSchema = z.object({
  edges: z.array(ReportCardsDependencyGraphEdgeSchema),
});

const ReportCardsFreshnessEntrySchema = z.object({
  updatedAt: z.number().nullable(),
  ageSeconds: z.number().nullable(),
  stale: z.boolean(),
});

const CollateralDriftEntrySchema = z.object({
  id: z.string(),
  liveScore: z.number(),
  curatedScore: z.number(),
  delta: z.number(),
});

export const ReportCardsResponseSchema = z.object({
  safetyScoreIdentity: SafetyScoreV8PublicationIdentitySchema.optional(),
  cards: z.array(ReportCardSchema),
  methodology: ReportCardsMethodologySchema,
  dependencyGraph: ReportCardsDependencyGraphSchema,
  updatedAt: z.number(),
  liquidityStale: z.boolean().optional(),
  redemptionStale: z.boolean().optional(),
  inputFreshness: z
    .object({
      dexLiquidity: ReportCardsFreshnessEntrySchema,
      redemptionBackstops: ReportCardsFreshnessEntrySchema,
    })
    .optional(),
  collateralDriftCoins: z.array(CollateralDriftEntrySchema).optional(),
  liveToFallbackCoins: z.array(z.string()).optional(),
  publication: z
    .object({
      generationId: z.string(),
      methodologyVersion: z.string(),
      expectedCount: z.number().int().nonnegative(),
      scoredCount: z.number().int().nonnegative(),
      notRatedCount: z.number().int().nonnegative(),
      notRatedIds: z.array(z.string()),
    })
    .optional(),
});

export type ReportCardsResponse = z.infer<typeof ReportCardsResponseSchema>;
