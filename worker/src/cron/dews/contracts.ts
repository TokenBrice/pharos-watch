import type { PegRateSource } from "@shared/lib/peg-rates";
import type { StablecoinData } from "@shared/types/market";
import type { YieldRankChangeAttribution, YieldSourceRisk } from "@shared/types/yield";
import type { DEWSResult } from "../../lib/dews";

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

export interface DexLiquidityDependencyDiagnostics {
  totalRows: number;
  freshRows: number;
  staleRows: number;
  freshnessAgeSec: number | null;
  staleThresholdSec: number;
  latestGenerationId: string | null;
  latestGenerationState: string | null;
  latestGenerationStartedAt: number | null;
  latestGenerationPublishedAt: number | null;
  latestGenerationFailedAt: number | null;
  latestGenerationFailureReason: string | null;
  latestPublishedGenerationId: string | null;
  latestPublishedAt: number | null;
  latestPublishedAgeSec: number | null;
  diagnosticsError?: string;
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
  /** Distinct baseline days observed in the 30-day mint/burn window. */
  baselineDays: number;
}

export type BlacklistCountByStablecoinId = Map<string, { count24h: number; count7d: number }>;

export type DewsComputedRow = DEWSResult & {
  stablecoinId: string;
};

export interface ContagionAmplifiers {
  /** Amplifier per pegType, defaults to 1.0 when no contagion detected. */
  byPegType: Record<string, number>;
  /** Coins whose first-pass DANGER/WARNING band contributed. */
  triggeringIds: string[];
}

export interface DewsSourceState {
  dexLiqRows: { results: DexLiquidityRow[] };
  dexLiqMap: Map<string, DexLiquidityRow>;
  dexLiqAgeSecById: Map<string, number>;
  dexLiqStaleIds: Set<string>;
  dexPriceMap: Map<string, DexPriceSnapshot>;
  dexPriceAgeSecById: Map<string, number>;
  dexPriceStaleIds: Set<string>;
  liqHist7dMap: Map<string, LiquidityHistorySnapshot>;
  liqHistRowsRead: number;
  blacklistCounts: BlacklistCountByStablecoinId;
  prevSignals: Map<string, { signals: Record<string, { value: number }>; computedAt: number; ageSec: number }>;
  prevSignalStaleIds: Set<string>;
  mintBurnMap: Map<string, MintBurnSnapshot>;
  mintBurnAgeSecById: Map<string, number>;
  mintBurnStaleIds: Set<string>;
  yieldWarnings: Map<string, string[]>;
  yieldSourceRisk: Map<string, YieldSourceRisk>;
  yieldRankChangeAttribution: Map<string, YieldRankChangeAttribution>;
  latestPsiScore: number | null;
  sourceCoverage: Record<string, number>;
  dependencyDiagnostics: {
    dexLiquidity: DexLiquidityDependencyDiagnostics;
  };
}

export interface DewsScoringState {
  assetById: Map<string, StablecoinData>;
  pegRates: Record<string, number>;
  pegRateSources?: Record<string, PegRateSource>;
  pegRateContributorCounts?: Record<string, number>;
  sourceState: DewsSourceState;
}

export interface DewsScoringResult {
  results: DewsComputedRow[];
  liqHistCoverageCount: number;
  insufficientDataCount: number;
  noCurrentSupplyIds: string[];
}
