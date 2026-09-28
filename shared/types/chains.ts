import { z } from "zod";
import { SafetyScorePublicationIdentitySchema } from "./safety-score-publication";
import { RatioSchema } from "./ratio";
import { ApiDependencyMetaSchema, ApiMetaSchema } from "./api-meta";

export const ChainsFreshnessMetaSchema = ApiMetaSchema.extend({
  warning: z.string().optional(),
  dependencies: z.object({
    reportCards: ApiDependencyMetaSchema,
  }).optional(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable().optional(),
});

export type ChainsFreshnessMeta = z.infer<typeof ChainsFreshnessMetaSchema>;

/**
 * `pegStability` is nullable: under DEC-04 a chain with no observed peg evidence is not rated (NR). The
 * current producer still publishes the neutral-50 imputation until the Release B activation, so consumers
 * MUST already render `null` as NR and read `pegStabilityCoverage` for the evidence behind the number.
 */
export const ChainHealthFactorsSchema = z.object({
  concentration: z.number(),
  quality: z.number().nullable(),
  pegStability: z.number().nullable(),
  backingDiversity: z.number(),
  chainEnvironment: z.number(),
});

export type ChainHealthFactors = z.infer<typeof ChainHealthFactorsSchema>;

export const ChainPegStabilityCoverageStatusSchema = z.enum(["complete", "partial", "unavailable"]);
export type ChainPegStabilityCoverageStatus = z.infer<typeof ChainPegStabilityCoverageStatusSchema>;

/**
 * Peg-observation coverage against the chain's full positive supply (every coin on the chain, including
 * coins without a peg reference). `observedScore` is the supply-weighted peg proximity over observed supply
 * only. `neutralImputedSupplyUsd` is zero for v1.6 producers; nonzero values describe neutral-50
 * imputation only in retained pre-v1.6 payloads and must not be interpreted as observed evidence.
 */
export const ChainPegStabilityCoverageSchema = z.object({
  status: ChainPegStabilityCoverageStatusSchema,
  observedSupplyUsd: z.number().nonnegative(),
  eligibleSupplyUsd: z.number().nonnegative(),
  coverage: RatioSchema,
  noUsablePriceSupplyUsd: z.number().nonnegative(),
  noPegReferenceSupplyUsd: z.number().nonnegative(),
  neutralImputedSupplyUsd: z.number().nonnegative(),
  observedScore: z.number().nullable(),
});

export type ChainPegStabilityCoverage = z.infer<typeof ChainPegStabilityCoverageSchema>;

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
export const ChainTopStablecoinSchema = ChainDominantStablecoinSchema.extend({
  supplyUsd: z.number(),
});

export const ChainDetailCoinSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  price: z.number().nullable(),
  pegType: z.string().optional(),
  supplyUsd: z.number(),
  chainShare: RatioSchema,
  change24h: z.number().nullable(),
  change24hPct: RatioSchema.nullable(),
  change7d: z.number().nullable(),
  change7dPct: RatioSchema.nullable(),
  change30d: z.number().nullable(),
  change30dPct: RatioSchema.nullable(),
  backing: z.string().optional(),
});

export type ChainDetailCoin = z.infer<typeof ChainDetailCoinSchema>;

/**
 * Full per-chain coin rows for one chain, published by `GET /api/chains?chain=<id>`.
 * The chain-detail route renders these directly; the chain-local `totalUsd` is the
 * same aggregate the matching `chains[]` summary carries, so one response is the
 * single authority for both the hero totals and the composition sections.
 */
export const ChainDetailSchema = z.object({
  chainId: z.string(),
  totalUsd: z.number(),
  coins: z.array(ChainDetailCoinSchema),
});

export type ChainDetail = z.infer<typeof ChainDetailSchema>;

