export interface ChainHealthFactors {
  concentration: number;
  quality: number | null;
  pegStability: number;
  backingDiversity: number;
  chainEnvironment: number;
}

export type HealthBand = "robust" | "healthy" | "mixed" | "fragile" | "concentrated";

export interface ChainDominantStablecoin {
  id: string;
  symbol: string;
  share: number;
}

export interface ChainTopStablecoin {
  id: string;
  symbol: string;
  share: number;
  supplyUsd: number;
}

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
