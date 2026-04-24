import { z } from "zod";
import {
  BluechipGrade,
  BluechipGradeSchema,
  ChainTier,
  ChainTierSchema,
  CollateralQuality,
  CollateralQualitySchema,
  CustodyModel,
  CustodyModelSchema,
  DependencyTypeSchema,
  DependencyWeight,
  DeploymentModel,
  DeploymentModelSchema,
  GovernanceQuality,
  GovernanceQualitySchema,
  GovernanceType,
  GovernanceTypeSchema,
  VariantKind,
  VARIANT_KIND_VALUES,
} from "./core";
import {
  RedemptionModelConfidenceSchema,
  RedemptionRouteFamilySchema,
} from "./redemption";
import { DependencyWeightSchema } from "./stablecoin-meta-schemas";

export type ReportCardGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F" | "NR";
const REPORT_CARD_GRADE_VALUES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F", "NR"] as const;
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

const ReportCardDimensionSchema = z.object({
  grade: ReportCardGradeSchema,
  score: z.number().nullable(),
  detail: z.string(),
});
export type ReportCardDimension = z.infer<typeof ReportCardDimensionSchema>;

export { DependencyWeightSchema };

// Wire-compatible schema: accepts legacy "possible-inherited" from old snapshots
// and maps it to the clearer "inherited" label.
const ReportCardBlacklistStatusSchema = z.union([
  z.boolean(),
  z.literal("possible"),
  z.literal("inherited"),
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
  dependencies: z.array(DependencyWeightSchema),
  variantParentId: z.string().nullable().optional(),
  variantKind: z.enum(VARIANT_KIND_VALUES).nullable().optional(),
  navToken: z.boolean(),
  collateralFromLive: z.boolean().optional().default(false),
  dependencyFromLive: z.boolean().optional(),
});

export interface RawDimensionInputs extends z.infer<typeof RawDimensionInputsSchema> {
  bluechipGrade: BluechipGrade | null;
  chainTier: ChainTier;
  deploymentModel: DeploymentModel;
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
  governanceTier: GovernanceType;
  governanceQuality: GovernanceQuality;
  dependencies: DependencyWeight[];
  variantParentId?: string | null;
  variantKind?: VariantKind | null;
}

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
  isDefunct: z.boolean(),
});

export interface ReportCard extends z.infer<typeof ReportCardSchema> {
  overallGrade: ReportCardGrade;
  overallCapped?: boolean;
  uncappedOverallScore?: number | null;
  dimensions: Record<DimensionKey, ReportCardDimension>;
  rawInputs: RawDimensionInputs;
}

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
  activeDepegCaps: z.object({
    d: z.object({ thresholdBps: z.number(), score: z.number() }),
    f: z.object({ thresholdBps: z.number(), score: z.number() }),
  }).optional(),
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
  cards: z.array(ReportCardSchema),
  methodology: ReportCardsMethodologySchema,
  dependencyGraph: ReportCardsDependencyGraphSchema,
  updatedAt: z.number(),
  liquidityStale: z.boolean().optional(),
  redemptionStale: z.boolean().optional(),
  inputFreshness: z.object({
    dexLiquidity: ReportCardsFreshnessEntrySchema,
    redemptionBackstops: ReportCardsFreshnessEntrySchema,
  }).optional(),
  collateralDriftCoins: z.array(CollateralDriftEntrySchema).optional(),
  liveToFallbackCoins: z.array(z.string()).optional(),
});

export interface ReportCardsResponse extends z.infer<typeof ReportCardsResponseSchema> {
  cards: ReportCard[];
  methodology: {
    version: string;
    weights: Record<DimensionKey, number>;
    pegMultiplierExponent: number;
    activeDepegSeveritySource?: string;
    activeDepegCaps?: {
      d: { thresholdBps: number; score: number };
      f: { thresholdBps: number; score: number };
    };
    thresholds: { grade: ReportCardGrade; min: number }[];
  };
}
