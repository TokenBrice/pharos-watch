import type { StablecoinData } from "@shared/types/market";

export interface SourceFailure {
  source: string;
  reason: string;
  bootstrapAllowed: boolean;
}

export type PersistedJsonDecodeReason = "missing" | "json-parse-failed" | "invalid-shape";

export interface MalformedPersistedInput {
  source: string;
  context: string;
  stablecoinId: string;
  updatedAt: number | null;
  degradesRun: boolean;
}

export interface DexLiquidityRow {
  stablecoin_id: string;
  weighted_balance_ratio: number | null;
  avg_pool_stress: number | null;
  top_pools_json: string | null;
  liquidity_score: number | null;
  total_tvl_usd: number | null;
  updated_at: number | null;
}

export interface LiquidityHistorySnapshot {
  score: number | null;
  tvl: number | null;
  date: number;
}

export interface DexPriceSnapshot {
  dexPriceUsd: number;
  sourceTotalTvl: number;
  updatedAt: number;
}

export interface MintBurnSnapshot {
  burn24h: number;
  mint24h: number;
  burnBaseline: number;
  mintBaseline: number;
  dataAgeDays: number;
}

export interface DewsComputedRow {
  stablecoinId: string;
  score: number;
  band: string;
  signals: Record<string, unknown>;
}

export interface DewsSourceState {
  dexLiqRows: { results: DexLiquidityRow[] };
  dexLiqMap: Map<string, DexLiquidityRow>;
  dexPriceMap: Map<string, DexPriceSnapshot>;
  liqHist7dMap: Map<string, LiquidityHistorySnapshot>;
  liqHistRowsRead: number;
  blacklistCounts: Map<string, { count24h: number; count7d: number }>;
  prevSignals: Map<string, Record<string, { value: number }>>;
  mintBurnMap: Map<string, MintBurnSnapshot>;
  yieldWarnings: Map<string, string[]>;
  latestPsiScore: number | null;
  sourceCoverage: Record<string, number>;
}

export interface DewsScoringState {
  assetById: Map<string, StablecoinData>;
  pegRates: Record<string, number>;
  sourceState: DewsSourceState;
}

export interface DewsScoringResult {
  results: DewsComputedRow[];
  liqHistCoverageCount: number;
  insufficientDataCount: number;
  noCurrentSupplyIds: string[];
}
