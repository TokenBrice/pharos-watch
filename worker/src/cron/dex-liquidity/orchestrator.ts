import type { CronResult } from "../../lib/cron-logger";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { LiquidityMetrics, LlamaPool } from "./types";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import { throwIfAborted } from "../../lib/abort";
import { loadPriceValidationReferences } from "../../lib/price-validation";
import { buildSymbolLookups, classifyPoolType } from "./pool-helpers";
import {
  fetchDataSources, buildCurveLookups, buildKnownPoolAddresses,
} from "./fetch-primary";
import { publishDexPriceChallengerSnapshots } from "./challenger-persistence";
import { processPoolMetrics } from "./process-pools";
import { mergeStagedPools } from "./staging-merge";
import { computeStablecoinScores, computeDepthStability, computeDexPrices } from "./scoring";
import { persistScores, writeHistoricalSnapshots } from "./persistence";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { DexLiquidityCronMetadataSchema } from "../../lib/schemas";
import {
  isPreferredDirectApiPool,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { POOL_CHALLENGE_MIN_TVL } from "../../lib/constants";
import { buildDirectApiPoolIdentity } from "./direct-source-helpers";
import {
  buildDexDirectApiFetchers,
  fetchSubgraphEnrichmentPhase,
  integrateDirectApiLiquidityPhase,
  loadTrackedStablecoinPriceMap,
  mergeDexPriceObservationMap,
  runDirectApiFetchPhase,
  runFallbackCrawlerPhase,
} from "./orchestrator-phases";
import {
  buildPoolIdentity,
  countPoolIdentityKeys,
  createKnownPoolIdentityIndex,
  getIdentityDedupReason,
  registerKnownPoolIdentity,
} from "./pool-identity";

const DRIFT_WATCHLIST = [
  "usdc-circle",
  "usdt-tether",
  "dai-makerdao",
  "usds-sky",
  "usde-ethena",
] as const;

type PreviousDexLiquiditySummary = {
  stagedPoolsMerged: number;
  stagedPoolsSkipped: number;
  priceObservationCoins: number;
  measuredBalanceCoveragePct: number;
  weakCoverageCoins: number;
};

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function pctDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return round4((current - previous) / previous);
}

