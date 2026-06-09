import type { YieldType } from "@shared/types/core";
import type { YieldBenchmarkKey, YieldSourceRisk } from "@shared/types/yield";

export interface DlPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  poolMeta?: string | null;
  tvlUsd: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number;
  stablecoin: boolean;
  exposure: string;
  underlyingTokens: string[] | null;
}

export interface ResolvedYield {
  currentApy: number;
  apyBase: number | null;
  apyReward: number | null;
  sourcePool: string | null;
  sourceTvlUsd: number | null;
  dataSource: "onchain" | "defillama" | "defillama-auto" | "price-derived" | "rate-derived" | "protocol-api";
  exchangeRate: number | null;
  sourceKey: string;
  yieldSource?: string;
  yieldType?: YieldType;
  project?: string;
  chain?: string | null;
  sourceObservedAt?: number | null;
  comparisonAnchorObservedAt?: number | null;
  sourceRisk?: YieldSourceRisk | null;
  benchmarkOverrideKey?: YieldBenchmarkKey | null;
}

export interface ResolvedYieldCandidate {
  stablecoinId?: string;
  symbol: string;
  chain?: string | null;
  address?: string | null;
  yield: ResolvedYield;
}

export interface ResolvedYieldEntry {
  id: string;
  symbol: string;
  yield: ResolvedYield | null;
}

export interface SafetyScoreSnapshot {
  score: number;
  grade: string;
}

export interface YieldEnvelopeRejection {
  stablecoinId: string;
  symbol: string;
  sourceKey: string;
  computedApy: number;
  exchangeRate: number;
  previousExchangeRate: number;
  anchorObservedAt: number;
  actualDays: number;
}

export interface YieldResolutionResult {
  resolved: ResolvedYieldEntry[];
  tier1PrevRates: Map<string, number | null>;
  envelopeRejections: YieldEnvelopeRejection[];
}
