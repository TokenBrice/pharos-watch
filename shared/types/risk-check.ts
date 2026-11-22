import { z } from "zod";
import { ApiMetaEnvelopeSchema } from "@pharos/contracts/api-meta";
import { RedemptionCapacitySemanticsSchema } from "./redemption";

const RiskCheckUnresolvedInputSchema = z.object({
  input: z.string(),
  kind: z.enum(["id", "contract"]),
  reason: z.string(),
});
export type RiskCheckUnresolvedInput = z.infer<typeof RiskCheckUnresolvedInputSchema>;

const RiskCheckSafetyPillarsSchema = z.object({
  backing: z.number().nullable(),
  exit: z.number().nullable(),
  control: z.number().nullable(),
});

const RiskCheckActiveDepegSchema = z.object({
  eventId: z.number().int(),
  startedAt: z.number().int(),
  direction: z.enum(["above", "below"]),
  peakDeviationBps: z.number(),
});

const RiskCheckAssetSchema = z.object({
  identity: z.object({
    id: z.string(),
    symbol: z.string(),
    name: z.string(),
    status: z.string(),
    pegCurrency: z.string(),
    governance: z.string(),
    backing: z.string().nullable(),
    navToken: z.boolean(),
    yieldBearing: z.boolean(),
  }),
  safety: z.object({
    ratingStatus: z.enum(["rated", "not-rated", "pipeline-gap"]).nullable(),
    score: z.number().nullable(),
    grade: z.string().nullable(),
    pillars: RiskCheckSafetyPillarsSchema.nullable(),
    publicationStatus: z.enum(["current", "held", "stale", "unavailable"]),
    heldSinceSec: z.number().int().nullable(),
    methodologyVersion: z.string().nullable(),
    unavailableReason: z.string().nullable(),
  }),
  dews: z.object({
    score: z.number().nullable(),
    band: z.string().nullable(),
    computedAt: z.number().int().nullable(),
    ageClassification: z.enum(["fresh", "lagging", "stale", "retainedLastValid"]).nullable(),
    unavailableReason: z.string().nullable(),
  }),
  peg: z.object({
    price: z.number().nullable(),
    priceSource: z.string().nullable(),
    priceConfidence: z.string().nullable(),
    priceObservedAt: z.number().int().nullable(),
    currentDeviationBps: z.number().nullable(),
    pegScore: z.number().nullable(),
    pegPct: z.number().nullable(),
    activeDepeg: RiskCheckActiveDepegSchema.nullable(),
    unavailableReason: z.string().nullable(),
  }),
  ddr: z.object({
    outlook: z.string().nullable(),
    recoveryProbability24h: z.number().nullable(),
    recoveryProbability7d: z.number().nullable(),
    medianHours: z.number().nullable(),
    stale: z.boolean().nullable(),
    unavailableReason: z.string().nullable(),
  }),
  liquidity: z.object({
    liquidityScore: z.number().nullable(),
    totalTvlUsd: z.number().nullable(),
    volume24hUsd: z.number().nullable(),
    poolCount: z.number().int().nullable(),
    dexPriceUsd: z.number().nullable(),
    updatedAt: z.number().int().nullable(),
    warning: z.string().nullable(),
    unavailableReason: z.string().nullable(),
  }),
  redemption: z.object({
    score: z.number().nullable(),
    routeFamily: z.string().nullable(),
    accessModel: z.string().nullable(),
    immediateCapacityUsd: z.number().nullable(),
    feeBps: z.number().nullable(),
    marketPhase: z.string().nullable(),
    capacitySemantics: RedemptionCapacitySemanticsSchema.nullable(),
    eventualRedeemabilityScore: z.number().nullable(),
    unavailableReason: z.string().nullable(),
  }),
  controls: z.object({
    freezeable: z.union([z.boolean(), z.enum(["possible", "inherited"])]).nullable(),
    blacklistabilityStatus: z.string().nullable(),
    liveFreezeTrackerCovered: z.boolean(),
  }),
  compliance: z.object({
    micaStatus: z.string().nullable(),
    micaTokenType: z.string().nullable(),
    geniusStatus: z.string().nullable(),
    geniusPathway: z.string().nullable(),
    geniusRegimeEffective: z.boolean(),
    reviewedAt: z.string().nullable(),
    unavailableReason: z.string().nullable(),
  }),
});
export type RiskCheckAsset = z.infer<typeof RiskCheckAssetSchema>;

export const RiskCheckResponseSchema = z.object({
  schemaVersion: z.literal(1),
  assessedAt: z.number().int(),
  requestedCount: z.number().int().positive(),
  resolvedCount: z.number().int().positive(),
  unresolved: z.array(RiskCheckUnresolvedInputSchema),
  assets: z.record(z.string(), RiskCheckAssetSchema),
  _meta: ApiMetaEnvelopeSchema,
});
export type RiskCheckResponse = z.infer<typeof RiskCheckResponseSchema>;
