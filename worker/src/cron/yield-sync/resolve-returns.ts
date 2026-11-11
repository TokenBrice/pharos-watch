import type { DlPool, ResolvedYield, YieldEnvelopeRejection } from "./types";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { computeApyFromRate, isDeterministicApyWithinSanityBounds } from "./yield-helpers";
import { buildOnChainSourceKey } from "../../lib/yield/yield-utils";
import type { RateDerivedConfig } from "../../lib/yield-config/yield-config-registry";
import type { ParsedYieldBenchmarkMeta } from "./benchmarks";
import type { WeightedYieldPoolGroupConfig } from "../../lib/yield-config/yield-config-weighted-pools";
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
      Number.isFinite(pool.apy),
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

export function deriveOnChainRateObservation(params: {
  id: string;
  symbol: string;
  rate: number;
  previousRate: { exchangeRate: number | null; recordedAt: number } | undefined;
  startSec: number;
  nativePoolId: string | null;
  sourceTvlUsd: number | null;
}): { source: ResolvedYield | null; rejection: YieldEnvelopeRejection | null } {
  const { id, symbol, rate, previousRate: prevRow, nativePoolId, sourceTvlUsd } = params;
  if (prevRow?.exchangeRate && prevRow.exchangeRate > 0) {
    const actualDays = (params.startSec - prevRow.recordedAt) / DAY_SECONDS;
    const apy = computeApyFromRate(rate, prevRow.exchangeRate, actualDays);
    const sourceKey = buildOnChainSourceKey(id);
    if (typeof apy === "number" && isDeterministicApyWithinSanityBounds(apy)) {
      return {
        source: {
          currentApy: apy,
          apyBase: apy,
          apyReward: null,
          sourcePool: nativePoolId,
          sourceTvlUsd,
          dataSource: "onchain",
          exchangeRate: rate,
          sourceKey,
          sourceObservedAt: params.startSec,
          comparisonAnchorObservedAt: prevRow.recordedAt,
        },
        rejection: null,
      };
    }
    return {
      source: null,
      rejection: {
        stablecoinId: id,
        symbol,
        sourceKey,
        computedApy: typeof apy === "number" ? Number(apy.toFixed(6)) : null,
        rejectionReason: typeof apy === "number" ? "apy-sanity-envelope" : apy.reason,
        exchangeRate: rate,
        previousExchangeRate: prevRow.exchangeRate,
        anchorObservedAt: prevRow.recordedAt,
        actualDays: Number(actualDays.toFixed(4)),
      },
    };
  }
  return {
    source: {
      observationKind: "anchor-only",
      currentApy: 0,
      apyBase: null,
      apyReward: null,
      sourcePool: nativePoolId,
      sourceTvlUsd,
      dataSource: "onchain",
      exchangeRate: rate,
      sourceKey: buildOnChainSourceKey(id),
      sourceObservedAt: params.startSec,
      comparisonAnchorObservedAt: null,
    },
    rejection: null,
  };
}

export function deriveBenchmarkRateYield(
  rateDerivedConfig: RateDerivedConfig,
  benchmarkMeta: ParsedYieldBenchmarkMeta,
): ResolvedYield | null {
  // Retained market evidence is usable with degraded qualification; a
  // hardcoded fallback is not a measured product return.
  if (benchmarkMeta.isFallback && benchmarkMeta.lastMarketRate == null) return null;
  const apy = Math.max(0, benchmarkMeta.rate - rateDerivedConfig.spreadBps / 100);
  return {
    currentApy: apy,
    apyBase: apy,
    apyReward: null,
    sourcePool: null,
    sourceTvlUsd: null,
    dataSource: "rate-derived",
    exchangeRate: null,
    sourceKey: "rate-derived",
    yieldSource: rateDerivedConfig.label,
    sourceObservedAt: benchmarkMeta.lastMarketFetchedAt ?? benchmarkMeta.fetchedAt ?? null,
    comparisonAnchorObservedAt: null,
    benchmarkOverrideKey: rateDerivedConfig.benchmarkOverrideKey ?? null,
  };
}