export const ChainSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  logoPath: z.string(),
  type: z.enum(["evm", "tron", "other"]),
  totalUsd: z.number(),
  change24h: z.number().nullable(),
  change24hPct: RatioSchema.nullable(),
  change7d: z.number().nullable(),
  change7dPct: RatioSchema.nullable(),
  change30d: z.number().nullable(),
  change30dPct: RatioSchema.nullable(),
  stablecoinCount: z.number(),
  dominantStablecoin: ChainDominantStablecoinSchema,
  topStablecoins: z.array(ChainTopStablecoinSchema),
  /**
   * Chain supply over the canonical global total (`totalUsd / globalTotalUsd`), never rescaled. When chain
   * rows over-attribute supply these shares sum above 1; geometry uses `dominanceGeometryTotalUsd` instead.
   */
  dominanceShare: z.number(),
  healthScore: z.number().nullable(),
  healthBand: HealthBandSchema.nullable(),
  healthFactors: ChainHealthFactorsSchema,
  pegStabilityCoverage: ChainPegStabilityCoverageSchema.optional(),
  /** Assets listing this chain whose current chain supply was unobserved; `totalUsd` excludes them. */
  unavailableSupplyObservationCount: z.number().int().nonnegative().optional(),
  chainEnvironmentEvidence: ChainEnvironmentEvidenceSchema.optional(),
});

export type ChainSummary = z.infer<typeof ChainSummarySchema>;

/**
 * Unobserved supply excluded from the chain accounting: assets whose aggregate circulating buckets were
 * absent/empty/invalid (excluded from `globalTotalUsd`) and asset-chain rows whose current supply was
 * unobserved (excluded from that chain's `totalUsd`). Chain IDs include chains with no published row
 * because every observation on them was unavailable.
 */
export const ChainsSupplyCoverageSchema = z.object({
  aggregateUnavailableAssetCount: z.number().int().nonnegative(),
  chainUnavailableObservationCount: z.number().int().nonnegative(),
  chainIdsWithUnavailableObservations: z.array(z.string()),
});

export type ChainsSupplyCoverage = z.infer<typeof ChainsSupplyCoverageSchema>;

export const ChainsResponseSchema = z.object({
  chains: z.array(ChainSummarySchema),
  globalTotalUsd: z.number(),
  /** Raw sum of the published chain rows' `totalUsd`; never capped at `globalTotalUsd`. */
  chainAttributedTotalUsd: z.number(),
  /** Positive residual `max(0, globalTotalUsd - chainAttributedTotalUsd)`. */
  unattributedTotalUsd: z.number(),
  /** Signed `chainAttributedTotalUsd - globalTotalUsd`: positive = over-attribution, negative = unattributed. */
  attributionDiscrepancyUsd: z.number().optional(),
  /** Normalized geometry denominator `max(globalTotalUsd, chainAttributedTotalUsd)`; never a share label. */
  dominanceGeometryTotalUsd: z.number().nonnegative().optional(),
  supplyCoverage: ChainsSupplyCoverageSchema.optional(),
  globalChange24hPct: RatioSchema.nullable(),
  globalChange7dPct: RatioSchema.nullable(),
  globalChange30dPct: RatioSchema.nullable(),
  chainDetail: ChainDetailSchema.optional(),
  updatedAt: z.number(),
  healthMethodologyVersion: z.string(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable().optional(),
  _meta: ChainsFreshnessMetaSchema.optional(),
}).superRefine((response, ctx) => {
  response.chains.forEach((chain, index) => {
    if (chain.totalUsd <= 0) return;
    const expectedCargoCount = Math.min(chain.stablecoinCount, 5);
    if (chain.topStablecoins.length !== expectedCargoCount) {
      ctx.addIssue({
        code: "custom",
        path: ["chains", index, "topStablecoins"],
        message: `Positive-supply chains must carry exactly ${expectedCargoCount} topStablecoins rows`,
      });
    }
  });
});

export type ChainsResponse = z.infer<typeof ChainsResponseSchema>;
