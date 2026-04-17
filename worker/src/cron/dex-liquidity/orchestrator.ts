import type { CronResult } from "../../lib/cron-logger";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { LiquidityMetrics, LlamaPool } from "./types";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import { throwIfAborted } from "../../lib/abort";
import { loadPriceValidationReferences } from "../../lib/price-validation";
import { buildSymbolLookups, classifyPoolType } from "./pool-helpers";
import { buildChainAddressKey } from "./token-resolution";
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
  buildAuthoritativeStagedPoolConfirmationIndex,
  buildDexDirectApiFetchers,
  fetchSubgraphEnrichmentPhase,
  integrateDirectApiLiquidityPhase,
  loadTrackedStablecoinMcapMap,
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
import {
  analyzeDexLiquidityPostScoring,
  buildDexLiquidityCronMetadata,
  isDexLiquidityDegraded,
} from "./orchestrator-metadata";

const DEX_LIQUIDITY_PERSISTENCE_BLOCKING_FAILURES = new Set(["defillama-protocols"]);

export function filterPrimaryPoolsPreferDirectApi(
  pools: LlamaPool[],
  directApiPools: DexApiPool[],
  chainAddressToId?: Map<string, string>,
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

  const primaryIdentities = pools.map((pool) => {
    const tokenAddrs = pool.underlyingTokens ?? [];
    // buildChainAddressKey lowercases its chain argument, matching the way chainAddressToId
    // is keyed in pool-helpers.ts. Safe to pass pool.chain ("Ethereum" from DL) directly.
    const isStableHint =
      chainAddressToId != null &&
      tokenAddrs.length >= 2 &&
      tokenAddrs.every((addr) => chainAddressToId.has(buildChainAddressKey(pool.chain, addr)));
    return buildPoolIdentity({
      chain: pool.chain,
      protocol: pool.project,
      poolAddressOrId: pool.pool,
      tokenAddresses: tokenAddrs,
      poolType: classifyPoolType(pool.project),
      isStable: pool.stablecoin,
      isStableHint,
    });
  });
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
        derived: identity.derivedMatchKey ? (primaryIdentityCounts.derived.get(identity.derivedMatchKey) ?? 0) : 0,
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
  const ctx: DexLiquidityRunContext = {
    db,
    graphApiKey,
    signal,
    coingeckoApiKey,
    chainRpcs,
    syncStartSec: Math.floor(Date.now() / 1000),
  };

  const sourceState = await loadDexLiquiditySourceState(ctx);
  const poolState = await buildDexLiquidityPoolState(ctx, sourceState);
  const scoreState = await scoreDexLiquidityPoolState(ctx, sourceState, poolState);
  const persistenceState = await persistDexLiquidityScoreState(ctx, sourceState, poolState, scoreState);
  return buildDexLiquidityCronResult(sourceState, poolState, scoreState, persistenceState);
}

