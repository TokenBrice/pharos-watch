import type { DlPool } from "../yield-sync/types";

export function makeDlYieldPool(
  overrides: Partial<DlPool> = {},
): DlPool {
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
