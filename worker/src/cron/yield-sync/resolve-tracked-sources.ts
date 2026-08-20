import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import {
  buildOnChainSourceKey,
  computeApyFromRate,
  isDeterministicApyWithinSanityBounds,
  matchAllDlPools,
} from "../yield-helpers";
import {
  ON_CHAIN_RATE_CONFIGS,
  PRICE_DERIVED_FALLBACK_IDS,
  RATE_DERIVED_CONFIGS,
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
  YIELD_WEIGHTED_POOL_GROUPS,
} from "../yield-config";
import {
  getPriceDerivedApy,
} from "./sources";
import {
  resolveBenchmarkForStablecoin,
  type ParsedYieldBenchmarkMeta,
  type ParsedYieldBenchmarkRegistry,
} from "./benchmarks";
import { buildDlChainFilter, getTrackedContractAddresses } from "./identity";
import type {
  DlPool,
  ResolvedYieldEntry,
  SafetyScoreSnapshot,
  YieldResolutionResult,
} from "./types";
import { buildReservedYieldPoolIds } from "./resolve-helpers";
import {
  STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY,
  TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID,
} from "./tracked-optional-source-registry";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import { buildWeightedYieldPoolGroupSource } from "./weighted-pools";

function buildConfigByStablecoinId<T extends { stablecoinId: string }>(configs: readonly T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const config of configs) {
    byId.set(config.stablecoinId, config);
  }
  return byId;
}

function resolveMeasuredSourceTvlUsd(params: {
  nativePoolId: string | null;
  dlPoolByPoolId: Map<string, DlPool>;
  onChainTvlUsd?: number | null;
}): number | null {
  if (params.nativePoolId) {
    const pinned = params.dlPoolByPoolId.get(params.nativePoolId);
    const pinnedTvl = pinned?.tvlUsd;
    if (typeof pinnedTvl === "number" && Number.isFinite(pinnedTvl) && pinnedTvl > 0) {
      return pinnedTvl;
    }
  }
  const onChainTvl = params.onChainTvlUsd;
  if (typeof onChainTvl === "number" && Number.isFinite(onChainTvl) && onChainTvl > 0) {
    return onChainTvl;
  }
  return null;
}

function getBenchmarkSourceObservedAt(meta: ParsedYieldBenchmarkMeta, fallbackObservedAt: number): number {
  return meta.lastMarketFetchedAt ?? meta.fetchedAt ?? fallbackObservedAt;
}

export async function loadTier1PrevRateRows(
  db: D1Database,
  tier1CandidateIds: string[],
  sevenDaysAgoSec: number,
): Promise<Map<string, { exchangeRate: number | null; recordedAt: number }>> {
  const tier1PrevRateRows = new Map<string, { exchangeRate: number | null; recordedAt: number }>();
  if (tier1CandidateIds.length === 0) return tier1PrevRateRows;

  const statement = db.prepare(
    `SELECT /* pharos:yield-sync:tier1-previous-rate */
       exchange_rate, recorded_at
     FROM yield_history
     WHERE stablecoin_id = ?
       AND recorded_at <= ?
       AND exchange_rate IS NOT NULL
       AND (publication_generation_id IS NULL OR publication_state = 'published')
     ORDER BY recorded_at DESC
     LIMIT 1`,
  );
  for (const stablecoinId of new Set(tier1CandidateIds)) {
    const row = await statement
      .bind(stablecoinId, sevenDaysAgoSec)
      .first<{ exchange_rate: number | null; recorded_at: number }>();
    if (row) {
      tier1PrevRateRows.set(stablecoinId, {
        exchangeRate: row.exchange_rate,
        recordedAt: row.recorded_at,
      });
    }
  }
  return tier1PrevRateRows;
}