interface DexLiquidityRunContext {
  db: D1Database;
  graphApiKey: string | null;
  syncStartSec: number;
  signal?: AbortSignal;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

type DexLiquidityDataSources = NonNullable<Awaited<ReturnType<typeof fetchDataSources>>>;
type DexLiquidityLookups = ReturnType<typeof buildSymbolLookups>;
type DexLiquiditySubgraphEnrichment = Awaited<ReturnType<typeof fetchSubgraphEnrichmentPhase>>;
type DexLiquidityDirectApiPhase = Awaited<ReturnType<typeof runDirectApiFetchPhase>>;
type DexLiquidityFallbackPhase = Awaited<ReturnType<typeof runFallbackCrawlerPhase>>;
type DexLiquidityAnalysis = Awaited<ReturnType<typeof analyzeDexLiquidityPostScoring>>;
type DexLiquidityPersistence = NonNullable<Awaited<ReturnType<typeof persistScores>>>;
type DexLiquidityHistoricalSnapshot = NonNullable<Awaited<ReturnType<typeof writeHistoricalSnapshots>>>;

interface DexLiquiditySourceState {
  validationReferences: Awaited<ReturnType<typeof loadPriceValidationReferences>>;
  stablecoinPriceById: Awaited<ReturnType<typeof loadTrackedStablecoinPriceMap>>;
  stablecoinMcapById: Awaited<ReturnType<typeof loadTrackedStablecoinMcapMap>>;
  dataSources: DexLiquidityDataSources;
  lookups: DexLiquidityLookups;
  curvePoolMap: Awaited<ReturnType<typeof buildCurveLookups>>["curvePoolMap"];
  priceObservations: Awaited<ReturnType<typeof buildCurveLookups>>["priceObservations"];
  subgraphEnrichment: DexLiquiditySubgraphEnrichment;
  directApiPhase: DexLiquidityDirectApiPhase;
  directApiPools: DexApiPool[];
  authoritativeConfirmation: ReturnType<typeof buildAuthoritativeStagedPoolConfirmationIndex>;
  failedSources: string[];
  criticalSourceFailures: string[];
  fallbackSignals: string[];
}

interface DexLiquidityPoolState {
  fallback: DexLiquidityFallbackPhase;
  metrics: Map<string, LiquidityMetrics>;
  knownPoolIndex: ReturnType<typeof buildKnownPoolAddresses>;
  stagedMergedCount: number;
  stagedSkippedCount: number;
  stagedSkippedByExactIdentityCount: number;
  stagedSkippedByUniqueDerivedIdentityCount: number;
  stagedSkippedByOptionalWildcardIdentityCount: number;
  stagedSkippedByAuthoritativeProtocolCount: number;
}

interface DexLiquidityScoreState {
  scoreResults: Awaited<ReturnType<typeof computeStablecoinScores>>["scores"];
  globalAgg: Awaited<ReturnType<typeof computeStablecoinScores>>["globalAgg"];
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>;
  tvlStabilityMap: Map<string, number>;
  diagnostics: Awaited<ReturnType<typeof computeStablecoinScores>>["diagnostics"];
  analysis: DexLiquidityAnalysis;
}

interface DexLiquidityPersistenceState {
  persistence: DexLiquidityPersistence;
  challengerPublication: Awaited<ReturnType<typeof publishDexPriceChallengerSnapshots>>;
  historicalSnapshot: DexLiquidityHistoricalSnapshot;
}

function getPersistenceSkipReason(criticalSourceFailures: string[]): string | null {
  for (const source of criticalSourceFailures) {
    if (DEX_LIQUIDITY_PERSISTENCE_BLOCKING_FAILURES.has(source)) {
      return `${source}-unavailable`;
    }
  }
  return null;
}

async function loadDexLiquiditySourceState(ctx: DexLiquidityRunContext): Promise<DexLiquiditySourceState> {
  const failedSources: string[] = [];
  const criticalSourceFailures: string[] = [];
  const fallbackSignals: string[] = [];
  console.log(`[dex-liquidity] Starting sync`);
  throwIfAborted(ctx.signal);

  const validationReferences = await loadPriceValidationReferences(ctx.db);
  const stablecoinPriceById = await loadTrackedStablecoinPriceMap(ctx.db, ctx.syncStartSec);
  const stablecoinMcapById = await loadTrackedStablecoinMcapMap(ctx.db);

  const dataSources = await fetchDataSources(ctx.graphApiKey, ctx.db, ctx.signal);
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

  const lookups = buildSymbolLookups();
  const { curvePoolMap, priceObservations } = await buildCurveLookups(
    dataSources.curveResponses,
    lookups.symbolToIds,
    lookups.symbolToChainScopedIds,
    lookups.chainAddressToId,
    validationReferences,
  );

  const directApiFetchers = buildDexDirectApiFetchers({
    graphApiKey: ctx.graphApiKey,
    chainAddressToId: lookups.chainAddressToId,
    symbolToChainScopedIds: lookups.symbolToChainScopedIds,
    stablecoinPriceById,
    chainRpcs: ctx.chainRpcs,
  });
  const subgraphEnrichment = await fetchSubgraphEnrichmentPhase({
    graphApiKey: ctx.graphApiKey,
    symbolToIds: lookups.symbolToIds,
    symbolToChainScopedIds: lookups.symbolToChainScopedIds,
    chainAddressToId: lookups.chainAddressToId,
    signal: ctx.signal,
    validationReferences,
  });
  failedSources.push(...subgraphEnrichment.failedSources);

  const directApiPhase = await runDirectApiFetchPhase(ctx.db, directApiFetchers, ctx.signal);
  failedSources.push(...directApiPhase.failedSources);
  fallbackSignals.push(...directApiPhase.fallbackSignals);
  const authoritativeConfirmation = buildAuthoritativeStagedPoolConfirmationIndex(directApiPhase.results);

  mergeDexPriceObservationMap(priceObservations, subgraphEnrichment.uniV3PriceObs);
  mergeDexPriceObservationMap(priceObservations, subgraphEnrichment.aerodromePriceObs);
  console.log(`[dex-liquidity] Total: ${priceObservations.size} coins with price observations across all sources`);

  return {
    validationReferences,
    stablecoinPriceById,
    stablecoinMcapById,
    dataSources,
    lookups,
    curvePoolMap,
    priceObservations,
    subgraphEnrichment,
    directApiPhase,
    directApiPools: directApiPhase.results.flatMap((entry) => entry.result.pools),
    authoritativeConfirmation,
    failedSources,
    criticalSourceFailures,
    fallbackSignals,
  };
}

async function buildDexLiquidityPoolState(
  ctx: DexLiquidityRunContext,
  sourceState: DexLiquiditySourceState,
): Promise<DexLiquidityPoolState> {
  const {
    filteredPools: preferredPrimaryPools,
    skippedByExactIdentity: primarySkippedByDirectApiExactIdentity,
    skippedByUniqueDerivedIdentity: primarySkippedByDirectApiDerivedIdentity,
    skippedByOptionalWildcardIdentity: primarySkippedByDirectApiWildcardIdentity,
  } = filterPrimaryPoolsPreferDirectApi(sourceState.dataSources.pools, sourceState.directApiPools, sourceState.lookups.chainAddressToId);
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

  const knownPoolIndex = buildKnownPoolAddresses(
    preferredPrimaryPools,
    sourceState.dataSources.dexProjects,
    sourceState.curvePoolMap,
    sourceState.subgraphEnrichment.uniV3PoolFees,
    sourceState.subgraphEnrichment.aerodromeIsStable,
  );

  const metrics = processPoolMetrics(
    preferredPrimaryPools,
    sourceState.dataSources.dexProjects,
    sourceState.lookups.symbolToIds,
    sourceState.lookups.symbolToChainScopedIds,
    sourceState.lookups.addressToId,
    sourceState.lookups.chainAddressToId,
    sourceState.curvePoolMap,
    sourceState.subgraphEnrichment.uniV3PoolFees,
    sourceState.subgraphEnrichment.uniV3SymbolFees,
    sourceState.subgraphEnrichment.aerodromeIsStable,
  );
  integrateDirectApiLiquidityPhase({
    directApiPools: sourceState.directApiPools,
    knownPoolIndex,
    contractMetaByChainAddress: sourceState.lookups.contractMetaByChainAddress,
    metrics,
    priceObservations: sourceState.priceObservations,
    chainAddressToId: sourceState.lookups.chainAddressToId,
    symbolToChainScopedIds: sourceState.lookups.symbolToChainScopedIds,
    symbolToIds: sourceState.lookups.symbolToIds,
    validationReferences: sourceState.validationReferences,
    stablecoinPriceById: sourceState.stablecoinPriceById,
  });

  const staged = await mergeStagedPools(
    ctx.db,
    metrics,
    knownPoolIndex,
    ctx.syncStartSec,
    sourceState.validationReferences,
    sourceState.authoritativeConfirmation,
  );
  mergeDexPriceObservationMap(sourceState.priceObservations, staged.priceObservations);

  const fallback = await runFallbackCrawlerPhase({
    db: ctx.db,
    metrics,
    priceObservations: sourceState.priceObservations,
    knownPoolIndex,
    signal: ctx.signal,
    validationReferences: sourceState.validationReferences,
    failedSources: sourceState.failedSources,
    coingeckoApiKey: ctx.coingeckoApiKey,
  });

  return {
    fallback,
    metrics,
    knownPoolIndex,
    stagedMergedCount: staged.mergedCount,
    stagedSkippedCount: staged.skippedCount,
    stagedSkippedByExactIdentityCount: staged.skippedByExactIdentityCount,
    stagedSkippedByUniqueDerivedIdentityCount: staged.skippedByUniqueDerivedIdentityCount,
    stagedSkippedByOptionalWildcardIdentityCount: staged.skippedByOptionalWildcardIdentityCount,
    stagedSkippedByAuthoritativeProtocolCount: staged.skippedByAuthoritativeProtocolCount,
  };
}

async function scoreDexLiquidityPoolState(
  ctx: DexLiquidityRunContext,
  sourceState: DexLiquiditySourceState,
  poolState: DexLiquidityPoolState,
): Promise<DexLiquidityScoreState> {
  const {
    scores: scoreResults,
    globalAgg,
    retainedPoolsByStablecoin = new Map<string, LiquidityMetrics["topPools"]>(),
    tvlStabilityMap = new Map<string, number>(),
    diagnostics,
  } = await computeStablecoinScores(
    ctx.db,
    poolState.metrics,
    sourceState.dataSources.protocolTvlCaps,
    sourceState.stablecoinMcapById,
  );
  const analysis = await analyzeDexLiquidityPostScoring({
    db: ctx.db,
    scoreResults,
    globalAgg,
    retainedPoolsByStablecoin,
    priceObservations: sourceState.priceObservations,
    protocolTvlCaps: sourceState.dataSources.protocolTvlCaps,
    diagnostics,
    stagedMergedCount: poolState.stagedMergedCount,
    stagedSkippedCount: poolState.stagedSkippedCount,
    weakCoverageCoinsBeforeFallback: poolState.fallback.weakCoverageCoinsBeforeFallback,
    coverageRecoveredCoins: poolState.fallback.coverageRecoveredCoins,
    dsFallbackCoins: poolState.fallback.dsFallbackCoins,
    cgTickerFallbackCoins: poolState.fallback.cgTickerFallbackCoins,
    directCexOrderbookDepth: poolState.fallback.directCexOrderbookDepth,
    dlYieldsAvailable: sourceState.dataSources.dlYieldsAvailable,
    dlProtocolsAvailable: sourceState.dataSources.dlProtocolsAvailable,
    criticalSourceFailures: sourceState.criticalSourceFailures,
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
  throwIfAborted(ctx.signal);

  return {
    scoreResults,
    globalAgg,
    retainedPoolsByStablecoin,
    tvlStabilityMap,
    diagnostics,
    analysis,
  };
}

async function persistDexLiquidityScoreState(
  ctx: DexLiquidityRunContext,
  sourceState: DexLiquiditySourceState,
  poolState: DexLiquidityPoolState,
  scoreState: DexLiquidityScoreState,
): Promise<DexLiquidityPersistenceState> {
  const skippedReason = getPersistenceSkipReason(sourceState.criticalSourceFailures);
  if (skippedReason) {
    console.warn(`[dex-liquidity] Skipping persistence because ${skippedReason}`);
    return {
      persistence: {
        placeholderCount: 0,
        orphanRowsDeleted: 0,
        orphanCleanupFailed: false,
        skipped: true,
        skippedReason,
      },
      challengerPublication: {
        publishedStablecoins: 0,
        skippedStablecoins: scoreState.retainedPoolsByStablecoin.size,
        missingTables: false,
      },
      historicalSnapshot: {
        snapshotRowsWritten: 0,
        skipped: true,
        writeFailed: false,
      },
    };
  }

  const persistence = (await runWithOverloadRetry(() =>
    persistScores(ctx.db, poolState.metrics, scoreState.scoreResults, scoreState.globalAgg, ctx.syncStartSec),
  )) ?? { placeholderCount: 0, orphanRowsDeleted: 0, orphanCleanupFailed: false };
  const sourceCoverageCompleteByStablecoin = new Map<string, boolean>(
    ACTIVE_STABLECOINS.map((meta) => {
      const retainedPools = scoreState.retainedPoolsByStablecoin.get(meta.id) ?? [];
      const hasPublishedRows = retainedPools.some(
        (pool) =>
          Number.isFinite(pool.price) &&
          (pool.price ?? 0) > 0 &&
          Number.isFinite(pool.tvlUsd) &&
          pool.tvlUsd >= POOL_CHALLENGE_MIN_TVL,
      );
      return [meta.id, sourceState.criticalSourceFailures.length === 0 || hasPublishedRows];
    }),
  );
  const challengerPublication = await publishDexPriceChallengerSnapshots(ctx.db, {
    snapshotAt: ctx.syncStartSec,
    retainedPoolsByStablecoin: scoreState.retainedPoolsByStablecoin,
    sourceCoverageCompleteByStablecoin,
    minPoolTvlUsd: POOL_CHALLENGE_MIN_TVL,
  });
  await computeDexPrices(ctx.db, scoreState.retainedPoolsByStablecoin, ctx.syncStartSec, sourceState.validationReferences);

  const historicalSnapshot = (await writeHistoricalSnapshots(ctx.db, scoreState.scoreResults)) ?? {
    snapshotRowsWritten: 0,
    skipped: false,
    writeFailed: false,
  };

  await computeDepthStability(ctx.db, scoreState.tvlStabilityMap);

  return {
    persistence,
    challengerPublication,
    historicalSnapshot,
  };
}

function buildDexLiquidityCronResult(
  sourceState: DexLiquiditySourceState,
  poolState: DexLiquidityPoolState,
  scoreState: DexLiquidityScoreState,
  persistenceState: DexLiquidityPersistenceState,
): CronResult {
  const degraded = isDexLiquidityDegraded({
    criticalSourceFailures: sourceState.criticalSourceFailures,
    analysis: scoreState.analysis,
    persistence: persistenceState.persistence,
    historicalSnapshot: persistenceState.historicalSnapshot,
  });

  return {
    status: degraded ? "degraded" : "ok",
    itemCount: scoreState.scoreResults.size,
    metadata: JSON.stringify(
      buildDexLiquidityCronMetadata({
        rowsRead: sourceState.dataSources.pools.length,
        rowsWritten: persistenceState.persistence.skipped ? 0 : scoreState.scoreResults.size,
        stagedPoolsMerged: poolState.stagedMergedCount,
        stagedPoolsSkipped: poolState.stagedSkippedCount,
        stagedPoolsSkippedByExactIdentity: poolState.stagedSkippedByExactIdentityCount,
        stagedPoolsSkippedByUniqueDerivedIdentity: poolState.stagedSkippedByUniqueDerivedIdentityCount,
        stagedPoolsSkippedByOptionalWildcardIdentity: poolState.stagedSkippedByOptionalWildcardIdentityCount,
        stagedPoolsSkippedByAuthoritativeProtocol: poolState.stagedSkippedByAuthoritativeProtocolCount,
        sourceCoverage: scoreState.analysis.sourceCoverage,
        challengerPublication: persistenceState.challengerPublication,
        failedSources: sourceState.failedSources,
        fallbackSignals: sourceState.fallbackSignals,
        persistence: persistenceState.persistence,
        historicalSnapshot: persistenceState.historicalSnapshot,
      }),
    ),
  };
}
