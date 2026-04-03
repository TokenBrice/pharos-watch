import type { CronResult } from "../../lib/cron-logger";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { LiquidityMetrics, LlamaPool } from "./types";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import { throwIfAborted } from "../../lib/abort";
import { loadPriceValidationReferences } from "../../lib/price-validation";
import { buildSymbolLookups, classifyPoolType } from "./pool-helpers";
import { fetchDataSources, buildCurveLookups, buildKnownPoolAddresses } from "./fetch-primary";
import { publishDexPriceChallengerSnapshots } from "./challenger-persistence";
import { processPoolMetrics } from "./process-pools";
import { mergeStagedPools } from "./staging-merge";
import { computeStablecoinScores, computeDepthStability, computeDexPrices } from "./scoring";
import { persistScores, writeHistoricalSnapshots } from "./persistence";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { isPreferredDirectApiPool, type DexApiPool } from "../../lib/dex-api-common";
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
import { analyzeDexLiquidityPostScoring, buildDexLiquidityCronMetadata, isDexLiquidityDegraded } from "./orchestrator-metadata";

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
  const analysis = await analyzeDexLiquidityPostScoring({
    db,
    scoreResults,
    globalAgg,
    retainedPoolsByStablecoin,
    priceObservations,
    protocolTvlCaps: dataSources.protocolTvlCaps,
    diagnostics,
    stagedMergedCount,
    stagedSkippedCount,
    weakCoverageCoinsBeforeFallback,
    coverageRecoveredCoins,
    dsFallbackCoins,
    cgTickerFallbackCoins,
    dlYieldsAvailable: dataSources.dlYieldsAvailable,
    dlProtocolsAvailable: dataSources.dlProtocolsAvailable,
    criticalSourceFailures,
  });

  if (analysis.previousCoverage >= 10 && analysis.currentCoverage < analysis.minExpectedCoverage) {
    throw new Error(
      `[dex-liquidity] coverage guard tripped: current=${analysis.currentCoverage}, previous=${analysis.previousCoverage}, minExpected=${analysis.minExpectedCoverage}`,
    );
  }
  if (analysis.hardValueGuard) {
    throw new Error(
      `[dex-liquidity] value coverage guard tripped: currentGlobalTvl=${Math.round(analysis.currentGlobalTvl)}, ` +
      `previousGlobalTvl=${Math.round(analysis.previousGlobalTvl ?? 0)}, minExpectedGlobalTvl=${Math.round(analysis.minExpectedGlobalTvl ?? 0)}`,
    );
  }
  if (analysis.hardMajorCoverageGuard) {
    throw new Error(
      `[dex-liquidity] major coverage guard tripped: currentTop10CoveredTvl=${Math.round(analysis.currentTop10CoveredTvl)}, ` +
      `previousTop10CoveredTvl=${Math.round(analysis.previousTop10CoveredTvl)}`,
    );
  }
  throwIfAborted(signal);

  // 7. Persist primary tables. D1 in Workers rejects manual SQL transaction statements.
  const persistence = await runWithOverloadRetry(() => persistScores(db, metrics, scoreResults, globalAgg, syncStartSec))
    ?? { placeholderCount: 0, orphanRowsDeleted: 0, orphanCleanupFailed: false };
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
  await computeDexPrices(db, retainedPoolsByStablecoin, syncStartSec);

  // 8. Write daily historical snapshots
  const historicalSnapshot = await writeHistoricalSnapshots(db, scoreResults)
    ?? { snapshotRowsWritten: 0, skipped: false, writeFailed: false };

  // 9. Compute and persist depth stability (reuses data already loaded during scoring)
  await computeDepthStability(db, tvlStabilityMap);

  const degraded = isDexLiquidityDegraded({
    criticalSourceFailures,
    analysis,
    persistence,
    historicalSnapshot,
  });

  return {
    status: degraded ? "degraded" : "ok",
    itemCount: scoreResults.size,
    metadata: JSON.stringify(buildDexLiquidityCronMetadata({
      rowsRead: dataSources.pools.length,
      rowsWritten: scoreResults.size,
      stagedPoolsMerged: stagedMergedCount,
      stagedPoolsSkipped: stagedSkippedCount,
      stagedPoolsSkippedByExactIdentity: stagedSkippedByExactIdentityCount,
      stagedPoolsSkippedByUniqueDerivedIdentity: stagedSkippedByUniqueDerivedIdentityCount,
      sourceCoverage: analysis.sourceCoverage,
      challengerPublication,
      failedSources,
      fallbackSignals,
      persistence,
      historicalSnapshot,
    })),
  };
}
