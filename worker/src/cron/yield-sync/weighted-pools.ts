import type { WeightedYieldPoolGroupConfig } from "../../lib/yield-config/yield-config-weighted-pools";
import type { DlPool, ResolvedYield } from "./types";
import { resolveYieldRewardShare } from "./source-risk";

function normalizeDlIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function isUsableWeightedPool(
  pool: DlPool | undefined,
  config: WeightedYieldPoolGroupConfig,
): pool is DlPool {
  const expectedChain = pool ? config.expectedChainsByPoolId[pool.pool] : null;
  return Boolean(
    pool &&
      expectedChain &&
      pool.exposure === "single" &&
      pool.stablecoin &&
      pool.project === config.expectedProject &&
      normalizeDlIdentity(pool.symbol) === normalizeDlIdentity(config.expectedSymbol) &&
      normalizeDlIdentity(pool.chain) === normalizeDlIdentity(expectedChain) &&
      Number.isFinite(pool.tvlUsd) &&
      pool.tvlUsd > 0 &&
      Number.isFinite(pool.apy) &&
      pool.apy >= 0,
  );
}

function weightedAverage(
  pools: DlPool[],
  readValue: (pool: DlPool) => number | null,
): number | null {
  let totalTvlUsd = 0;
  let weightedTotal = 0;
  for (const pool of pools) {
    const value = readValue(pool);
    if (value == null || !Number.isFinite(value)) return null;
    totalTvlUsd += pool.tvlUsd;
    weightedTotal += value * pool.tvlUsd;
  }
  if (!Number.isFinite(totalTvlUsd) || totalTvlUsd <= 0) return null;
  if (!Number.isFinite(weightedTotal)) return null;
  const weightedValue = weightedTotal / totalTvlUsd;
  return Number.isFinite(weightedValue) ? weightedValue : null;
}

function commonPoolValue(
  pools: DlPool[],
  readValue: (pool: DlPool) => string | null | undefined,
): string | undefined {
  const values = new Set(
    pools
      .map((pool) => readValue(pool))
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  return values.size === 1 ? [...values][0] : undefined;
}

function joinedPoolValues(
  pools: DlPool[],
  readValue: (pool: DlPool) => string | null | undefined,
): string | undefined {
  const values = [
    ...new Set(
      pools
        .map((pool) => readValue(pool))
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];
  return values.length > 0 ? values.join(", ") : undefined;
}

export function buildWeightedYieldPoolGroupSource(
  config: WeightedYieldPoolGroupConfig,
  dlPools: DlPool[],
): ResolvedYield | null {
  const pools = config.poolIds
    .map((poolId) => dlPools.find((pool) => pool.pool === poolId))
    .filter((pool): pool is DlPool => isUsableWeightedPool(pool, config));

  if (pools.length < (config.minPools ?? 1)) return null;

  const totalTvlUsd = pools.reduce((sum, pool) => sum + pool.tvlUsd, 0);
  if (!Number.isFinite(totalTvlUsd) || totalTvlUsd <= 0) return null;

  const currentApy = weightedAverage(pools, (pool) => pool.apy);
  if (currentApy == null) return null;

  const apyBase = weightedAverage(pools, (pool) => pool.apyBase);
  const apyReward = weightedAverage(pools, (pool) =>
    pool.apyReward ?? (resolveYieldRewardShare({
      apyReward: pool.apyReward,
      apyBase: Number.isFinite(pool.apyBase) ? pool.apyBase : null,
      currentApy: pool.apy,
    }) === 0 ? 0 : null),
  );

  return {
    currentApy,
    apyBase,
    apyReward,
    sourcePool: null,
    sourceTvlUsd: totalTvlUsd,
    dataSource: "defillama",
    exchangeRate: null,
    sourceKey: config.sourceKey,
    yieldSource: config.yieldSource,
    yieldType: config.yieldType,
    project: commonPoolValue(pools, (pool) => pool.project),
    chain: joinedPoolValues(pools, (pool) => pool.chain),
  };
}
