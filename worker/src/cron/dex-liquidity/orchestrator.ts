import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEventArgs } from "../../lib/structured-log";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { createCronResult } from "../../lib/cron-result";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { LiquidityFallbackCounters, LiquidityMetrics, LlamaPool } from "./types";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { throwIfAborted } from "../../lib/abort";
import { loadPriceValidationReferences } from "../../lib/price-validation";
import { buildSymbolLookups, classifyPoolType, initLiquidityFallbackCounters } from "./pool-helpers";
import { buildChainAddressKey } from "./token-resolution";
import {
  fetchDataSources,
  buildCurveLookups,
  buildKnownPoolAddresses,
  type PrimaryPoolCompactionResult,
} from "./fetch-primary";
import { publishDexPriceChallengerSnapshots } from "./challenger-publish";
import {
  POOL_REJECTION_MATERIAL_TVL_USD,
  hasMaterialPoolRejections,
  processPoolMetrics,
} from "./process-pools";
import { mergeStagedPools } from "./staging-merge";
import {
  computeStablecoinScores,
  computeDepthStability,
  computeDexPrices,
  loadCurrentDexScoringGenerationId,
  type MeasuredTargetPublicationMode,
} from "./scoring";
import { persistScores, writeHistoricalSnapshots } from "./persistence";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { isPreferredDirectApiPool, type DexApiPool } from "../../lib/dex-api-common";
import { POOL_CHALLENGE_MIN_TVL } from "../../lib/constants";
import { buildDirectApiPoolIdentity } from "./direct-source-helpers";
import {
  buildAuthoritativeStagedPoolConfirmationIndex,
} from "./orchestrator-phases/authoritative";
import {
  buildDexDirectApiFetchers,
  integrateDirectApiLiquidityPhase,
  runDirectApiFetchPhase,
  type DirectApiIntegrationResult,
  compactDirectApiFetchPhasePools,
  type DirectApiPoolCompactionCounts,
} from "./orchestrator-phases/direct-api";
import { fetchSubgraphEnrichmentPhase } from "./orchestrator-phases/subgraph-enrichment";
import {
  fetchDirectCexOrderbookDepthTelemetry,
  runFallbackCrawlerPhase,
} from "./orchestrator-phases/fallback";
import { loadTrackedStablecoinMaps } from "./orchestrator-phases/lookups";
import { mergeDexPriceObservationMap } from "./subgraph-helpers";
import {
  buildPoolIdentity,
  clearKnownPoolIdentityIndex,
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
import {
  buildPancakeMeasuredExecutionTargets,
  buildSlipstreamMeasuredExecutionTargets,
  buildUniV3DirectMeasuredExecutionTargets,
} from "../measured-execution/inventory";
import { enrichEvmV2ExecutionModels } from "./constant-product-v2";
import { enrichCurveStableswapFactoryExecutionModels } from "./curve-stableswap-factory";
import { enrichCurveStableswapRateInputExecutionModels } from "./curve-stableswap-rates";
import {
  loadDexLiquidityScoringStage,
  loadDexLiquidityScoringStageWhenReady,
  markDexLiquidityScoringStageConsumed,
  persistDexLiquidityScoringStage,
} from "./scoring-stage";
import type {
  DexLiquidityPoolState,
  DexLiquidityScoringSourceState,
} from "./scoring-stage-contract";
import { createDexProgressReporter, type DexProgressReporter } from "./orchestrator-progress";

const DEX_LIQUIDITY_PERSISTENCE_BLOCKING_FAILURES = new Set(["defillama-yields", "defillama-protocols"]);

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
    registerKnownPoolIdentity(directApiKnown, buildDirectApiPoolIdentity(pool, chainAddressToId));
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
      poolType: classifyPoolType(pool.project, pool.poolMeta),
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

  clearKnownPoolIdentityIndex(directApiKnown);
  primaryIdentities.length = 0;
  primaryIdentityCounts.derived.clear();
  primaryIdentityCounts.wildcard.clear();

  return {
    filteredPools,
    skippedByExactIdentity,
    skippedByUniqueDerivedIdentity,
    skippedByOptionalWildcardIdentity,
  };
}

async function buildDexLiquidityScoringStageState(
  ctx: DexLiquidityRunContext,
): Promise<{
  scoringSourceState: DexLiquidityScoringSourceState;
  poolState: DexLiquidityPoolState;
}> {
  const sourceState = await loadDexLiquiditySourceState(ctx);
  const poolState = await buildDexLiquidityPoolState(ctx, sourceState);
  return {
    scoringSourceState: buildDexLiquidityScoringSourceState(sourceState),
    poolState,
  };
}

export async function stageDexLiquidityScoring(
  db: D1Database,
  graphApiKey: string | null,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  reportProgress?: CronProgressReporter,
  sourceSlotStartedAt?: number,
): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);
  const fallbackCounters = initLiquidityFallbackCounters();
  const reportDexProgress = createDexProgressReporter(reportProgress, {
    totalStablecoins: ACTIVE_STABLECOINS.length,
  });
  const ctx: DexLiquidityRunContext = {
    db,
    graphApiKey,
    signal,
    coingeckoApiKey,
    chainRpcs,
    reportProgress,
    reportDexProgress,
    syncStartSec,
    fallbackCounters,
  };
  const { scoringSourceState, poolState } = await buildDexLiquidityScoringStageState(ctx);
  const itemCount = poolState.metrics.size;
  const rejectedPoolCount = poolState.poolRejections.reduce(
    (sum, rejection) => sum + rejection.count,
    0,
  );
  const rejectedPoolTvlUsd = poolState.poolRejections.reduce(
    (sum, rejection) => sum + rejection.tvlUsd,
    0,
  );
  const materialPoolRejections = hasMaterialPoolRejections(
    poolState.poolRejections,
  );
  const stored = await persistDexLiquidityScoringStage(
    db,
    {
      sourceSlotStartedAt: sourceSlotStartedAt ?? syncStartSec,
      syncStartSec,
      sourceState: scoringSourceState,
      poolState,
      onChunkBatchPersisted: async ({ chunkCount, recordCount, payloadBytes }) => {
        await ctx.reportDexProgress("scoring-stage-persistence", {
          message: "Persisting bounded DEX scoring-stage chunks", providerFamily: "d1", done: recordCount, total: undefined,
          counts: { chunkCount, recordCount, payloadBytes },
        });
      },
    },
    signal,
  );

  return {
    status: scoringSourceState.criticalSourceFailures.length > 0 ||
      materialPoolRejections ||
      stored.retention.error
      ? "degraded"
      : "ok",
    itemCount,
    metadata: JSON.stringify({
      generationId: stored.generationId,
      sourceSlotStartedAt: stored.sourceSlotStartedAt,
      syncStartSec,
      chunkCount: stored.chunkCount,
      recordCount: stored.recordCount,
      payloadBytes: stored.payloadBytes,
      retention: stored.retention,
      rowsRead: scoringSourceState.primaryRawPoolCount,
      failedSources: scoringSourceState.failedSources,
      fallbackSignals: scoringSourceState.fallbackSignals,
      poolRejections: poolState.poolRejections,
      poolRejectionMateriality: {
        thresholdTvlUsd: POOL_REJECTION_MATERIAL_TVL_USD,
        rejectedPoolCount,
        rejectedPoolTvlUsd,
        material: materialPoolRejections,
      },
      fallbackCounters,
    }),
  };
}