export async function resolveTrackedYieldSources(params: {
  db: D1Database;
  startSec: number;
  sevenDaysAgoSec: number;
  dlPools: DlPool[];
  onChainRates: Map<string, { rate: number; sourceTvlUsd?: number | null }>;
  safetyScores: Map<string, SafetyScoreSnapshot>;
  riskFreeRates: ParsedYieldBenchmarkRegistry;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  coingeckoApiKey?: string | null;
}): Promise<YieldResolutionResult> {
  const resolved: ResolvedYieldEntry[] = [];
  const tier1PrevRates = new Map<string, number | null>();
  const envelopeRejections: YieldResolutionResult["envelopeRejections"] = [];
  const reservedExplicitPoolIds = buildReservedYieldPoolIds();
  const onChainRateConfigById = buildConfigByStablecoinId(ON_CHAIN_RATE_CONFIGS);
  const rateDerivedConfigById = buildConfigByStablecoinId(RATE_DERIVED_CONFIGS);
  const dlPoolByPoolId = new Map<string, DlPool>();
  for (const pool of params.dlPools) {
    if (!dlPoolByPoolId.has(pool.pool)) {
      dlPoolByPoolId.set(pool.pool, pool);
    }
  }
  const tier1CandidateIds: string[] = [];
  for (const meta of ACTIVE_YIELD_BEARING_STABLECOINS) {
    if (onChainRateConfigById.has(meta.id) && params.onChainRates.has(meta.id)) {
      tier1CandidateIds.push(meta.id);
    }
  }
  const tier1PrevRateRows = await loadTier1PrevRateRows(params.db, tier1CandidateIds, params.sevenDaysAgoSec);

  for (const meta of ACTIVE_YIELD_BEARING_STABLECOINS) {
    if (params.signal?.aborted) {
      throw params.signal.reason instanceof Error
        ? params.signal.reason
        : new Error("sync-yield-data resolution aborted");
    }

    const id = meta.id;
    const symbol = meta.symbol;
    let hasAnySource = false;
    const rateConfig = onChainRateConfigById.get(id);
    if (rateConfig && params.onChainRates.has(id)) {
      const onChainRate = params.onChainRates.get(id)!;
      const { rate } = onChainRate;
      const prevRow = tier1PrevRateRows.get(id);
      tier1PrevRates.set(id, prevRow?.exchangeRate ?? null);
      const nativePoolId = YIELD_POOL_MAP[id] ?? null;
      const sourceTvlUsd = resolveMeasuredSourceTvlUsd({
        nativePoolId,
        dlPoolByPoolId,
        onChainTvlUsd: onChainRate.sourceTvlUsd,
      });

      if (prevRow?.exchangeRate && prevRow.exchangeRate > 0) {
        const actualDays = (params.startSec - prevRow.recordedAt) / DAY_SECONDS;
        const apy = computeApyFromRate(rate, prevRow.exchangeRate, actualDays);
        const sourceKey = buildOnChainSourceKey(id);
        if (isDeterministicApyWithinSanityBounds(apy)) {
          resolved.push({
            id,
            symbol,
            yield: {
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
          });
          hasAnySource = true;
        } else {
          envelopeRejections.push({
            stablecoinId: id,
            symbol,
            sourceKey,
            computedApy: Number(apy.toFixed(6)),
            exchangeRate: rate,
            previousExchangeRate: prevRow.exchangeRate,
            anchorObservedAt: prevRow.recordedAt,
            actualDays: Number(actualDays.toFixed(4)),
          });
        }
      } else {
        resolved.push({
          id,
          symbol,
          yield: {
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
        });
      }
    }

    const alreadyResolvedKeys = new Set(
      resolved.flatMap((entry) => entry.id === id && entry.yield != null ? [entry.yield.sourceKey] : []),
    );
    const weightedPoolGroup = YIELD_WEIGHTED_POOL_GROUPS[id];
    const weightedPoolGroupSource = weightedPoolGroup
      ? buildWeightedYieldPoolGroupSource(weightedPoolGroup, params.dlPools)
      : null;
    const weightedPoolGroupMemberIds = new Set(
      weightedPoolGroupSource && weightedPoolGroup ? weightedPoolGroup.poolIds : [],
    );
    if (weightedPoolGroupSource && !alreadyResolvedKeys.has(weightedPoolGroupSource.sourceKey)) {
      resolved.push({ id, symbol, yield: weightedPoolGroupSource });
      alreadyResolvedKeys.add(weightedPoolGroupSource.sourceKey);
      hasAnySource = true;
    }

    const dlSources = matchAllDlPools(id, symbol, params.dlPools, YIELD_POOL_MAP, YIELD_VARIANT_MAP, {
      chainFilter: buildDlChainFilter(meta),
      contractAddresses: getTrackedContractAddresses(meta),
      reservedPoolIds: reservedExplicitPoolIds,
    });
    for (const dlPool of dlSources) {
      if (
        weightedPoolGroupMemberIds.has(dlPool.pool) ||
        alreadyResolvedKeys.has(dlPool.pool) ||
        dlPool.apy == null ||
        dlPool.apy < 0
      ) {
        continue;
      }

      const fullPool = dlPoolByPoolId.get(dlPool.pool);
      if (!fullPool) continue;

      const variant = YIELD_VARIANT_MAP[id];
      const isVariantPool = variant != null && dlPool.pool !== YIELD_POOL_MAP[id];
      resolved.push({
        id,
        symbol,
        yield: {
          currentApy: fullPool.apy,
          apyBase: fullPool.apyBase,
          apyReward: fullPool.apyReward,
          sourcePool: fullPool.pool,
          sourceTvlUsd: fullPool.tvlUsd,
          dataSource: "defillama",
          exchangeRate: null,
          sourceKey: fullPool.pool,
          yieldSource: isVariantPool ? variant.yieldSource : undefined,
          yieldType: isVariantPool ? variant.yieldType : undefined,
          project: fullPool.project,
          chain: fullPool.chain,
        },
      });
      alreadyResolvedKeys.add(dlPool.pool);
      hasAnySource = true;
    }

    const allDlSourcesZero = hasAnySource
      && resolved
        .filter((entry): entry is typeof entry & { yield: NonNullable<typeof entry.yield> } => entry.id === id && entry.yield != null)
        .every((entry) => entry.yield.currentApy === 0);

    const shouldTryPriceDerived =
      (meta.flags.navToken || PRICE_DERIVED_FALLBACK_IDS.has(id))
      && (!hasAnySource || allDlSourcesZero);
    if (shouldTryPriceDerived) {
      const priceDerived = await getPriceDerivedApy(params.db, id);
      if (priceDerived != null) {
        const nativePoolId = YIELD_POOL_MAP[id] ?? null;
        resolved.push({
          id,
          symbol,
          yield: {
            currentApy: priceDerived.apy,
            apyBase: priceDerived.apy,
            apyReward: null,
            sourcePool: nativePoolId,
            sourceTvlUsd: resolveMeasuredSourceTvlUsd({
              nativePoolId,
              dlPoolByPoolId,
            }),
            dataSource: "price-derived",
            exchangeRate: null,
            sourceKey: "price-derived",
            sourceObservedAt: priceDerived.sourceObservedAt,
            comparisonAnchorObservedAt: priceDerived.comparisonAnchorObservedAt,
          },
        });
        hasAnySource = true;
      }
    }

    const rateDerivedConfig = rateDerivedConfigById.get(id);
    if (rateDerivedConfig) {
      const benchmarkSelection = resolveBenchmarkForStablecoin({
        stablecoinId: id,
        benchmarks: params.riskFreeRates,
        benchmarkCurrency: rateDerivedConfig.benchmarkCurrency ?? null,
      });
      const apy = Math.max(0, benchmarkSelection.meta.rate - rateDerivedConfig.spreadBps / 100);
      resolved.push({
        id,
        symbol,
        yield: {
          currentApy: apy,
          apyBase: apy,
          apyReward: null,
          sourcePool: null,
          sourceTvlUsd: null,
          dataSource: "rate-derived",
          exchangeRate: null,
          sourceKey: "rate-derived",
          yieldSource: rateDerivedConfig.label,
          sourceObservedAt: getBenchmarkSourceObservedAt(benchmarkSelection.meta, params.startSec),
          comparisonAnchorObservedAt: null,
          benchmarkOverrideKey: rateDerivedConfig.benchmarkOverrideKey ?? null,
        },
      });
      hasAnySource = true;
    }

    const trackedOptionalEntries = TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.get(id) ?? [];
    for (const entry of trackedOptionalEntries) {
      throwIfAborted(params.signal);
      if (resolved.some((resolvedEntry) => resolvedEntry.id === id && resolvedEntry.yield?.sourceKey === entry.sourceKey)) {
        continue;
      }

      const optionalYield = await entry.run({
        db: params.db,
        startSec: params.startSec,
        signal: params.signal,
        chainRpcs: params.chainRpcs,
        coingeckoApiKey: params.coingeckoApiKey,
      });
      if (!optionalYield) continue;

      resolved.push({ id, symbol, yield: optionalYield });
      hasAnySource = true;
    }

    if (!hasAnySource) {
      resolved.push({ id, symbol, yield: null });
    }
  }

  for (const entry of STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY) {
    throwIfAborted(params.signal);
    const matchingTrackedEntry = TRACKED_META_BY_ID.get(entry.stablecoinId);
    if (!matchingTrackedEntry) continue;
    if (resolved.some((resolvedEntry) => resolvedEntry.id === entry.stablecoinId && resolvedEntry.yield?.sourceKey === entry.sourceKey)) {
      continue;
    }

    const optionalYield = await entry.run({
      db: params.db,
      startSec: params.startSec,
      signal: params.signal,
      chainRpcs: params.chainRpcs,
      coingeckoApiKey: params.coingeckoApiKey,
    });
    if (!optionalYield) continue;

    resolved.push({
      id: matchingTrackedEntry.id,
      symbol: matchingTrackedEntry.symbol,
      yield: optionalYield,
    });
  }

  return { resolved, tier1PrevRates, envelopeRejections };
}