function readPreviousDexLiquiditySummary(metadata: string | null): PreviousDexLiquiditySummary | null {
  if (!metadata) return null;
  try {
    const parsed = DexLiquidityCronMetadataSchema.parse(JSON.parse(metadata));
    return {
      stagedPoolsMerged: parsed.stagedPoolsMerged ?? 0,
      stagedPoolsSkipped: parsed.stagedPoolsSkipped ?? 0,
      priceObservationCoins: parsed.sourceCoverage.priceObservationCoins ?? 0,
      measuredBalanceCoveragePct: parsed.sourceCoverage.measuredBalanceCoveragePct ?? 0,
      weakCoverageCoins: parsed.sourceCoverage.weakCoverageCoins ?? 0,
    };
  } catch (err) {
    console.warn(
      "[dex-liquidity] Failed to parse previous cron metadata:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export function filterPrimaryPoolsPreferDirectApi(
  pools: LlamaPool[],
  directApiPools: DexApiPool[],
): {
  filteredPools: LlamaPool[];
  skippedByExactIdentity: number;
  skippedByUniqueDerivedIdentity: number;
  skippedByOptionalWildcardIdentity: number;
} {
  const eligibleDirectApiPools = directApiPools.filter((pool) => isPreferredDirectApiPool(pool));
  const directApiKnown = createKnownPoolIdentityIndex();
  for (const pool of eligibleDirectApiPools) {
    registerKnownPoolIdentity(directApiKnown, buildDirectApiPoolIdentity(pool));
  }

  const primaryIdentities = pools.map((pool) =>
    buildPoolIdentity({
      chain: pool.chain,
      protocol: pool.project,
      poolAddressOrId: pool.pool,
      tokenAddresses: pool.underlyingTokens ?? [],
      poolType: classifyPoolType(pool.project),
      isStable: pool.stablecoin,
    }),
  );
  const primaryIdentityCounts = countPoolIdentityKeys(primaryIdentities);

  const filteredPools: LlamaPool[] = [];
  let skippedByExactIdentity = 0;
  let skippedByUniqueDerivedIdentity = 0;
  let skippedByOptionalWildcardIdentity = 0;

  for (let index = 0; index < pools.length; index++) {
    const pool = pools[index]!;
    const identity = primaryIdentities[index]!;
    const dedupReason = getIdentityDedupReason(
      identity,
      directApiKnown,
      {
        derived: identity.derivedMatchKey
          ? (primaryIdentityCounts.derived.get(identity.derivedMatchKey) ?? 0)
          : 0,
        wildcard: identity.optionalWildcardKey
          ? (primaryIdentityCounts.wildcard.get(identity.optionalWildcardKey) ?? 0)
          : 0,
      },
      { allowOptionalWildcard: true },
    );

    if (dedupReason === "exact") {
      skippedByExactIdentity++;
      continue;
    }
    if (dedupReason === "derived_unique") {
      skippedByUniqueDerivedIdentity++;
      continue;
    }
    if (dedupReason === "derived_optional_wildcard") {
      skippedByOptionalWildcardIdentity++;
      continue;
    }

    filteredPools.push(pool);
  }

  return {
    filteredPools,
    skippedByExactIdentity,
    skippedByUniqueDerivedIdentity,
    skippedByOptionalWildcardIdentity,
  };
}

export async function syncDexLiquidity(
  db: D1Database,
  graphApiKey: string | null,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);
  const failedSources: string[] = [];
  const criticalSourceFailures: string[] = [];
  const fallbackSignals: string[] = [];
  console.log(`[dex-liquidity] Starting sync`);
  throwIfAborted(signal);
  const validationReferences = await loadPriceValidationReferences(db);
  const stablecoinPriceById = await loadTrackedStablecoinPriceMap(db, syncStartSec);

  // 1. Fetch all external data sources
  const dataSources = await fetchDataSources(graphApiKey, db, signal);
  if (!dataSources) {
    throw new Error("dex-liquidity: catastrophic source failure (DL yields + Curve unavailable)");
  }
  if (!dataSources.dlYieldsAvailable) {
    console.log("[dex-liquidity] DL yields unavailable — pool coverage may be reduced");
    failedSources.push("defillama-yields");
    criticalSourceFailures.push("defillama-yields");
    fallbackSignals.push("dl-yields-unavailable");
  }
  if (!dataSources.dlProtocolsAvailable) {
    failedSources.push("defillama-protocols");
    criticalSourceFailures.push("defillama-protocols");
    fallbackSignals.push("dl-protocols-unavailable");
  }

  // 2. Build symbol/address lookup maps
  const {
    symbolToIds,
    symbolToChainScopedIds,
    addressToId,
    chainAddressToId,
    contractMetaByChainAddress,
  } = buildSymbolLookups();

  // 3. Parse Curve data into pool lookups and price observations
  const { curvePoolMap, priceObservations } = await buildCurveLookups(
    dataSources.curveResponses,
    symbolToIds,
    symbolToChainScopedIds,
    chainAddressToId,
    validationReferences,
  );

  const directApiFetchers = buildDexDirectApiFetchers({
    graphApiKey,
    chainAddressToId,
    symbolToChainScopedIds,
    stablecoinPriceById,
    chainRpcs,
  });
  const subgraphEnrichment = await fetchSubgraphEnrichmentPhase({
    graphApiKey,
    symbolToIds,
    symbolToChainScopedIds,
    chainAddressToId,
    signal,
    validationReferences,
  });
  failedSources.push(...subgraphEnrichment.failedSources);

  const directApiPhase = await runDirectApiFetchPhase(db, directApiFetchers, signal);
  failedSources.push(...directApiPhase.failedSources);
  fallbackSignals.push(...directApiPhase.fallbackSignals);

  mergeDexPriceObservationMap(priceObservations, subgraphEnrichment.uniV3PriceObs);
  mergeDexPriceObservationMap(priceObservations, subgraphEnrichment.aerodromePriceObs);
  console.log(`[dex-liquidity] Total: ${priceObservations.size} coins with price observations across all sources`);

  const directApiPools = directApiPhase.results.flatMap((entry) => entry.result.pools);

  const {
    filteredPools: preferredPrimaryPools,
    skippedByExactIdentity: primarySkippedByDirectApiExactIdentity,
    skippedByUniqueDerivedIdentity: primarySkippedByDirectApiDerivedIdentity,
    skippedByOptionalWildcardIdentity: primarySkippedByDirectApiWildcardIdentity,
  } = filterPrimaryPoolsPreferDirectApi(dataSources.pools, directApiPools);
  if (
    primarySkippedByDirectApiExactIdentity > 0 ||
    primarySkippedByDirectApiDerivedIdentity > 0 ||
    primarySkippedByDirectApiWildcardIdentity > 0
  ) {
    console.log(
      `[dex-liquidity] Preferred direct API over DL for ${primarySkippedByDirectApiExactIdentity} exact matches and ` +
      `${primarySkippedByDirectApiDerivedIdentity} unique derived matches and ` +
      `${primarySkippedByDirectApiWildcardIdentity} optional wildcard matches`,
    );
  }

  // 4c. Build known pool identity index from preferred primary sources (for staged/fallback dedup)
  const knownPoolIndex = buildKnownPoolAddresses(
    preferredPrimaryPools, dataSources.dexProjects,
    curvePoolMap, subgraphEnrichment.uniV3PoolFees, subgraphEnrichment.aerodromeIsStable,
  );

  // 5. Match pools to stablecoins and compute per-pool metrics
  const metrics = processPoolMetrics(
    preferredPrimaryPools,
    dataSources.dexProjects,
    symbolToIds,
    symbolToChainScopedIds,
    addressToId,
    chainAddressToId,
    curvePoolMap,
    subgraphEnrichment.uniV3PoolFees,
    subgraphEnrichment.uniV3SymbolFees,
    subgraphEnrichment.aerodromeIsStable,
  );
  integrateDirectApiLiquidityPhase({
    directApiPools,
    knownPoolIndex,
    contractMetaByChainAddress,
    metrics,
    priceObservations,
    chainAddressToId,
    symbolToChainScopedIds,
    symbolToIds,
    validationReferences,
    stablecoinPriceById,
  });

  const {
    mergedCount: stagedMergedCount,
    skippedCount: stagedSkippedCount,
    skippedByExactIdentityCount: stagedSkippedByExactIdentityCount,
    skippedByUniqueDerivedIdentityCount: stagedSkippedByUniqueDerivedIdentityCount,
    priceObservations: stagedPriceObs,
  } =
    await mergeStagedPools(db, metrics, knownPoolIndex, syncStartSec, validationReferences);
  mergeDexPriceObservationMap(priceObservations, stagedPriceObs);

  const {
    dsFallbackCoins,
    cgTickerFallbackCoins,
    coverageRecoveredCoins,
    weakCoverageCoinsBeforeFallback,
  } = await runFallbackCrawlerPhase({
    metrics,
    priceObservations,
    knownPoolIndex,
    signal,
    validationReferences,
    failedSources,
    coingeckoApiKey,
  });

  // 6. Compute composite scores per stablecoin
  const {
    scores: scoreResults,
    globalAgg,
    retainedPoolsByStablecoin = new Map<string, LiquidityMetrics["topPools"]>(),
    tvlStabilityMap = new Map<string, number>(),
    diagnostics,
  } = await computeStablecoinScores(db, metrics, dataSources.protocolTvlCaps);
  const currentCoverage = scoreResults.size;
  const [
    previousCoverageRow,
    previousGlobalRow,
    previousCoverageClassRows,
    previousTopCoverageRows,
    previousCronRow,
    previousWatchlistRows,
  ] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) as cnt FROM dex_liquidity WHERE stablecoin_id != '__global__' AND liquidity_score IS NOT NULL")
      .first<{ cnt: number }>()
      .catch((e) => { console.warn("[dex-liquidity] Failed to read previous coverage count — using safe high fallback:", e instanceof Error ? e.message : e); return { cnt: 9999 }; }),
    db
      .prepare("SELECT total_tvl_usd FROM dex_liquidity WHERE stablecoin_id = '__global__'")
      .first<{ total_tvl_usd: number | null }>()
      .catch((e) => { console.warn("[dex-liquidity] Failed to read previous global TVL:", e); return null; }),
    db
      .prepare(
        `SELECT coverage_class, COUNT(*) as cnt
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__'
         GROUP BY coverage_class`
      )
      .all<{ coverage_class: string | null; cnt: number }>()
      .catch((e) => { console.warn("[dex-liquidity] Failed to read previous coverage classes:", e); return { results: [] as Array<{ coverage_class: string | null; cnt: number }> }; }),
    db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__' AND liquidity_score IS NOT NULL
         ORDER BY total_tvl_usd DESC
         LIMIT 10`
      )
      .all<{ stablecoin_id: string; total_tvl_usd: number }>()
      .catch((e) => { console.warn("[dex-liquidity] Failed to read previous top coverage:", e); return { results: [] as Array<{ stablecoin_id: string; total_tvl_usd: number }> }; }),
    db
      .prepare(
        `SELECT metadata
         FROM cron_runs
         WHERE job = 'sync-dex-liquidity'
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .first<{ metadata: string | null }>()
      .catch((e) => { console.warn("[dex-liquidity] Failed to read previous cron metadata:", e); return null; }),
    db
      .prepare(
        `SELECT stablecoin_id, pool_count, coverage_confidence, total_tvl_usd, balance_measured_tvl_usd
         FROM dex_liquidity
         WHERE stablecoin_id IN (${DRIFT_WATCHLIST.map(() => "?").join(", ")})`
      )
      .bind(...DRIFT_WATCHLIST)
      .all<{
        stablecoin_id: string;
        pool_count: number;
        coverage_confidence: number | null;
        total_tvl_usd: number;
        balance_measured_tvl_usd: number;
      }>()
      .catch((e) => {
        console.warn("[dex-liquidity] Failed to read previous watchlist rows:", e);
        return { results: [] as Array<{
          stablecoin_id: string;
          pool_count: number;
          coverage_confidence: number | null;
          total_tvl_usd: number;
          balance_measured_tvl_usd: number;
        }> };
      }),
  ]);
  const previousCoverage = previousCoverageRow?.cnt ?? 0;
  // M1: First-run bootstrap — when previousCoverage is 0, the minimum threshold
  // is max(1, floor(0 * 0.6)) = 1, so the guard permits any result with at
  // least 1 scored coin. This avoids false alarms on initial deployment.
  const minExpectedCoverage = Math.max(1, Math.floor(previousCoverage * 0.6));
  const nearCoverageGuard = previousCoverage >= 10 && currentCoverage < Math.floor(previousCoverage * 0.8);

  const currentGlobalTvl = globalAgg.totalTvl;
  const previousGlobalTvl = previousGlobalRow?.total_tvl_usd ?? null;
  const minExpectedGlobalTvl = previousGlobalTvl != null ? previousGlobalTvl * 0.6 : null;
  const nearValueGuard = previousGlobalTvl != null &&
    previousGlobalTvl >= 10_000_000 &&
    currentGlobalTvl < previousGlobalTvl * 0.85;
  const hardValueGuard = previousGlobalTvl != null &&
    previousGlobalTvl >= 10_000_000 &&
    currentGlobalTvl < previousGlobalTvl * 0.6;

  const previousTop10CoveredTvl = (previousTopCoverageRows.results ?? [])
    .reduce((sum, row) => sum + row.total_tvl_usd, 0);
  const currentTop10CoveredTvl = (previousTopCoverageRows.results ?? [])
    .reduce((sum, row) => sum + (scoreResults.get(row.stablecoin_id)?.tvl ?? 0), 0);
  const nearMajorCoverageGuard = previousTop10CoveredTvl >= 5_000_000 &&
    currentTop10CoveredTvl < previousTop10CoveredTvl * 0.85;
  const hardMajorCoverageGuard = previousTop10CoveredTvl >= 5_000_000 &&
    currentTop10CoveredTvl < previousTop10CoveredTvl * 0.6;

  const currentCoverageClasses = {
    primary: 0,
    mixed: 0,
    fallback: 0,
    legacy: 0,
    unobserved: ACTIVE_STABLECOINS.length - currentCoverage,
  };
  for (const row of scoreResults.values()) {
    currentCoverageClasses[row.coverageClass] += 1;
  }
  const measuredBalanceCoveragePct = scoreResults.size > 0
    ? Math.round(
      (Array.from(scoreResults.values()).reduce((sum, row) => {
        if (row.tvl <= 0) return sum;
        return sum + Math.max(0, Math.min(1, (row.balanceMeasuredTvlUsd ?? 0) / row.tvl));
      }, 0) / scoreResults.size) * 10000,
    ) / 10000
    : 0;
  const syntheticOnlyCoins = Array.from(scoreResults.values()).filter((row) => {
    const totalTvl = Object.values(row.sourceMix ?? {}).reduce((sum, entry) => sum + (entry?.tvlUsd ?? 0), 0);
    const primaryTvl = (row.sourceMix?.dl?.tvlUsd ?? 0) + (row.sourceMix?.direct_api?.tvlUsd ?? 0);
    return totalTvl > 0 && primaryTvl <= 0 && row.coverageClass === "fallback";
  }).length;

  const previousCoverageClasses = {
    primary: 0,
    mixed: 0,
    fallback: 0,
    legacy: 0,
    unobserved: 0,
  };
  for (const row of previousCoverageClassRows.results ?? []) {
    const key = row.coverage_class;
    if (key && key in previousCoverageClasses) {
      previousCoverageClasses[key as keyof typeof previousCoverageClasses] = row.cnt;
    }
  }

  const previousSummary = readPreviousDexLiquiditySummary(previousCronRow?.metadata ?? null);
  const watchlistPreviousById = new Map(
    (previousWatchlistRows.results ?? []).map((row) => [row.stablecoin_id, row]),
  );
  const currentWatchlistDeltas = DRIFT_WATCHLIST.map((stablecoinId) => {
    const previous = watchlistPreviousById.get(stablecoinId);
    const currentScore = scoreResults.get(stablecoinId);
    const currentPools = retainedPoolsByStablecoin.get(stablecoinId)?.length ?? 0;
    const currentMeasuredShare = currentScore && currentScore.tvl > 0
      ? Math.max(0, Math.min(1, currentScore.balanceMeasuredTvlUsd / currentScore.tvl))
      : 0;
    const previousMeasuredShare = previous && previous.total_tvl_usd > 0
      ? Math.max(0, Math.min(1, (previous.balance_measured_tvl_usd ?? 0) / previous.total_tvl_usd))
      : 0;
    return {
      stablecoinId,
      previousPoolCount: previous?.pool_count ?? 0,
      currentPoolCount: currentPools,
      poolCountPctDelta: pctDelta(currentPools, previous?.pool_count ?? 0),
      previousCoverageConfidence: previous?.coverage_confidence ?? null,
      currentCoverageConfidence: currentScore?.coverageConfidence ?? null,
      previousMeasuredShare: previous ? round4(previousMeasuredShare) : null,
      currentMeasuredShare: currentScore ? round4(currentMeasuredShare) : null,
    };
  });

  const priceObservationPctDelta = previousSummary
    ? pctDelta(priceObservations.size, previousSummary.priceObservationCoins)
    : null;
  const stagedPoolsMergedPctDelta = previousSummary
    ? pctDelta(stagedMergedCount, previousSummary.stagedPoolsMerged)
    : null;
  const stagedPoolsSkippedPctDelta = previousSummary
    ? pctDelta(stagedSkippedCount, previousSummary.stagedPoolsSkipped)
    : null;
  const measuredBalanceCoverageDelta = previousSummary
    ? round4(measuredBalanceCoveragePct - previousSummary.measuredBalanceCoveragePct)
    : null;
  const weakCoverageDelta = previousSummary
    ? weakCoverageCoinsBeforeFallback - previousSummary.weakCoverageCoins
    : null;

  const qualityDriftFlags: string[] = [];
  if (priceObservationPctDelta != null && priceObservationPctDelta <= -0.1) {
    qualityDriftFlags.push("price-observation-drop");
  }
  if (stagedPoolsMergedPctDelta != null && stagedPoolsMergedPctDelta <= -0.1) {
    qualityDriftFlags.push("staged-merge-drop");
  }
  if (measuredBalanceCoverageDelta != null && measuredBalanceCoverageDelta <= -0.08) {
    qualityDriftFlags.push("measured-balance-drop");
  }
  if (weakCoverageDelta != null && weakCoverageDelta >= 5) {
    qualityDriftFlags.push("weak-coverage-rise");
  }
  for (const delta of currentWatchlistDeltas) {
    if (delta.poolCountPctDelta != null && delta.poolCountPctDelta <= -0.2) {
      qualityDriftFlags.push(`watchlist-pool-drop:${delta.stablecoinId}`);
    }
  }
  const qualityDriftSeverity =
    qualityDriftFlags.length === 0
      ? "none"
      : qualityDriftFlags.some((flag) => flag === "measured-balance-drop" || flag.startsWith("watchlist-pool-drop:"))
        ? "high"
        : "medium";

  const retainedPoolCountBySourceFamily: Record<string, number> = {};
  const measuredBalanceTvlBySourceFamily: Record<string, number> = {};
  const priceObservationCoinsBySourceFamily: Record<string, number> = {};
  const preCapProtocolTvl: Record<string, number> = {};
  const preCapStablecoinProtocolTvl = new Map<string, Record<string, number>>();
  let coinsWithoutMeasuredBalances = 0;
  let coinsCrawlerOnly = 0;
  let coinsGtOnly = 0;
  let coinsPriceOnlyNoMeasuredLiquidity = 0;

  for (const [stablecoinId, pools] of retainedPoolsByStablecoin) {
    const sourceFamilies = new Set<string>();
    let hasPrimaryLiquidity = false;
    let hasGeckoTerminalLiquidity = false;
    let hasMeasuredBalanceLiquidity = false;
    const stablecoinProtocolTvl: Record<string, number> = {};
    for (const pool of pools) {
      retainedPoolCountBySourceFamily[pool.source] = (retainedPoolCountBySourceFamily[pool.source] ?? 0) + 1;
      sourceFamilies.add(pool.source);
      if (pool.source === "dl" || pool.source === "direct_api") hasPrimaryLiquidity = true;
      if (pool.source === "gecko_terminal") hasGeckoTerminalLiquidity = true;
      if (pool.extra?.measurement?.balanceMeasured) {
        hasMeasuredBalanceLiquidity = true;
        measuredBalanceTvlBySourceFamily[pool.source] = round4(
          (measuredBalanceTvlBySourceFamily[pool.source] ?? 0) + pool.tvlUsd,
        );
      }
      const protocol = pool.project;
      preCapProtocolTvl[protocol] = (preCapProtocolTvl[protocol] ?? 0) + pool.tvlUsd;
      stablecoinProtocolTvl[protocol] = (stablecoinProtocolTvl[protocol] ?? 0) + pool.tvlUsd;
    }
    preCapStablecoinProtocolTvl.set(stablecoinId, stablecoinProtocolTvl);
    if (pools.length > 0 && !hasMeasuredBalanceLiquidity) coinsWithoutMeasuredBalances++;
    if (pools.length > 0 && !hasPrimaryLiquidity) coinsCrawlerOnly++;
    if (pools.length > 0 && sourceFamilies.size === 1 && hasGeckoTerminalLiquidity) coinsGtOnly++;
    if (pools.length > 0 && !hasMeasuredBalanceLiquidity && (priceObservations.get(stablecoinId)?.length ?? 0) > 0) {
      coinsPriceOnlyNoMeasuredLiquidity++;
    }
  }
  for (const [_stablecoinId, observations] of priceObservations) {
    const families = new Set(
      observations
        .map((obs) => (typeof obs.sourceFamily === "string" && obs.sourceFamily.length > 0 ? obs.sourceFamily : null))
        .filter((family): family is string => family != null),
    );
    for (const family of families) {
      priceObservationCoinsBySourceFamily[family] = (priceObservationCoinsBySourceFamily[family] ?? 0) + 1;
    }
  }

  const cappedProtocolBreakdown = Object.entries(preCapProtocolTvl)
    .map(([protocol, preCapTvl]) => {
      const cap = dataSources.protocolTvlCaps.get(protocol);
      if (cap == null || cap <= 0 || preCapTvl <= cap) return null;
      return {
        protocol,
        preCapTvlUsd: Math.round(preCapTvl),
        postCapTvlUsd: Math.round(cap),
        reducedTvlUsd: Math.round(preCapTvl - cap),
      };
    })
    .filter((item): item is { protocol: string; preCapTvlUsd: number; postCapTvlUsd: number; reducedTvlUsd: number } => item != null)
    .sort((a, b) => b.reducedTvlUsd - a.reducedTvlUsd)
    .slice(0, 6);
  const cappedStablecoinBreakdown = Array.from(preCapStablecoinProtocolTvl.entries())
    .map(([stablecoinId, protocolTvl]) => {
      let reducedTvlUsd = 0;
      for (const [protocol, stablecoinTvl] of Object.entries(protocolTvl)) {
        const cap = dataSources.protocolTvlCaps.get(protocol);
        const protocolPreCapTvl = preCapProtocolTvl[protocol] ?? 0;
        if (cap == null || cap <= 0 || protocolPreCapTvl <= cap || stablecoinTvl <= 0) continue;
        reducedTvlUsd += ((protocolPreCapTvl - cap) * stablecoinTvl) / protocolPreCapTvl;
      }
      return { stablecoinId, reducedTvlUsd: Math.round(reducedTvlUsd) };
    })
    .filter((item) => item.reducedTvlUsd > 0)
    .sort((a, b) => b.reducedTvlUsd - a.reducedTvlUsd)
    .slice(0, 6);

  if (previousCoverage >= 10 && currentCoverage < minExpectedCoverage) {
    throw new Error(
      `[dex-liquidity] coverage guard tripped: current=${currentCoverage}, previous=${previousCoverage}, minExpected=${minExpectedCoverage}`,
    );
  }
  if (hardValueGuard) {
    throw new Error(
      `[dex-liquidity] value coverage guard tripped: currentGlobalTvl=${Math.round(currentGlobalTvl)}, ` +
      `previousGlobalTvl=${Math.round(previousGlobalTvl ?? 0)}, minExpectedGlobalTvl=${Math.round(minExpectedGlobalTvl ?? 0)}`,
    );
  }
  if (hardMajorCoverageGuard) {
    throw new Error(
      `[dex-liquidity] major coverage guard tripped: currentTop10CoveredTvl=${Math.round(currentTop10CoveredTvl)}, ` +
      `previousTop10CoveredTvl=${Math.round(previousTop10CoveredTvl)}`,
    );
  }
  throwIfAborted(signal);

  // 7. Persist primary tables. D1 in Workers rejects manual SQL transaction statements.
  await runWithOverloadRetry(() => persistScores(db, metrics, scoreResults, globalAgg, syncStartSec));
  const sourceCoverageCompleteByStablecoin = new Map<string, boolean>(
    ACTIVE_STABLECOINS.map((meta) => {
      const retainedPools = retainedPoolsByStablecoin.get(meta.id) ?? [];
      const hasPublishedRows = retainedPools.some((pool) => (
        Number.isFinite(pool.price) &&
        (pool.price ?? 0) > 0 &&
        Number.isFinite(pool.tvlUsd) &&
        pool.tvlUsd >= POOL_CHALLENGE_MIN_TVL
      ));
      return [meta.id, criticalSourceFailures.length === 0 || hasPublishedRows];
    }),
  );
  const challengerPublication = await publishDexPriceChallengerSnapshots(db, {
    snapshotAt: syncStartSec,
    retainedPoolsByStablecoin,
    sourceCoverageCompleteByStablecoin,
    minPoolTvlUsd: POOL_CHALLENGE_MIN_TVL,
  });
  await computeDexPrices(db, priceObservations, syncStartSec);

  // 8. Write daily historical snapshots
  await writeHistoricalSnapshots(db, scoreResults);

  // 9. Compute and persist depth stability (reuses data already loaded during scoring)
  await computeDepthStability(db, tvlStabilityMap);

  const degraded =
    criticalSourceFailures.length > 0 ||
    nearCoverageGuard ||
    nearValueGuard ||
    nearMajorCoverageGuard;

  return {
    status: degraded ? "degraded" : "ok",
    itemCount: scoreResults.size,
    metadata: JSON.stringify({
      rowsRead: dataSources.pools.length,
      rowsWritten: scoreResults.size,
      rowsDropped: 0,
      stagedPoolsMerged: stagedMergedCount,
      stagedPoolsSkipped: stagedSkippedCount,
      stagedPoolsSkippedByExactIdentity: stagedSkippedByExactIdentityCount,
      stagedPoolsSkippedByUniqueDerivedIdentity: stagedSkippedByUniqueDerivedIdentityCount,
      sourceCoverage: {
        dlYieldsAvailable: dataSources.dlYieldsAvailable,
        dlProtocolsAvailable: dataSources.dlProtocolsAvailable,
        currentCoverage,
        previousCoverage,
        minExpectedCoverage,
        nearCoverageGuard,
        currentGlobalTvl,
        previousGlobalTvl,
        minExpectedGlobalTvl,
        nearValueGuard,
        currentTop10CoveredTvl,
        previousTop10CoveredTvl,
        nearMajorCoverageGuard,
        currentCoverageClasses,
        previousCoverageClasses,
        priceObservationCoins: priceObservations.size,
        weakCoverageCoins: weakCoverageCoinsBeforeFallback,
        coverageRecoveredCoins,
        dsFallbackCoins,
        cgTickerFallbackCoins,
        measuredBalanceCoveragePct,
        syntheticOnlyCoins,
        coinsWithoutMeasuredBalances,
        coinsGtOnly,
        coinsCrawlerOnly,
        coinsPriceOnlyNoMeasuredLiquidity,
        retainedPoolCountBySourceFamily,
        measuredBalanceTvlBySourceFamily,
        priceObservationCoinsBySourceFamily,
        sourceDegradedFamilies: [...new Set(criticalSourceFailures)],
        protocolCapReductions: {
          ...diagnostics.protocolCapReductions,
          topProtocols: cappedProtocolBreakdown,
          topStablecoins: cappedStablecoinBreakdown,
        },
        qualityDriftFlags,
        qualityDriftSeverity,
        qualityDriftMetrics: {
          previousPriceObservationCoins: previousSummary?.priceObservationCoins ?? null,
          currentPriceObservationCoins: priceObservations.size,
          priceObservationPctDelta,
          previousMeasuredBalanceCoveragePct: previousSummary?.measuredBalanceCoveragePct ?? null,
          currentMeasuredBalanceCoveragePct: measuredBalanceCoveragePct,
          measuredBalanceCoverageDelta,
          previousStagedPoolsMerged: previousSummary?.stagedPoolsMerged ?? null,
          currentStagedPoolsMerged: stagedMergedCount,
          stagedPoolsMergedPctDelta,
          previousStagedPoolsSkipped: previousSummary?.stagedPoolsSkipped ?? null,
          currentStagedPoolsSkipped: stagedSkippedCount,
          stagedPoolsSkippedPctDelta,
          previousWeakCoverageCoins: previousSummary?.weakCoverageCoins ?? null,
          currentWeakCoverageCoins: weakCoverageCoinsBeforeFallback,
          weakCoverageDelta,
        },
        topAssetCoverageDeltas: currentWatchlistDeltas,
        challengerSnapshotsPublished: challengerPublication.publishedStablecoins,
        challengerSnapshotsSkipped: challengerPublication.skippedStablecoins,
        challengerSnapshotTablesMissing: challengerPublication.missingTables,
      },
      failedSources: [...new Set(failedSources)],
      fallbackMode: [...new Set(fallbackSignals)],
      validationFailures: 0,
    }),
  };
}