export async function consumeDexLiquidityScoringStage(
  db: D1Database,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
  consumerSlotStartedAt?: number,
  options: {
    publishLiquidity?: boolean;
    publishShadowTargets?: boolean;
    stageReadyDeadlineMs?: number;
  } = {},
): Promise<CronResult> {
  const expectedSourceSlotStartedAt =
    consumerSlotStartedAt == null ? undefined : consumerSlotStartedAt - 6 * 60;
  const staged = expectedSourceSlotStartedAt != null && options.stageReadyDeadlineMs != null
    ? await loadDexLiquidityScoringStageWhenReady(
        db,
        {
          expectedSourceSlotStartedAt,
          readyDeadlineMs: options.stageReadyDeadlineMs,
        },
        signal,
      )
    : await loadDexLiquidityScoringStage(
        db,
        {
          nowSec: Math.floor(Date.now() / 1000),
          expectedSourceSlotStartedAt,
        },
        signal,
      );
  const ctx: DexLiquidityRunContext = {
    db,
    graphApiKey: null,
    signal,
    reportProgress,
    reportDexProgress: createDexProgressReporter(reportProgress, {
      totalStablecoins: ACTIVE_STABLECOINS.length,
    }),
    syncStartSec: staged.syncStartSec,
  };
  const currentGenerationId = await loadCurrentDexScoringGenerationId(db, signal);
  const publishLiquidity = options.publishLiquidity !== false || currentGenerationId === null;
  const measuredTargetPublicationMode: MeasuredTargetPublicationMode = publishLiquidity
    ? options.publishShadowTargets === true
      ? "active-and-shadow"
      : "active"
    : "none";
  const scoreState = await scoreDexLiquidityPoolState(
    ctx,
    staged.sourceState,
    staged.poolState,
    measuredTargetPublicationMode,
  );
  const persistenceState = await persistDexLiquidityScoreState(
    ctx,
    staged.sourceState,
    staged.poolState,
    scoreState,
    { publishLiquidity, currentGenerationId },
  );
  const result = buildDexLiquidityCronResult(
    staged.sourceState,
    staged.poolState,
    scoreState,
    persistenceState,
  );
  try {
    await markDexLiquidityScoringStageConsumed(db, staged.generationId, Math.floor(Date.now() / 1000), signal);
  } catch (error) {
    logWorkerEventArgs("handler", "warn", JSON.stringify({
      scope: "dex-liquidity",
      message: "Failed to mark scoring stage consumed after publication",
      error: toErrorMessage(error),
    }));
  }
  return result;
}

export async function reuseCurrentDexLiquidityScoringGeneration(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  const generationId = await loadCurrentDexScoringGenerationId(db, signal);
  if (!generationId) {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "current-dex-liquidity-generation-missing", persistence: { generationId: null, skipped: true, skippedReason: "hourly-price-not-due" } },
      productivity: { productive: false, reason: "current-dex-liquidity-generation-missing" },
    });
  }
  return createCronResult({
    status: "skipped_neutral",
    itemCount: 0,
    metadata: { cadenceReuse: true, persistence: { generationId, skipped: false, skippedReason: "liquidity-cadence-reuse" } },
    productivity: { productive: false, reason: "liquidity-cadence-reuse" },
  });
}

export interface DexLiquidityRunContext {
  db: D1Database;
  graphApiKey: string | null;
  syncStartSec: number;
  signal?: AbortSignal;
  coingeckoApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
  reportProgress?: CronProgressReporter;
  reportDexProgress: DexProgressReporter;
  /** Report-only fallback/default counters shared across the run's pool-intake phases. */
  fallbackCounters?: LiquidityFallbackCounters;
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
  stablecoinPriceById: Awaited<ReturnType<typeof loadTrackedStablecoinMaps>>["stablecoinPriceById"];
  stablecoinMcapById: Awaited<ReturnType<typeof loadTrackedStablecoinMaps>>["stablecoinMcapById"];
  dataSources: DexLiquidityDataSources;
  lookups: DexLiquidityLookups;
  curvePoolMap: Awaited<ReturnType<typeof buildCurveLookups>>["curvePoolMap"];
  curvePoolCandidatesByFingerprint: Awaited<
    ReturnType<typeof buildCurveLookups>
  >["curvePoolCandidatesByFingerprint"];
  priceObservations: Awaited<ReturnType<typeof buildCurveLookups>>["priceObservations"];
  subgraphEnrichment: DexLiquiditySubgraphEnrichment;
  directApiPhase: DexLiquidityDirectApiPhase;
  directApiPools: DexApiPool[];
  pancakeMeasuredExecutionTargets: ReturnType<typeof buildPancakeMeasuredExecutionTargets>;
  slipstreamMeasuredExecutionTargets: ReturnType<typeof buildSlipstreamMeasuredExecutionTargets>;
  primaryPoolCounts: PrimaryPoolCompactionResult;
  directApiPoolCounts: DirectApiPoolCompactionCounts;
  authoritativeConfirmation: ReturnType<typeof buildAuthoritativeStagedPoolConfirmationIndex>;
  failedSources: string[];
  criticalSourceFailures: string[];
  fallbackSignals: string[];
  directCexOrderbookDepth: DexLiquidityFallbackPhase["directCexOrderbookDepth"];
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
  dexPriceDiagnostics: Awaited<ReturnType<typeof computeDexPrices>>;
  historicalSnapshot: DexLiquidityHistoricalSnapshot;
}

