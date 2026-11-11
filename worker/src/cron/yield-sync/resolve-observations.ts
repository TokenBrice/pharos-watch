import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { DlPool, ResolvedYieldEntry, SafetyScoreSnapshot, YieldResolutionResult } from "./types";
import { resolveYieldTypeLabel } from "./source-risk";
import { YIELD_VARIANT_CHILD_VENUE_PROTOCOLS } from "@shared/lib/yield-source-risk-registry";
import { isBlockedYieldOpportunitySource, matchAllDlPools } from "../yield-helpers";
import { getPriceDerivedApy } from "./state";
import { LAYER3_EXCLUDED_VENUE_PROJECTS } from "../../lib/yield-config/yield-config-lending-protocols";
import { ON_CHAIN_RATE_CONFIGS, PRICE_DERIVED_FALLBACK_IDS, RATE_DERIVED_CONFIGS } from "../../lib/yield-config/yield-config-rate-sources";
import { YIELD_POOL_MAP } from "../../lib/yield-config/yield-config-pools";
import { YIELD_VARIANT_MAP } from "../../lib/yield-config/yield-config-variants";
import { YIELD_WEIGHTED_POOL_GROUPS } from "../../lib/yield-config/yield-config-weighted-pools";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { INTENTIONAL_GAP_REASONS } from "../../lib/yield-config/yield-config-rate-sources";
import { resolveBenchmarkForStablecoin, type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import { STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY, TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID } from "./sources-optional";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import { isPriceDerivedYieldEligible } from "../../lib/yield-config/yield-config-registry";
import { resolveYieldBenchmarkDependencies } from "../../lib/yield-config/yield-benchmark-dependencies";
import { buildWeightedYieldPoolGroupSource, deriveOnChainRateObservation, deriveBenchmarkRateYield } from "./resolve-returns";
import { buildDlChainFilter, getTrackedContractAddresses, buildReservedYieldPoolIds } from "./resolve-pools";

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

export async function loadTier1PrevRateRows(
  db: D1Database,
  tier1CandidateIds: string[],
  sevenDaysAgoSec: number,
): Promise<Map<string, { exchangeRate: number | null; recordedAt: number }>> {
  const tier1PrevRateRows = new Map<string, { exchangeRate: number | null; recordedAt: number }>();
  const candidateIds = [...new Set(tier1CandidateIds)];
  if (candidateIds.length === 0) return tier1PrevRateRows;

  // Newest published rate at or before the anchor, one row per coin, ties
  // resolved by rowid DESC. Driving from the id list keeps each coin to index
  // seeks; ranking the whole 30-day partition read ~124k rows per run.
  const result = await db
    .prepare(
      `SELECT /* pharos:yield-sync:tier1-previous-rate */
         h.stablecoin_id, h.exchange_rate, h.recorded_at
       FROM json_each(?) AS ids
       JOIN yield_history h ON h.rowid = (
         SELECT h2.rowid
           FROM yield_history h2
          WHERE h2.stablecoin_id = ids.value
            AND h2.recorded_at = (
              SELECT MAX(h3.recorded_at)
                FROM yield_history h3
               WHERE h3.stablecoin_id = ids.value
                 AND h3.recorded_at <= ?
                 AND h3.exchange_rate > 0
                 AND (h3.publication_generation_id IS NULL OR h3.publication_state = 'published')
            )
            AND h2.exchange_rate > 0
            AND (h2.publication_generation_id IS NULL OR h2.publication_state = 'published')
          ORDER BY h2.rowid DESC
          LIMIT 1
       )`,
    )
    .bind(JSON.stringify(candidateIds), sevenDaysAgoSec)
    .all<{ stablecoin_id: string; exchange_rate: number | null; recorded_at: number }>();
  for (const row of result.results ?? []) {
    if (tier1PrevRateRows.has(row.stablecoin_id)) continue;
    tier1PrevRateRows.set(row.stablecoin_id, {
      exchangeRate: row.exchange_rate,
      recordedAt: row.recorded_at,
    });
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
  onOptionalSourceOutcome?: (outcome: { label: string; outcome: "failed" | "timeout" }) => void;
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
    const onChainRate = rateConfig ? params.onChainRates.get(id) : undefined;
    // B26 — a zero or non-finite read is a failed read, not a 0% observation.
    // Publishing it would write `exchange_rate: 0` (the next run's anchor) plus an
    // `apy: 0` seed row; the lane stays unresolved and the other lanes still run.
    if (rateConfig && onChainRate && Number.isFinite(onChainRate.rate) && onChainRate.rate > 0) {
      const { rate } = onChainRate;
      const prevRow = tier1PrevRateRows.get(id);
      tier1PrevRates.set(id, prevRow?.exchangeRate ?? null);
      const nativePoolId = YIELD_POOL_MAP[id] ?? null;
      const sourceTvlUsd = resolveMeasuredSourceTvlUsd({
        nativePoolId,
        dlPoolByPoolId,
        onChainTvlUsd: onChainRate.sourceTvlUsd,
      });

      const observation = deriveOnChainRateObservation({
        id,
        symbol,
        rate,
        previousRate: prevRow,
        startSec: params.startSec,
        nativePoolId,
        sourceTvlUsd,
      });
      if (observation.source) {
        resolved.push({ id, symbol, yield: observation.source });
        if (observation.source.observationKind !== "anchor-only") hasAnySource = true;
      }
      if (observation.rejection) envelopeRejections.push(observation.rejection);
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
      skipBaseSymbolFallback: rateConfig != null,
    });
    for (const dlPool of dlSources) {
      if (
        weightedPoolGroupMemberIds.has(dlPool.pool) ||
        alreadyResolvedKeys.has(dlPool.pool) ||
        !Number.isFinite(dlPool.apy)
      ) {
        continue;
      }

      const fullPool = dlPoolByPoolId.get(dlPool.pool);
      if (!fullPool || isBlockedYieldOpportunitySource({ project: fullPool.project, pool: fullPool.pool })) continue;

      const variant = YIELD_VARIANT_MAP[id];
      const isNativePool = dlPool.pool === YIELD_POOL_MAP[id];
      const isVariantPool = variant != null && !isNativePool;
      const venueProject = fullPool.project.trim().toLowerCase();
      // Layer 3 has only a base-symbol/address guess, never a curated holder
      // identity. A match inside a lending venue is a deposit market that holds
      // the tracked coin, so it can neither publish under the coin's native
      // label nor skip lending discovery's admission gates (safety, APY floor,
      // collision/source blocks, measured size). Skip before any bookkeeping so
      // the coin's own price-derived fallback still runs. An issuer's own pool
      // in such a project is pinned in YIELD_POOL_MAP; a reviewed vault share
      // keeps its own venue via YIELD_VARIANT_CHILD_VENUE_PROTOCOLS.
      const isLayer3Match = !isNativePool && !isVariantPool;
      if (
        isLayer3Match
        && YIELD_VARIANT_CHILD_VENUE_PROTOCOLS[id] !== venueProject
        && LAYER3_EXCLUDED_VENUE_PROJECTS.has(venueProject)
      ) {
        continue;
      }
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
          yieldType: resolveYieldTypeLabel({
            id,
            dataSource: "defillama",
            explicitType: isVariantPool ? variant.yieldType : undefined,
          }),
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
      && isPriceDerivedYieldEligible(id, INTENTIONAL_GAP_REASONS[id])
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
      const dependencies = resolveYieldBenchmarkDependencies({
        stablecoinId: id,
        dataSource: "rate-derived",
        benchmarks: params.riskFreeRates,
        benchmarkCurrency: null,
        nowSec: params.startSec,
      });
      const benchmarkSelection = resolveBenchmarkForStablecoin({
        stablecoinId: id,
        benchmarks: params.riskFreeRates,
        benchmarkCurrency: dependencies.productKey,
      });
      const rateDerived = deriveBenchmarkRateYield(rateDerivedConfig, benchmarkSelection.meta);
      if (rateDerived) {
        resolved.push({ id, symbol, yield: rateDerived });
        hasAnySource = true;
      }
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
        onOutcome: params.onOptionalSourceOutcome,
      });
      if (!optionalYield) continue;

      resolved.push({ id, symbol, yield: optionalYield });
      if (optionalYield.observationKind !== "anchor-only") hasAnySource = true;
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
      onOutcome: params.onOptionalSourceOutcome,
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
