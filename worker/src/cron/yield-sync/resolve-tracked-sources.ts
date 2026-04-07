import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import {
  buildOnChainSourceKey,
  computeApyFromRate,
  matchAllDlPools,
} from "../yield-helpers";
import {
  ON_CHAIN_RATE_CONFIGS,
  PRICE_DERIVED_FALLBACK_IDS,
  RATE_DERIVED_CONFIGS,
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
} from "../yield-config";
import {
  getPriceDerivedApy,
} from "./sources";
import { resolveBenchmarkForStablecoin, type ParsedYieldBenchmarkRegistry } from "./benchmarks";
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

export async function resolveTrackedYieldSources(params: {
  db: D1Database;
  startSec: number;
  sevenDaysAgoSec: number;
  dlPools: DlPool[];
  onChainRates: Map<string, { rate: number }>;
  safetyScores: Map<string, SafetyScoreSnapshot>;
  riskFreeRates: ParsedYieldBenchmarkRegistry;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  coingeckoApiKey?: string | null;
}): Promise<YieldResolutionResult> {
  const resolved: ResolvedYieldEntry[] = [];
  const tier1PrevRates = new Map<string, number | null>();
  const reservedExplicitPoolIds = buildReservedYieldPoolIds();
  const tier1CandidateIds = ACTIVE_YIELD_BEARING_STABLECOINS
    .map((meta) => meta.id)
    .filter((id) => ON_CHAIN_RATE_CONFIGS.some((config) => config.stablecoinId === id) && params.onChainRates.has(id));
  const tier1PrevRateRows = new Map<string, { exchangeRate: number | null; recordedAt: number }>();

  if (tier1CandidateIds.length > 0) {
    const placeholders = tier1CandidateIds.map(() => "?").join(", ");
    const rows = await params.db
      .prepare(
        `SELECT stablecoin_id, exchange_rate, recorded_at
         FROM yield_history
         WHERE stablecoin_id IN (${placeholders}) AND recorded_at <= ? AND exchange_rate IS NOT NULL
         ORDER BY stablecoin_id ASC, recorded_at DESC`,
      )
      .bind(...tier1CandidateIds, params.sevenDaysAgoSec)
      .all<{ stablecoin_id: string; exchange_rate: number | null; recorded_at: number }>();
    for (const row of rows.results ?? []) {
      if (!tier1PrevRateRows.has(row.stablecoin_id)) {
        tier1PrevRateRows.set(row.stablecoin_id, {
          exchangeRate: row.exchange_rate,
          recordedAt: row.recorded_at,
        });
      }
    }
  }

  for (const meta of ACTIVE_YIELD_BEARING_STABLECOINS) {
    if (params.signal?.aborted) {
      throw params.signal.reason instanceof Error
        ? params.signal.reason
        : new Error("sync-yield-data resolution aborted");
    }

    const id = meta.id;
    const symbol = meta.symbol;
    let hasAnySource = false;
    const rateConfig = ON_CHAIN_RATE_CONFIGS.find((config) => config.stablecoinId === id);
    if (rateConfig && params.onChainRates.has(id)) {
      const { rate } = params.onChainRates.get(id)!;
      const prevRow = tier1PrevRateRows.get(id);
      tier1PrevRates.set(id, prevRow?.exchangeRate ?? null);

      if (prevRow?.exchangeRate && prevRow.exchangeRate > 0) {
        const actualDays = (params.startSec - prevRow.recordedAt) / DAY_SECONDS;
        const apy = computeApyFromRate(rate, prevRow.exchangeRate, actualDays);
        const nativePoolId = YIELD_POOL_MAP[id] ?? null;
        resolved.push({
          id,
          symbol,
          yield: {
            currentApy: apy,
            apyBase: apy,
            apyReward: null,
            sourcePool: nativePoolId,
            sourceTvlUsd: null,
            dataSource: "onchain",
            exchangeRate: rate,
            sourceKey: buildOnChainSourceKey(id),
            sourceObservedAt: params.startSec,
            comparisonAnchorObservedAt: prevRow.recordedAt,
          },
        });
        hasAnySource = true;
      } else {
        resolved.push({
          id,
          symbol,
          yield: {
            currentApy: 0,
            apyBase: null,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
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
    const dlSources = matchAllDlPools(id, symbol, params.dlPools, YIELD_POOL_MAP, YIELD_VARIANT_MAP, {
      chainFilter: buildDlChainFilter(meta),
      contractAddresses: getTrackedContractAddresses(meta),
      reservedPoolIds: reservedExplicitPoolIds,
    });
    for (const dlPool of dlSources) {
      if (alreadyResolvedKeys.has(dlPool.pool) || dlPool.apy == null || dlPool.apy < 0) {
        continue;
      }

      const fullPool = params.dlPools.find((pool) => pool.pool === dlPool.pool);
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
        resolved.push({
          id,
          symbol,
          yield: {
            currentApy: priceDerived.apy,
            apyBase: priceDerived.apy,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
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

    const rateDerivedConfig = RATE_DERIVED_CONFIGS.find((config) => config.stablecoinId === id);
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
          sourceObservedAt: params.startSec,
          comparisonAnchorObservedAt: null,
        },
      });
      hasAnySource = true;
    }

    const trackedOptionalEntries = TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.get(id) ?? [];
    for (const entry of trackedOptionalEntries) {
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

  return { resolved, tier1PrevRates };
}