function buildDexLiquidityScoringSourceState(
  sourceState: DexLiquiditySourceState,
): DexLiquidityScoringSourceState {
  return {
    validationReferences: sourceState.validationReferences,
    stablecoinPriceById: sourceState.stablecoinPriceById,
    stablecoinMcapById: sourceState.stablecoinMcapById,
    protocolTvlCaps: sourceState.dataSources.protocolTvlCaps,
    priceObservations: sourceState.priceObservations,
    dlYieldsAvailable: sourceState.dataSources.dlYieldsAvailable,
    dlProtocolsAvailable: sourceState.dataSources.dlProtocolsAvailable,
    primaryRawPoolCount: sourceState.primaryPoolCounts.rawPoolCount,
    failedSources: sourceState.failedSources,
    criticalSourceFailures: sourceState.criticalSourceFailures,
    fallbackSignals: sourceState.fallbackSignals,
    directApiSourceSummary: {
      circuitEvents: sourceState.directApiPhase.circuitEvents,
      sourceWarnings: sourceState.directApiPhase.sourceWarnings,
      pagination: sourceState.directApiPhase.results.flatMap((entry) =>
        entry.result.pagination ? [{ source: entry.circuitKey, ...entry.result.pagination }] : [],
      ),
    },
  };
}

function getPersistenceSkipReason(criticalSourceFailures: string[]): string | null {
  for (const source of criticalSourceFailures) {
    if (DEX_LIQUIDITY_PERSISTENCE_BLOCKING_FAILURES.has(source)) {
      return `${source}-unavailable`;
    }
  }
  return null;
}

function logDirectApiSourceSummary(
  integration: DirectApiIntegrationResult,
  circuitEvents: DexLiquidityDirectApiPhase["circuitEvents"],
): void {
  if (
    Object.keys(integration.acceptedByProtocolChain).length === 0 &&
    Object.keys(integration.excludedByReason).length === 0 &&
    circuitEvents.length === 0
  ) {
    return;
  }

  logWorkerEventArgs("handler", "info",
    `[dex-liquidity] direct-api source summary ${JSON.stringify({
      acceptedByProtocolChain: integration.acceptedByProtocolChain,
      excludedByReason: integration.excludedByReason,
      circuitEvents,
    })}`,
  );
}

