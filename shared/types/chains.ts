import { z } from "zod";

export const ChainHealthFactorsSchema = z.object({
  concentration: z.number(),
  quality: z.number().nullable(),
  pegStability: z.number(),
  backingDiversity: z.number(),
  chainEnvironment: z.number(),
});

export type ChainHealthFactors = z.infer<typeof ChainHealthFactorsSchema>;

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
});

export type ChainsResponse = z.infer<typeof ChainsResponseSchema>;
