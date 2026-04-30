import { z } from "zod";

export const ChainHealthFactorsSchema = z.object({
  concentration: z.number(),
  quality: z.number().nullable(),
  pegStability: z.number(),
  backingDiversity: z.number(),
  chainEnvironment: z.number(),
});

export interface ChainHealthFactors {
  concentration: number;
  quality: number | null;
  pegStability: number;
  backingDiversity: number;
  chainEnvironment: number;
}

export const HealthBandSchema = z.enum(["robust", "healthy", "mixed", "fragile", "concentrated"]);
export type HealthBand = z.infer<typeof HealthBandSchema>;

export const ChainDominantStablecoinSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  share: z.number(),
});

export interface ChainDominantStablecoin {
  id: string;
  symbol: string;
  share: number;
}

export const ChainTopStablecoinSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  share: z.number(),
  supplyUsd: z.number(),
});

export interface ChainTopStablecoin {
  id: string;
  symbol: string;
  share: number;
  supplyUsd: number;
}

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

export interface ChainSummary {
  id: string;
  name: string;
  logoPath: string;
  type: "evm" | "tron" | "other";
  totalUsd: number;
  change24h: number;
  change24hPct: number;
  change7d: number;
  change7dPct: number;
  change30d: number;
  change30dPct: number;
  stablecoinCount: number;
  dominantStablecoin: ChainDominantStablecoin;
  topStablecoins?: ChainTopStablecoin[];
  dominanceShare: number;
  healthScore: number | null;
  healthBand: HealthBand | null;
  healthFactors: ChainHealthFactors;
}

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

export interface ChainsResponse {
  chains: ChainSummary[];
  globalTotalUsd: number;
  chainAttributedTotalUsd: number;
  unattributedTotalUsd: number;
  globalChange24hPct: number;
  globalChange7dPct: number;
  globalChange30dPct: number;
  updatedAt: number;
  healthMethodologyVersion: string;
}