async function loadDexLiquiditySourceState(ctx: DexLiquidityRunContext): Promise<DexLiquiditySourceState> {
  const failedSources: string[] = [];
  const criticalSourceFailures: string[] = [];
  const fallbackSignals: string[] = [];
  logWorkerEventArgs("handler", "info", `[dex-liquidity] Starting sync`);
  throwIfAborted(ctx.signal);
  await ctx.reportDexProgress("source-loading", {
    message: "Loading DEX liquidity source references", providerFamily: "dex-liquidity",
    counts: { activeStablecoins: ACTIVE_STABLECOINS.length },
  });

  const validationReferences = await loadPriceValidationReferences(ctx.db);
  const { stablecoinPriceById, stablecoinMcapById } = await loadTrackedStablecoinMaps(ctx.db, ctx.syncStartSec);
  const lookups = buildSymbolLookups();
  // Coinbase level-2 books can be large even though only a compact summary is
  // retained. Fetch them before any DEX pool graph exists so transient response
  // parsing cannot collide with the scoring lane's memory peak.
  const directCexOrderbookDepth = await fetchDirectCexOrderbookDepthTelemetry({
    signal: ctx.signal,
    failedSources,
  });

  const directApiFetchers = buildDexDirectApiFetchers({
    db: ctx.db,
    graphApiKey: ctx.graphApiKey,
    chainAddressToId: lookups.chainAddressToId,
    symbolToChainScopedIds: lookups.symbolToChainScopedIds,
    stablecoinPriceById,
    chainRpcs: ctx.chainRpcs,
    fallbackCounters: ctx.fallbackCounters,
  });
  await ctx.reportDexProgress("direct-api-fetch", {
    message: "Fetching protocol-native DEX liquidity", providerFamily: "protocol-native-dex", total: directApiFetchers.length,
    metadata: { providerFamilies: directApiFetchers.map((fetcher) => fetcher.normalizedProtocol) },
    counts: { sourceFamilies: directApiFetchers.length },
  });
  let directApiPhase = await runDirectApiFetchPhase(ctx.db, directApiFetchers, ctx.signal, lookups);
  const authoritativeConfirmation = buildAuthoritativeStagedPoolConfirmationIndex(directApiPhase.results);
  const compactedDirectApi = compactDirectApiFetchPhasePools(directApiPhase, lookups);
  directApiPhase = compactedDirectApi.phase;
  await ctx.reportDexProgress("direct-api-fetch-complete", {
    message: "Completed protocol-native DEX liquidity fetch", providerFamily: "protocol-native-dex",
    done: directApiPhase.results.length, total: directApiFetchers.length,
    metadata: {
      providerFamilies: directApiPhase.results.map((entry) => entry.normalizedProtocol),
      failedSources: directApiPhase.failedSources,
      fallbackSignals: directApiPhase.fallbackSignals,
      sourceWarnings: directApiPhase.sourceWarnings,
    },
    counts: {
      sourceFamilies: directApiFetchers.length, directApiPools: compactedDirectApi.counts.rawPoolCount,
      directApiPoolsRetained: compactedDirectApi.counts.retainedPoolCount, directApiPoolsSkippedInvalidUnits: compactedDirectApi.counts.skippedInvalidUnitCount,
      directApiPoolsSkippedUntracked: compactedDirectApi.counts.skippedUntrackedCount, circuitEvents: directApiPhase.circuitEvents.length,
    },
  });

  const pancakeMeasuredExecutionTargets = buildPancakeMeasuredExecutionTargets({
    pools: compactedDirectApi.measuredExecutionPools,
    chainAddressToId: lookups.chainAddressToId,
    symbolToChainScopedIds: lookups.symbolToChainScopedIds,
    validationReferences,
    stablecoinPriceById,
    capturedAt: ctx.syncStartSec,
  });
  const slipstreamMeasuredExecutionTargets = buildSlipstreamMeasuredExecutionTargets({
    pools: compactedDirectApi.measuredExecutionPools,
    chainAddressToId: lookups.chainAddressToId,
    symbolToChainScopedIds: lookups.symbolToChainScopedIds,
    validationReferences,
    stablecoinPriceById,
    capturedAt: ctx.syncStartSec,
  });
  const uniswapV3BscShadowTargets = buildUniV3DirectMeasuredExecutionTargets({
    pools: compactedDirectApi.measuredExecutionPools,
    chainAddressToId: lookups.chainAddressToId,
    symbolToChainScopedIds: lookups.symbolToChainScopedIds,
    validationReferences,
    stablecoinPriceById,
    capturedAt: ctx.syncStartSec,
  });
  // The scoring-stage contract predates direct Uniswap targets and names this
  // generic EVM target accumulator after its first direct CL source. Target
  // adapter identity remains explicit, and the registry routes BSC Uniswap V3
  // into the separate shadow generation.
  for (const [key, target] of uniswapV3BscShadowTargets) {
    slipstreamMeasuredExecutionTargets.set(key, target);
  }
  uniswapV3BscShadowTargets.clear();

  // Keep the compact direct pool list needed for preference and integration,
  // but release provider-owned graphs before loading the larger primary sources.
  compactedDirectApi.measuredExecutionPools.length = 0;
  for (const entry of directApiPhase.results) {
    entry.result.pools = [];
    entry.authoritativeExactPoolKeys?.clear();
    delete entry.authoritativeExactPoolKeys;
    if (entry.poolCompaction) entry.poolCompaction.measuredExecutionPools = [];
  }
  directApiFetchers.length = 0;

  const dataSources = await fetchDataSources(ctx.graphApiKey, ctx.db, lookups, ctx.signal);
  if (!dataSources) {
    throw new Error("dex-liquidity: catastrophic source failure (DL yields + Curve unavailable)");
  }
  await ctx.reportDexProgress("primary-sources-loaded", {
    message: "Loaded DefiLlama and Curve liquidity sources", providerFamily: "defillama",
    done: dataSources.rawPoolCount, total: Math.max(dataSources.rawPoolCount, ACTIVE_STABLECOINS.length),
    metadata: {
      dlYieldsAvailable: dataSources.dlYieldsAvailable,
      dlProtocolsAvailable: dataSources.dlProtocolsAvailable,
    },
    counts: {
      defillamaPools: dataSources.rawPoolCount, curvePayloads: dataSources.curvePayloads.filter((payload) => payload != null).length,
      dexProjects: dataSources.dexProjects.size,
    },
  });
  if (!dataSources.dlYieldsAvailable) {
    logWorkerEventArgs("handler", "info", "[dex-liquidity] DL yields unavailable — pool coverage may be reduced");
    failedSources.push("defillama-yields");
    criticalSourceFailures.push("defillama-yields");
    fallbackSignals.push("dl-yields-unavailable");
  }
  if (!dataSources.dlProtocolsAvailable) {
    failedSources.push("defillama-protocols");
    criticalSourceFailures.push("defillama-protocols");
    fallbackSignals.push("dl-protocols-unavailable");
  }

  const primaryPoolCounts: PrimaryPoolCompactionResult = {
    pools: dataSources.pools,
    rawPoolCount: dataSources.rawPoolCount,
    retainedPoolCount: dataSources.pools.length,
    skippedUntrackedCount: dataSources.rawPoolCount - dataSources.pools.length,
  };
  const { curvePoolMap, curvePoolCandidatesByFingerprint, priceObservations } = await buildCurveLookups(
    dataSources.curvePayloads,
    lookups.symbolToIds,
    lookups.symbolToChainScopedIds,
    lookups.chainAddressToId,
    validationReferences,
  );
  // Downstream phases use only the derived maps, so release the raw response trees now.
  dataSources.curvePayloads.length = 0;

  await ctx.reportDexProgress("subgraph-enrichment", {
    message: "Fetching subgraph liquidity enrichment", providerFamily: "subgraph", total: 3,
    metadata: { providerFamilies: ["uniswap-v3", "uniswap-v4", "aerodrome"] },
    counts: { subgraphFamilies: 3 },
  });
  const subgraphEnrichment = await fetchSubgraphEnrichmentPhase({
    graphApiKey: ctx.graphApiKey,
    symbolToChainScopedIds: lookups.symbolToChainScopedIds,
    chainAddressToId: lookups.chainAddressToId,
    signal: ctx.signal,
    validationReferences,
  });
  failedSources.push(...subgraphEnrichment.failedSources);
  await ctx.reportDexProgress("subgraph-enrichment-complete", {
    message: "Completed subgraph enrichment", providerFamily: "subgraph",
    done: 3 - subgraphEnrichment.failedSources.length, total: 3,
    metadata: {
      providerFamilies: ["uniswap-v3", "uniswap-v4", "aerodrome"],
      failedSources: subgraphEnrichment.failedSources,
    },
    counts: {
      uniV3PriceObservations: subgraphEnrichment.uniV3PriceObs.size, uniswapV4ExecutionCandidateKeys: subgraphEnrichment.uniswapV4ExecutionCandidates.size,
      aerodromePriceObservations: subgraphEnrichment.aerodromePriceObs.size,
    },
  });

  // Preserve the established primary/subgraph/direct diagnostic ordering even
  // though direct sources now execute first to bound peak memory.
  failedSources.push(...directApiPhase.failedSources);
  fallbackSignals.push(...directApiPhase.fallbackSignals);

  mergeDexPriceObservationMap(priceObservations, subgraphEnrichment.uniV3PriceObs);
  mergeDexPriceObservationMap(priceObservations, subgraphEnrichment.aerodromePriceObs);
  logWorkerEventArgs("handler", "info", `[dex-liquidity] Total: ${priceObservations.size} coins with price observations across all sources`);

  return {
    validationReferences,
    stablecoinPriceById,
    stablecoinMcapById,
    dataSources,
    lookups,
    curvePoolMap,
    curvePoolCandidatesByFingerprint,
    priceObservations,
    subgraphEnrichment,
    directApiPhase,
    directApiPools: compactedDirectApi.pools,
    pancakeMeasuredExecutionTargets,
    slipstreamMeasuredExecutionTargets,
    primaryPoolCounts,
    directApiPoolCounts: compactedDirectApi.counts,
    authoritativeConfirmation,
    failedSources,
    criticalSourceFailures,
    fallbackSignals,
    directCexOrderbookDepth,
  };
}

