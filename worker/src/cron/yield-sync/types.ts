export interface DlPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
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
  dataSource: "onchain" | "defillama" | "defillama-auto" | "price-derived" | "rate-derived";
  exchangeRate: number | null;
  sourceKey: string;
  yieldSource?: string;
  yieldType?: string;
  project?: string;
}

export interface ResolvedYieldEntry {
  id: string;
  symbol: string;
  yield: ResolvedYield | null;
}

export interface JsonRpcCallResponse {
  result?: string;
  error?: unknown;
}
