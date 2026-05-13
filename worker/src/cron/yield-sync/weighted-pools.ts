import type { WeightedYieldPoolGroupConfig } from "../yield-config-weighted-pools";
import type { DlPool, ResolvedYield } from "./types";

function isUsableWeightedPool(pool: DlPool | undefined): pool is DlPool {
  return Boolean(
    pool &&
      pool.exposure === "single" &&
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
  const rows = pools
    .map((pool) => ({ value: readValue(pool), tvlUsd: pool.tvlUsd }))
    .filter((row): row is { value: number; tvlUsd: number } => row.value != null && Number.isFinite(row.value));
  const totalTvlUsd = rows.reduce((sum, row) => sum + row.tvlUsd, 0);
  if (totalTvlUsd <= 0) return null;
  return rows.reduce((sum, row) => sum + row.value * row.tvlUsd, 0) / totalTvlUsd;
}

export function buildWeightedYieldPoolGroupSource(
  config: WeightedYieldPoolGroupConfig,
  dlPools: DlPool[],
): ResolvedYield | null {
  const pools = config.poolIds
    .map((poolId) => dlPools.find((pool) => pool.pool === poolId))
    .filter(isUsableWeightedPool);

  if (pools.length < (config.minPools ?? 1)) return null;

  const totalTvlUsd = pools.reduce((sum, pool) => sum + pool.tvlUsd, 0);
  if (totalTvlUsd <= 0) return null;

  const currentApy = weightedAverage(pools, (pool) => pool.apy);
  if (currentApy == null) return null;

  return {
    currentApy,
    apyBase: weightedAverage(pools, (pool) => pool.apyBase),
    apyReward: weightedAverage(pools, (pool) => pool.apyReward),
    sourcePool: null,
    sourceTvlUsd: totalTvlUsd,
    dataSource: "defillama",
    exchangeRate: null,
    sourceKey: config.sourceKey,
    yieldSource: config.yieldSource,
    yieldType: config.yieldType,
  };
}