async function buildDexLiquidityPoolState(
  ctx: DexLiquidityRunContext,
  sourceState: DexLiquiditySourceState,
): Promise<DexLiquidityPoolState> {
  await ctx.reportDexProgress("pool-processing", {
    message: "Merging primary, staged, direct, and fallback pools", providerFamily: "dex-liquidity",
    total: sourceState.primaryPoolCounts.rawPoolCount + sourceState.directApiPoolCounts.rawPoolCount,
    counts: {
      primaryPools: sourceState.primaryPoolCounts.rawPoolCount, primaryPoolsRetained: sourceState.primaryPoolCounts.retainedPoolCount,
      directApiPools: sourceState.directApiPoolCounts.rawPoolCount, directApiPoolsRetained: sourceState.directApiPoolCounts.retainedPoolCount,
    },
  });
  const primaryPreference = filterPrimaryPoolsPreferDirectApi(
    sourceState.dataSources.pools,
    sourceState.directApiPools,
    sourceState.lookups.chainAddressToId,
  );
  let preferredPrimaryPools = primaryPreference.filteredPools;
  const {
    skippedByExactIdentity: primarySkippedByDirectApiExactIdentity,
    skippedByUniqueDerivedIdentity: primarySkippedByDirectApiDerivedIdentity,
    skippedByOptionalWildcardIdentity: primarySkippedByDirectApiWildcardIdentity,
  } = primaryPreference;
  if (
    primarySkippedByDirectApiExactIdentity > 0 ||
    primarySkippedByDirectApiDerivedIdentity > 0 ||
    primarySkippedByDirectApiWildcardIdentity > 0
  ) {
    logWorkerEventArgs("handler", "info",
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

  const { metrics, rejections: poolRejections } = processPoolMetrics({
    pools: preferredPrimaryPools,
    dexProjects: sourceState.dataSources.dexProjects,
    symbolToChainScopedIds: sourceState.lookups.symbolToChainScopedIds,
    chainAddressToId: sourceState.lookups.chainAddressToId,
    curvePoolMap: sourceState.curvePoolMap,
    uniV3PoolFees: sourceState.subgraphEnrichment.uniV3PoolFees,
    uniV3SymbolFees: sourceState.subgraphEnrichment.uniV3SymbolFees,
    aerodromeIsStable: sourceState.subgraphEnrichment.aerodromeIsStable,
    uniV3ExecutionCandidates:
      sourceState.subgraphEnrichment.uniV3ExecutionCandidates,
    stablecoinPriceById: sourceState.stablecoinPriceById,
    measuredTargetCapturedAt: ctx.syncStartSec,
    validationReferences: sourceState.validationReferences,
    aerodromeV2ExecutionCandidates:
      sourceState.subgraphEnrichment.aerodromeV2ExecutionCandidates,
    curvePoolCandidatesByFingerprint:
      sourceState.curvePoolCandidatesByFingerprint,
    uniswapV4ExecutionCandidates:
      sourceState.subgraphEnrichment.uniswapV4ExecutionCandidates,
    fallbackCounters: ctx.fallbackCounters,
  });

  // Primary pools and display-only enrichment maps have been projected into
  // metrics and the identity index. Keep only the exact target candidates
  // through direct-pool integration, then release them below.
  preferredPrimaryPools = [];
  primaryPreference.filteredPools = [];
  sourceState.dataSources.pools = [];
  sourceState.primaryPoolCounts.pools = [];
  sourceState.dataSources.dexProjects = new Set();
  sourceState.curvePoolMap = new Map();
  sourceState.curvePoolCandidatesByFingerprint = new Map();
  sourceState.subgraphEnrichment.uniV3PoolFees = new Map();
  sourceState.subgraphEnrichment.uniV3SymbolFees = new Map();
  sourceState.subgraphEnrichment.uniV3PriceObs = new Map();
  sourceState.subgraphEnrichment.aerodromePriceObs = new Map();
  sourceState.subgraphEnrichment.aerodromeV2ExecutionCandidates = new Map();

  const directApiIntegration = await integrateDirectApiLiquidityPhase({
    db: ctx.db,
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
    executionTargetContext: {
      uniV3ExecutionCandidates:
        sourceState.subgraphEnrichment.uniV3ExecutionCandidates,
      uniswapV4ExecutionCandidates:
        sourceState.subgraphEnrichment.uniswapV4ExecutionCandidates,
      aerodromeIsStable: sourceState.subgraphEnrichment.aerodromeIsStable,
      measuredTargetCapturedAt: ctx.syncStartSec,
      contractMetaByChainAddress:
        sourceState.lookups.contractMetaByChainAddress,
    },
    preprocessedPoolCounts: sourceState.directApiPoolCounts,
    fallbackCounters: ctx.fallbackCounters,
  });
  logDirectApiSourceSummary(directApiIntegration, sourceState.directApiPhase.circuitEvents);

  // The compact direct pool list is no longer needed after integration.
  sourceState.directApiPools = [];
  sourceState.subgraphEnrichment.uniV3ExecutionCandidates = new Map();
  sourceState.subgraphEnrichment.uniswapV4ExecutionCandidates = new Map();
  sourceState.subgraphEnrichment.aerodromeIsStable = new Map();
  sourceState.lookups.symbolToIds = new Map();
  sourceState.lookups.symbolToChainScopedIds = new Map();
  sourceState.lookups.addressToId = new Map();

  await ctx.reportDexProgress("pool-processing-core-complete", {
    message: "Completed primary and direct pool integration", providerFamily: "dex-liquidity", done: metrics.size,
    counts: {
      metricRows: metrics.size, directApiAccepted: Object.values(directApiIntegration.acceptedByProtocolChain).reduce((sum, count) => sum + count, 0),
    },
  });

  const staged = await mergeStagedPools(
    ctx.db,
    metrics,
    knownPoolIndex,
    ctx.syncStartSec,
    sourceState.validationReferences,
    sourceState.authoritativeConfirmation,
    ctx.fallbackCounters,
  );
  mergeDexPriceObservationMap(sourceState.priceObservations, staged.priceObservations);
  staged.priceObservations.clear();
  await enrichEvmV2ExecutionModels({
    metrics,
    chainAddressToId: sourceState.lookups.chainAddressToId,
    contractMetaByChainAddress: sourceState.lookups.contractMetaByChainAddress,
    stablecoinPriceById: sourceState.stablecoinPriceById,
    chainRpcs: ctx.chainRpcs,
    signal: ctx.signal,
  });
  await enrichCurveStableswapRateInputExecutionModels({
    metrics,
    chainAddressToId: sourceState.lookups.chainAddressToId,
    chainRpcs: ctx.chainRpcs,
    signal: ctx.signal,
  });
  // Last of the three on-chain capture stages: it only touches Curve rows the
  // source-only join could not resolve at all, so it never competes with the
  // rate-bearing capture above for the same pool.
  await enrichCurveStableswapFactoryExecutionModels({
    metrics,
    chainAddressToId: sourceState.lookups.chainAddressToId,
    stablecoinPriceById: sourceState.stablecoinPriceById,
    chainRpcs: ctx.chainRpcs,
    signal: ctx.signal,
  });
  sourceState.lookups.chainAddressToId = new Map();
  sourceState.lookups.contractMetaByChainAddress = new Map();
  // Staged dedup is the final identity consumer. Release its multi-map index
  // before the optional telemetry await and the allocation-heavy scoring pass.
  clearKnownPoolIdentityIndex(knownPoolIndex);
  sourceState.authoritativeConfirmation = {
    enforcedChainsByProtocol: new Map(),
    confirmedExactKeysByProtocol: new Map(),
  };

  await ctx.reportDexProgress("pool-processing-staged-complete", {
    message: "Completed staged pool merge", providerFamily: "dex-liquidity",
    done: staged.mergedCount, total: staged.mergedCount + staged.skippedCount,
    counts: {
      stagedPoolsMerged: staged.mergedCount, stagedPoolsSkipped: staged.skippedCount,
    },
  });

  const fallback = await runFallbackCrawlerPhase({
    metrics,
    priceObservations: sourceState.priceObservations,
    directCexOrderbookDepth: sourceState.directCexOrderbookDepth,
  });
  await ctx.reportDexProgress("pool-processing-complete", {
    message: "Completed pool merge and bounded market telemetry", providerFamily: "dex-liquidity", done: metrics.size,
    counts: {
      metricRows: metrics.size, poolRejections: poolRejections.reduce((sum, rejection) => sum + rejection.count, 0),
      stagedPoolsMerged: staged.mergedCount, stagedPoolsSkipped: staged.skippedCount,
      directApiAccepted: Object.values(directApiIntegration.acceptedByProtocolChain).reduce((sum, count) => sum + count, 0),
      weakCoverageCoinsBeforeFallback: fallback.weakCoverageCoinsBeforeFallback,
    },
  });

  return {
    fallback,
    metrics,
    poolRejections,
    pancakeMeasuredExecutionTargets: sourceState.pancakeMeasuredExecutionTargets,
    slipstreamMeasuredExecutionTargets: sourceState.slipstreamMeasuredExecutionTargets,
    stagedMergedCount: staged.mergedCount,
    stagedSkippedCount: staged.skippedCount,
    stagedSkippedByExactIdentityCount: staged.skippedByExactIdentityCount,
    stagedSkippedByUniqueDerivedIdentityCount: staged.skippedByUniqueDerivedIdentityCount,
    stagedSkippedByOptionalWildcardIdentityCount: staged.skippedByOptionalWildcardIdentityCount,
    stagedSkippedByAuthoritativeProtocolCount: staged.skippedByAuthoritativeProtocolCount,
    stagedSkipDimensions: staged.skipDimensions,
    directApiIntegration,
  };
}

async function scoreDexLiquidityPoolState(
  ctx: DexLiquidityRunContext,
  sourceState: DexLiquidityScoringSourceState,
  poolState: DexLiquidityPoolState,
  measuredTargetPublicationMode: MeasuredTargetPublicationMode,
): Promise<DexLiquidityScoreState> {
  await ctx.reportDexProgress("scoring", {
    message: "Scoring DEX liquidity coverage", providerFamily: "internal",
    counts: {
      metricRows: poolState.metrics.size, activeStablecoins: ACTIVE_STABLECOINS.length,
    },
  });
  const {
    scores: scoreResults,
    globalAgg,
    retainedPoolsByStablecoin,
    tvlStabilityMap,
    diagnostics,
  } = await computeStablecoinScores(
    ctx.db,
    poolState.metrics,
    sourceState.protocolTvlCaps,
    sourceState.stablecoinMcapById,
    ctx.syncStartSec,
    poolState.pancakeMeasuredExecutionTargets,
    ctx.signal,
    poolState.slipstreamMeasuredExecutionTargets,
    measuredTargetPublicationMode,
  );
  const analysis = await analyzeDexLiquidityPostScoring({
    db: ctx.db,
    scoreResults,
    globalAgg,
    retainedPoolsByStablecoin,
    priceObservations: sourceState.priceObservations,
    protocolTvlCaps: sourceState.protocolTvlCaps,
    diagnostics,
    stagedMergedCount: poolState.stagedMergedCount,
    stagedSkippedCount: poolState.stagedSkippedCount,
    weakCoverageCoinsBeforeFallback: poolState.fallback.weakCoverageCoinsBeforeFallback,
    directCexOrderbookDepth: poolState.fallback.directCexOrderbookDepth,
    dlYieldsAvailable: sourceState.dlYieldsAvailable,
    dlProtocolsAvailable: sourceState.dlProtocolsAvailable,
    criticalSourceFailures: sourceState.criticalSourceFailures,
  });
  sourceState.protocolTvlCaps.clear();
  sourceState.stablecoinMcapById.clear();

  const hasCriticalSourceFailure = sourceState.criticalSourceFailures.length > 0;
  if (
    !hasCriticalSourceFailure &&
    analysis.previousCoverage >= 10 &&
    analysis.currentCoverage < analysis.minExpectedCoverage
  ) {
    throw new Error(
      `[dex-liquidity] coverage guard tripped: current=${analysis.currentCoverage}, previous=${analysis.previousCoverage}, minExpected=${analysis.minExpectedCoverage}`,
    );
  }
  if (!hasCriticalSourceFailure && analysis.hardValueGuard) {
    throw new Error(
      `[dex-liquidity] value coverage guard tripped: currentGlobalTvl=${Math.round(analysis.currentGlobalTvl)}, ` +
        `previousGlobalTvl=${Math.round(analysis.previousGlobalTvl ?? 0)}, minExpectedGlobalTvl=${Math.round(analysis.minExpectedGlobalTvl ?? 0)}`,
    );
  }
  if (!hasCriticalSourceFailure && analysis.hardMajorCoverageGuard) {
    throw new Error(
      `[dex-liquidity] major coverage guard tripped: currentTop10GuardTvl=${Math.round(analysis.currentTop10GuardTvl)}, ` +
        `previousTop10GuardTvl=${Math.round(analysis.previousTop10GuardTvl)}, ` +
        `currentTop10CoveredTvl=${Math.round(analysis.currentTop10CoveredTvl)}, ` +
        `previousTop10CoveredTvl=${Math.round(analysis.previousTop10CoveredTvl)}`,
    );
  }
  throwIfAborted(ctx.signal);
  await ctx.reportDexProgress("scoring-complete", {
    message: "Completed DEX liquidity scoring", providerFamily: "internal", done: scoreResults.size,
    counts: {
      scoreRows: scoreResults.size, currentCoverage: analysis.currentCoverage,
      currentGlobalTvl: Math.round(analysis.currentGlobalTvl),
    },
    metadata: {
      hardValueGuard: analysis.hardValueGuard,
      hardMajorCoverageGuard: analysis.hardMajorCoverageGuard,
    },
  });

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
  sourceState: DexLiquidityScoringSourceState,
  poolState: DexLiquidityPoolState,
  scoreState: DexLiquidityScoreState,
  options: { publishLiquidity: boolean; currentGenerationId: string | null },
): Promise<DexLiquidityPersistenceState> {
  const skippedReason = getPersistenceSkipReason(sourceState.criticalSourceFailures);
  if (skippedReason) {
    await ctx.reportDexProgress("persistence-skipped", {
      message: `Skipping DEX liquidity publication: ${skippedReason}`, providerFamily: "d1", total: scoreState.scoreResults.size,
      metadata: { skippedReason, failedSources: sourceState.failedSources }, counts: { candidateRows: scoreState.scoreResults.size },
    });
    logWorkerEventArgs("handler", "warn", `[dex-liquidity] Skipping persistence because ${skippedReason}`);
    return {
      persistence: {
        placeholderCount: 0,
        inactiveMetricRowsSkipped: 0,
        inactiveMetricIdsSkipped: [],
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
      dexPriceDiagnostics: {
        rejectedObservationCount: 0,
        rejectedByStablecoin: [],
        truncatedStablecoins: 0,
      },
      historicalSnapshot: {
        snapshotRowsWritten: 0,
        skipped: true,
        writeFailed: false,
        historyRowsPruned: 0,
        retentionPruneFailed: false,
      },
    };
  }

  await ctx.reportDexProgress(options.publishLiquidity ? "persistence" : "price-persistence", {
    message: options.publishLiquidity ? "Publishing DEX liquidity generation" : "Reusing current DEX liquidity generation for hourly prices",
    providerFamily: "d1", total: scoreState.scoreResults.size, counts: { candidateRows: scoreState.scoreResults.size },
  });
  const persistence: DexLiquidityPersistence = options.publishLiquidity
    ? (await runWithOverloadRetry(
        () =>
          persistScores(
            ctx.db,
            poolState.metrics,
            scoreState.scoreResults,
            scoreState.globalAgg,
            ctx.syncStartSec,
            ctx.signal,
          ),
        3,
        ctx.signal,
      )) ?? {
        placeholderCount: 0,
        inactiveMetricRowsSkipped: 0,
        inactiveMetricIdsSkipped: [],
        orphanRowsDeleted: 0,
        orphanCleanupFailed: false,
      }
    : {
        generationId: options.currentGenerationId,
        placeholderCount: 0,
        inactiveMetricRowsSkipped: 0,
        inactiveMetricIdsSkipped: [],
        orphanRowsDeleted: 0,
        orphanCleanupFailed: false,
        skippedReason: "liquidity-cadence-reuse",
      };
  const publicationGenerationId = persistence.generationId;
  if (!publicationGenerationId) {
    throw new Error("DEX liquidity persistence completed without a publication generation id");
  }
  poolState.metrics.clear();
  await ctx.reportDexProgress(
    options.publishLiquidity ? "persistence-generation-complete" : "persistence-generation-reused",
    {
      message: options.publishLiquidity ? "Published bounded DEX liquidity generation batches" : "Reused exact current DEX liquidity generation",
      providerFamily: "d1", done: persistence.candidateRowsWritten ?? 0, total: persistence.expectedRowCount ?? scoreState.scoreResults.size,
      metadata: { generationId: persistence.generationId },
    },
  );
  const dexPriceDiagnostics = await computeDexPrices(
    ctx.db,
    scoreState.retainedPoolsByStablecoin,
    ctx.syncStartSec,
    sourceState.validationReferences,
    ctx.signal,
    sourceState.priceObservations,
    publicationGenerationId,
    sourceState.stablecoinPriceById,
  );
  sourceState.stablecoinPriceById.clear();
  sourceState.priceObservations.clear();
  await ctx.reportDexProgress("persistence-prices-complete", {
    message: "Atomically published the staged DEX price generation", providerFamily: "d1",
    done: scoreState.scoreResults.size, total: scoreState.scoreResults.size,
  });

  const hasCriticalSourceFailure = sourceState.criticalSourceFailures.length > 0;
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
      return [meta.id, !hasCriticalSourceFailure || hasPublishedRows];
    }),
  );
  const challengerPublication = await publishDexPriceChallengerSnapshots(
    ctx.db,
    {
      snapshotAt: ctx.syncStartSec,
      retainedPoolsByStablecoin: scoreState.retainedPoolsByStablecoin,
      sourceCoverageCompleteByStablecoin,
      minPoolTvlUsd: POOL_CHALLENGE_MIN_TVL,
      consumeRetainedPools: true,
    },
    ctx.signal,
  );
  sourceCoverageCompleteByStablecoin.clear();
  scoreState.retainedPoolsByStablecoin.clear();
  await ctx.reportDexProgress("persistence-challengers-complete", {
    message: "Published bounded DEX challenger batches", providerFamily: "d1", done: challengerPublication.publishedStablecoins,
  });

  const historicalSnapshot = options.publishLiquidity
    ? (await writeHistoricalSnapshots(
        ctx.db,
        scoreState.scoreResults,
        ctx.signal,
        ctx.syncStartSec,
      )) ?? {
        snapshotRowsWritten: 0,
        skipped: false,
        writeFailed: false,
        historyRowsPruned: 0,
        retentionPruneFailed: false,
      }
    : {
        snapshotRowsWritten: 0,
        skipped: true,
        writeFailed: false,
        historyRowsPruned: 0,
        retentionPruneFailed: false,
      };
  await ctx.reportDexProgress("persistence-history-complete", {
    message: "Reconciled DEX liquidity history", providerFamily: "d1", done: historicalSnapshot.snapshotRowsWritten,
  });

  if (options.publishLiquidity) {
    await computeDepthStability(ctx.db, scoreState.tvlStabilityMap, publicationGenerationId, ctx.signal);
  }
  scoreState.tvlStabilityMap.clear();
  await ctx.reportDexProgress("persistence-depth-complete", {
    message: "Atomically published staged DEX depth stability", providerFamily: "d1",
    done: scoreState.scoreResults.size, total: scoreState.scoreResults.size,
  });
  await ctx.reportDexProgress("persistence-complete", {
    message: "Published DEX liquidity generation", providerFamily: "d1",
    done: scoreState.scoreResults.size, total: scoreState.scoreResults.size,
    metadata: {
      generationId: persistence.generationId,
      orphanCleanupFailed: persistence.orphanCleanupFailed,
      retentionPruneFailed: historicalSnapshot.retentionPruneFailed,
      dexPriceDiagnostics,
    },
    counts: {
      rowsWritten: scoreState.scoreResults.size, placeholderRowsWritten: persistence.placeholderCount,
      inactiveMetricRowsSkipped: persistence.inactiveMetricRowsSkipped,
      inactiveMetricIdsSkipped: persistence.inactiveMetricIdsSkipped?.slice(0, 25) ?? [], orphanRowsDeleted: persistence.orphanRowsDeleted,
      historicalSnapshotRows: historicalSnapshot.snapshotRowsWritten, historicalRowsPruned: historicalSnapshot.historyRowsPruned,
    },
  });

  return {
    persistence,
    challengerPublication,
    dexPriceDiagnostics,
    historicalSnapshot,
  };
}

