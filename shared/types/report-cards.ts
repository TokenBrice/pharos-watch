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
} from "./core";

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

const DependencyWeightSchema = z.object({
  id: z.string(),
  weight: z.number(),
  type: DependencyTypeSchema.optional(),
});

const RawDimensionInputsSchema = z.object({
  pegScore: z.number().nullable(),
  activeDepeg: z.boolean(),
  depegEventCount: z.number(),
  lastEventAt: z.number().nullable(),
  liquidityScore: z.number().nullable(),
  concentrationHhi: z.number().nullable(),
  bluechipGrade: BluechipGradeSchema.nullable(),
  canBeBlacklisted: z.union([z.boolean(), z.literal("possible"), z.literal("possible-inherited")]),
  chainTier: ChainTierSchema,
  deploymentModel: DeploymentModelSchema,
  collateralQuality: CollateralQualitySchema,
  custodyModel: CustodyModelSchema,
  governanceTier: GovernanceTypeSchema,
  governanceQuality: GovernanceQualitySchema,
  dependencies: z.array(DependencyWeightSchema),
  navToken: z.boolean(),
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
}

export const ReportCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  overallGrade: ReportCardGradeSchema,
  overallScore: z.number().nullable(),
  baseScore: z.number().nullable(),
  dimensions: z.object({
    pegStability: ReportCardDimensionSchema,
    liquidity: ReportCardDimensionSchema,
    resilience: ReportCardDimensionSchema,
    decentralization: ReportCardDimensionSchema,
    dependencyRisk: ReportCardDimensionSchema,
  }),
  ratedDimensions: z.number(),
  rawInputs: RawDimensionInputsSchema,
  dependencies: z.array(DependencyWeightSchema).optional(),
  isDefunct: z.boolean(),
});

export interface ReportCard extends z.infer<typeof ReportCardSchema> {
  overallGrade: ReportCardGrade;
  dimensions: Record<DimensionKey, ReportCardDimension>;
  rawInputs: RawDimensionInputs;
  dependencies?: DependencyWeight[];
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
  thresholds: z.array(z.object({ grade: ReportCardGradeSchema, min: z.number() })),
});

const ReportCardsDependencyGraphSchema = z.object({
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
});

export const ReportCardsResponseSchema = z.object({
  cards: z.array(ReportCardSchema),
  methodology: ReportCardsMethodologySchema,
  dependencyGraph: ReportCardsDependencyGraphSchema,
  updatedAt: z.number(),
});

export interface ReportCardsResponse extends z.infer<typeof ReportCardsResponseSchema> {
  cards: ReportCard[];
  methodology: {
    version: string;
    weights: Record<DimensionKey, number>;
    pegMultiplierExponent: number;
    thresholds: { grade: ReportCardGrade; min: number }[];
  };
}
