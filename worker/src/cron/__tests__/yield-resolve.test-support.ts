type DlYieldPool = {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase: number;
  apyReward: number | null;
  apyMean30d: number;
  stablecoin: boolean;
  exposure: string;
  underlyingTokens: string[] | null;
  poolMeta?: string;
};

export function makeDlYieldPool(
  overrides: Partial<DlYieldPool> = {},
): DlYieldPool {
  return {
    pool: "pool-sdai-native",
    chain: "Ethereum",
    project: "maker",
    symbol: "sDAI",
    tvlUsd: 2_000_000_000,
    apy: 5,
    apyBase: 5,
    apyReward: null,
    apyMean30d: 5,
    stablecoin: true,
    exposure: "single",
    underlyingTokens: null,
    ...overrides,
  };
}