function buildDexLiquidityCronResult(
  sourceState: DexLiquidityScoringSourceState,
  poolState: DexLiquidityPoolState,
  scoreState: DexLiquidityScoreState,
  persistenceState: DexLiquidityPersistenceState,
): CronResult {
  const degraded = isDexLiquidityDegraded({
    criticalSourceFailures: sourceState.criticalSourceFailures,
    poolRejections: poolState.poolRejections,
    analysis: scoreState.analysis,
    persistence: persistenceState.persistence,
    dexPriceDiagnostics: persistenceState.dexPriceDiagnostics,
    historicalSnapshot: persistenceState.historicalSnapshot,
  });

  return {
    status: degraded ? "degraded" : "ok",
    itemCount: scoreState.scoreResults.size,
    metadata: JSON.stringify(
      buildDexLiquidityCronMetadata({
        rowsRead: sourceState.primaryRawPoolCount,
        rowsWritten: persistenceState.persistence.skipped ||
          persistenceState.persistence.skippedReason === "liquidity-cadence-reuse"
          ? 0
          : scoreState.scoreResults.size,
        stagedPoolsMerged: poolState.stagedMergedCount,
        stagedPoolsSkipped: poolState.stagedSkippedCount,
        stagedPoolsSkippedByExactIdentity: poolState.stagedSkippedByExactIdentityCount,
        stagedPoolsSkippedByUniqueDerivedIdentity: poolState.stagedSkippedByUniqueDerivedIdentityCount,
        stagedPoolsSkippedByOptionalWildcardIdentity: poolState.stagedSkippedByOptionalWildcardIdentityCount,
        stagedPoolsSkippedByAuthoritativeProtocol: poolState.stagedSkippedByAuthoritativeProtocolCount,
        stagedPoolSkipDimensions: poolState.stagedSkipDimensions,
        poolRejections: poolState.poolRejections,
        directApiSourceSummary: {
          acceptedByProtocolChain: poolState.directApiIntegration.acceptedByProtocolChain,
          excludedByReason: poolState.directApiIntegration.excludedByReason,
          circuitEvents: sourceState.directApiSourceSummary.circuitEvents,
          sourceWarnings: sourceState.directApiSourceSummary.sourceWarnings,
          pagination: sourceState.directApiSourceSummary.pagination,
        },
        sourceCoverage: scoreState.analysis.sourceCoverage,
        challengerPublication: persistenceState.challengerPublication,
        dexPriceDiagnostics: persistenceState.dexPriceDiagnostics,
        failedSources: sourceState.failedSources,
        fallbackSignals: sourceState.fallbackSignals,
        fallbackCounters: scoreState.diagnostics.fallbackCounters,
        shadowAdmission: scoreState.diagnostics.measuredExecution?.shadowAdmission ?? null,
        persistence: persistenceState.persistence,
        historicalSnapshot: persistenceState.historicalSnapshot,
      }),
    ),
  };
}
