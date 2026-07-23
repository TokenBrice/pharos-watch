import { z } from "zod";
import { SafetyScoreV8PublicationIdentitySchema } from "./safety-score-publication";

export const ChainsFreshnessMetaSchema = z.object({
  updatedAt: z.number(),
  ageSeconds: z.number(),
  status: z.enum(["fresh", "degraded", "stale"]),
  warning: z.string().optional(),
  dependencies: z.object({
    reportCards: z.object({
      updatedAt: z.number().nullable().optional(),
      ageSeconds: z.number().nullable().optional(),
      status: z.enum(["fresh", "degraded", "stale", "unavailable"]),
      reason: z.string().nullable().optional(),
      expectedModel: z.enum(["v8", "v9"]).optional(),
      inputsStale: z.boolean().optional(),
      staleInputs: z.array(z.string()).optional(),
    }),
  }).optional(),
  safetyScoreIdentity: SafetyScoreV8PublicationIdentitySchema.nullable().optional(),
});

export type ChainsFreshnessMeta = z.infer<typeof ChainsFreshnessMetaSchema>;

export const ChainHealthFactorsSchema = z.object({
  concentration: z.number(),
  quality: z.number().nullable(),
  pegStability: z.number(),
  backingDiversity: z.number(),
  chainEnvironment: z.number(),
});

export type ChainHealthFactors = z.infer<typeof ChainHealthFactorsSchema>;

export const ChainEnvironmentRiskValueSchema = z.object({
  value: z.string(),
  // "UnderReview"/"neutral" retained for live L2BEAT API ingestion (forward-compat).
  sentiment: z.enum(["good", "warning", "bad", "UnderReview", "neutral"]),
});

export const L2BeatChainEnvironmentEvidenceSchema = z.object({
  source: z.literal("l2beat"),
  score: z.number(),
  projectId: z.string(),
  slug: z.string(),
  name: z.string(),
  // "Under review" retained for live L2BEAT API ingestion (forward-compat).
  stage: z.enum(["Stage 0", "Stage 1", "Stage 2", "Not applicable", "Under review"]),
  isUnderReview: z.boolean(),
  stageScore: z.number(),
  riskScore: z.number(),
  risks: z.object({
    sequencerFailure: ChainEnvironmentRiskValueSchema,
    stateValidation: ChainEnvironmentRiskValueSchema,
    dataAvailability: ChainEnvironmentRiskValueSchema,
    exitWindow: ChainEnvironmentRiskValueSchema,
    proposerFailure: ChainEnvironmentRiskValueSchema,
  }),
  snapshot: z.object({
    source: z.string(),
    fetchedAt: z.string(),
  }),
});

export const TierChainEnvironmentEvidenceSchema = z.object({
  source: z.literal("pharos-chain-tier"),
  score: z.number(),
  resilienceTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const ChainEnvironmentEvidenceSchema = z.discriminatedUnion("source", [
  L2BeatChainEnvironmentEvidenceSchema,
  TierChainEnvironmentEvidenceSchema,
]);

export type ChainEnvironmentEvidence = z.infer<typeof ChainEnvironmentEvidenceSchema>;

export const HealthBandSchema = z.enum(["robust", "healthy", "mixed", "fragile", "concentrated"]);
export type HealthBand = z.infer<typeof HealthBandSchema>;

export const ChainDominantStablecoinSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  share: z.number(),
});

export type ChainDominantStablecoin = z.infer<typeof ChainDominantStablecoinSchema>;

export const ChainTopStablecoinSchema = ChainDominantStablecoinSchema.extend({
  supplyUsd: z.number(),
});

export type ChainTopStablecoin = z.infer<typeof ChainTopStablecoinSchema>;

export const ChainSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  logoPath: z.string(),
  type: z.enum(["evm", "tron", "other"]),
  totalUsd: z.number(),
  change24h: z.number(),
  change24hPct: z.number(),
  change7d: z.number(),
  change7dPct: z.number(),
  change30d: z.number(),
  change30dPct: z.number(),
  stablecoinCount: z.number(),
  dominantStablecoin: ChainDominantStablecoinSchema,
  topStablecoins: z.array(ChainTopStablecoinSchema).optional(),
  dominanceShare: z.number(),
  healthScore: z.number().nullable(),
  healthBand: HealthBandSchema.nullable(),
  healthFactors: ChainHealthFactorsSchema,
  chainEnvironmentEvidence: ChainEnvironmentEvidenceSchema.optional(),
});

export type ChainSummary = z.infer<typeof ChainSummarySchema>;

export const ChainsResponseSchema = z.object({
  chains: z.array(ChainSummarySchema),
  globalTotalUsd: z.number(),
  chainAttributedTotalUsd: z.number(),
  unattributedTotalUsd: z.number(),
  globalChange24hPct: z.number(),
  globalChange7dPct: z.number(),
  globalChange30dPct: z.number(),
  updatedAt: z.number(),
  healthMethodologyVersion: z.string(),
  safetyScoreIdentity: SafetyScoreV8PublicationIdentitySchema.nullable().optional(),
  _meta: ChainsFreshnessMetaSchema.optional(),
});

export type ChainsResponse = z.infer<typeof ChainsResponseSchema>;
