import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { LiquidityMetrics, LlamaPool } from "./types";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import { reportCronProgress } from "../../lib/cron-progress";
import { throwIfAborted } from "../../lib/abort";
import { loadPriceValidationReferences } from "../../lib/price-validation";
import { buildSymbolLookups, classifyPoolType } from "./pool-helpers";
import { buildChainAddressKey } from "./token-resolution";
import {
  fetchDataSources,
  buildCurveLookups,
  buildKnownPoolAddresses,
  type PrimaryPoolCompactionResult,
} from "./fetch-primary";
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
  loadTrackedStablecoinMaps,
  mergeDexPriceObservationMap,
  runDirectApiFetchPhase,
  runFallbackCrawlerPhase,
  type DirectApiIntegrationResult,
} from "./orchestrator-phases";
import { compactDirectApiFetchPhasePools, type DirectApiPoolCompactionCounts } from "./orchestrator-phases/direct-api";
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
import {
  buildFluidMeasuredExecutionTargets,
  buildPancakeMeasuredExecutionTargets,
} from "../measured-execution/inventory";

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
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const ctx: DexLiquidityRunContext = {
    db,
    graphApiKey,
    signal,
    coingeckoApiKey,
    chainRpcs,
    reportProgress,
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
  reportProgress?: CronProgressReporter;
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
  priceObservations: Awaited<ReturnType<typeof buildCurveLookups>>["priceObservations"];
  subgraphEnrichment: DexLiquiditySubgraphEnrichment;
  directApiPhase: DexLiquidityDirectApiPhase;
  directApiPools: DexApiPool[];
  pancakeMeasuredExecutionTargets: ReturnType<typeof buildPancakeMeasuredExecutionTargets>;
  fluidMeasuredExecutionTargets: ReturnType<typeof buildFluidMeasuredExecutionTargets>;
  primaryPoolCounts: PrimaryPoolCompactionResult;
  directApiPoolCounts: DirectApiPoolCompactionCounts;
  authoritativeConfirmation: ReturnType<typeof buildAuthoritativeStagedPoolConfirmationIndex>;
  failedSources: string[];
  criticalSourceFailures: string[];
  fallbackSignals: string[];
}

interface DexLiquidityPoolState {
  fallback: DexLiquidityFallbackPhase;
  metrics: Map<string, LiquidityMetrics>;
  pancakeMeasuredExecutionTargets: ReturnType<typeof buildPancakeMeasuredExecutionTargets>;
  fluidMeasuredExecutionTargets: ReturnType<typeof buildFluidMeasuredExecutionTargets>;
  stagedMergedCount: number;
  stagedSkippedCount: number;
  stagedSkippedByExactIdentityCount: number;
  stagedSkippedByUniqueDerivedIdentityCount: number;
  stagedSkippedByOptionalWildcardIdentityCount: number;
  stagedSkippedByAuthoritativeProtocolCount: number;
  stagedSkipDimensions: Awaited<ReturnType<typeof mergeStagedPools>>["skipDimensions"];
  directApiIntegration: DirectApiIntegrationResult;
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

function getPersistenceSkipReason(criticalSourceFailures: string[]): string | null {
  for (const source of criticalSourceFailures) {
    if (DEX_LIQUIDITY_PERSISTENCE_BLOCKING_FAILURES.has(source)) {
      return `${source}-unavailable`;
    }
  }
  return null;
}

async function reportDexLiquidityProgress(
  ctx: DexLiquidityRunContext,
  update: {
    stage: string;
    message: string;
    providerFamily: string;
    itemsDone?: number;
    itemsTotal?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await reportCronProgress(ctx.reportProgress, {
    stage: update.stage,
    message: update.message,
    itemsDone: update.itemsDone,
    itemsTotal: update.itemsTotal,
    metadata: {
      providerFamily: update.providerFamily,
      phase: update.stage,
      ...update.metadata,
    },
  });
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

  console.log(
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
  console.log(`[dex-liquidity] Starting sync`);
  throwIfAborted(ctx.signal);
  await reportDexLiquidityProgress(ctx, {
    stage: "source-loading",
    message: "Loading DEX liquidity source references",
    providerFamily: "dex-liquidity",
    itemsDone: 0,
    itemsTotal: ACTIVE_STABLECOINS.length,
    metadata: {
      countTotals: {
        activeStablecoins: ACTIVE_STABLECOINS.length,
      },
    },
  });

  const validationReferences = await loadPriceValidationReferences(ctx.db);
  const { stablecoinPriceById, stablecoinMcapById } = await loadTrackedStablecoinMaps(ctx.db, ctx.syncStartSec);
  const lookups = buildSymbolLookups();

  const directApiFetchers = buildDexDirectApiFetchers({
    db: ctx.db,
    graphApiKey: ctx.graphApiKey,
    chainAddressToId: lookups.chainAddressToId,
    symbolToChainScopedIds: lookups.symbolToChainScopedIds,
    stablecoinPriceById,
    chainRpcs: ctx.chainRpcs,
  });
  await reportDexLiquidityProgress(ctx, {
    stage: "direct-api-fetch",
    message: "Fetching protocol-native DEX liquidity",
    providerFamily: "protocol-native-dex",
    itemsDone: 0,
    itemsTotal: directApiFetchers.length,
    metadata: {
      providerFamilies: directApiFetchers.map((fetcher) => fetcher.normalizedProtocol),
      countTotals: {
        sourceFamilies: directApiFetchers.length,
      },
    },
  });
  let directApiPhase = await runDirectApiFetchPhase(ctx.db, directApiFetchers, ctx.signal, lookups);
  const authoritativeConfirmation = buildAuthoritativeStagedPoolConfirmationIndex(directApiPhase.results);
  const compactedDirectApi = compactDirectApiFetchPhasePools(directApiPhase, lookups);
  directApiPhase = compactedDirectApi.phase;
  await reportDexLiquidityProgress(ctx, {
    stage: "direct-api-fetch-complete",
    message: "Completed protocol-native DEX liquidity fetch",
    providerFamily: "protocol-native-dex",
    itemsDone: directApiPhase.results.length,
    itemsTotal: directApiFetchers.length,
    metadata: {
      providerFamilies: directApiPhase.results.map((entry) => entry.normalizedProtocol),
      failedSources: directApiPhase.failedSources,
      fallbackSignals: directApiPhase.fallbackSignals,
      sourceWarnings: directApiPhase.sourceWarnings,
      countTotals: {
        sourceFamilies: directApiFetchers.length,
        directApiPools: compactedDirectApi.counts.rawPoolCount,
        directApiPoolsRetained: compactedDirectApi.counts.retainedPoolCount,
        directApiPoolsSkippedInvalidUnits: compactedDirectApi.counts.skippedInvalidUnitCount,
        directApiPoolsSkippedUntracked: compactedDirectApi.counts.skippedUntrackedCount,
        circuitEvents: directApiPhase.circuitEvents.length,
      },
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
  const fluidMeasuredExecutionTargets = buildFluidMeasuredExecutionTargets({
    pools: compactedDirectApi.measuredExecutionPools,
    chainAddressToId: lookups.chainAddressToId,
    symbolToChainScopedIds: lookups.symbolToChainScopedIds,
    validationReferences,
    stablecoinPriceById,
    capturedAt: ctx.syncStartSec,
  });

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
  await reportDexLiquidityProgress(ctx, {
    stage: "primary-sources-loaded",
    message: "Loaded DefiLlama and Curve liquidity sources",
    providerFamily: "defillama",
    itemsDone: dataSources.rawPoolCount,
    itemsTotal: Math.max(dataSources.rawPoolCount, ACTIVE_STABLECOINS.length),
    metadata: {
      countTotals: {
        defillamaPools: dataSources.rawPoolCount,
        curvePayloads: dataSources.curvePayloads.filter((payload) => payload != null).length,
        dexProjects: dataSources.dexProjects.size,
      },
      dlYieldsAvailable: dataSources.dlYieldsAvailable,
      dlProtocolsAvailable: dataSources.dlProtocolsAvailable,
    },
  });
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

  const primaryPoolCounts: PrimaryPoolCompactionResult = {
    pools: dataSources.pools,
    rawPoolCount: dataSources.rawPoolCount,
    retainedPoolCount: dataSources.pools.length,
    skippedUntrackedCount: dataSources.rawPoolCount - dataSources.pools.length,
  };
  const { curvePoolMap, priceObservations } = await buildCurveLookups(
    dataSources.curvePayloads,
    lookups.symbolToIds,
    lookups.symbolToChainScopedIds,
    lookups.chainAddressToId,
    validationReferences,
  );
  // Downstream phases use only the derived maps, so release the raw response trees now.
  dataSources.curvePayloads.length = 0;

  await reportDexLiquidityProgress(ctx, {
    stage: "subgraph-enrichment",
    message: "Fetching subgraph liquidity enrichment",
    providerFamily: "subgraph",
    itemsDone: 0,
    itemsTotal: 2,
    metadata: {
      providerFamilies: ["uniswap-v3", "aerodrome"],
      countTotals: {
        subgraphFamilies: 2,
      },
    },
  });
  const subgraphEnrichment = await fetchSubgraphEnrichmentPhase({
    graphApiKey: ctx.graphApiKey,
    symbolToChainScopedIds: lookups.symbolToChainScopedIds,
    chainAddressToId: lookups.chainAddressToId,
    signal: ctx.signal,
    validationReferences,
  });
  failedSources.push(...subgraphEnrichment.failedSources);
  await reportDexLiquidityProgress(ctx, {
    stage: "subgraph-enrichment-complete",
    message: "Completed subgraph enrichment",
    providerFamily: "subgraph",
    itemsDone: 2 - subgraphEnrichment.failedSources.length,
    itemsTotal: 2,
    metadata: {
      providerFamilies: ["uniswap-v3", "aerodrome"],
      failedSources: subgraphEnrichment.failedSources,
      countTotals: {
        uniV3PriceObservations: subgraphEnrichment.uniV3PriceObs.size,
        aerodromePriceObservations: subgraphEnrichment.aerodromePriceObs.size,
      },
    },
  });

  // Preserve the established primary/subgraph/direct diagnostic ordering even
  // though direct sources now execute first to bound peak memory.
  failedSources.push(...directApiPhase.failedSources);
  fallbackSignals.push(...directApiPhase.fallbackSignals);

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
    directApiPools: compactedDirectApi.pools,
    pancakeMeasuredExecutionTargets,
    fluidMeasuredExecutionTargets,
    primaryPoolCounts,
    directApiPoolCounts: compactedDirectApi.counts,
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
  await reportDexLiquidityProgress(ctx, {
    stage: "pool-processing",
    message: "Merging primary, staged, direct, and fallback pools",
    providerFamily: "dex-liquidity",
    itemsDone: 0,
    itemsTotal: sourceState.primaryPoolCounts.rawPoolCount + sourceState.directApiPoolCounts.rawPoolCount,
    metadata: {
      countTotals: {
        primaryPools: sourceState.primaryPoolCounts.rawPoolCount,
        primaryPoolsRetained: sourceState.primaryPoolCounts.retainedPoolCount,
        directApiPools: sourceState.directApiPoolCounts.rawPoolCount,
        directApiPoolsRetained: sourceState.directApiPoolCounts.retainedPoolCount,
      },
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
    sourceState.subgraphEnrichment.uniV3ExecutionCandidates,
    sourceState.stablecoinPriceById,
    ctx.syncStartSec,
    sourceState.validationReferences,
  );

  // Primary pools and enrichment maps have been projected into metrics and the
  // identity index. Drop their source graphs before D1 materializes staged rows.
  preferredPrimaryPools = [];
  primaryPreference.filteredPools = [];
  sourceState.dataSources.pools = [];
  sourceState.primaryPoolCounts.pools = [];
  sourceState.dataSources.dexProjects = new Set();
  sourceState.curvePoolMap = new Map();
  sourceState.subgraphEnrichment.uniV3PoolFees = new Map();
  sourceState.subgraphEnrichment.uniV3SymbolFees = new Map();
  sourceState.subgraphEnrichment.uniV3PriceObs = new Map();
  sourceState.subgraphEnrichment.uniV3ExecutionCandidates = new Map();
  sourceState.subgraphEnrichment.aerodromePriceObs = new Map();
  sourceState.subgraphEnrichment.aerodromeIsStable = new Map();

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
    preprocessedPoolCounts: sourceState.directApiPoolCounts,
  });
  logDirectApiSourceSummary(directApiIntegration, sourceState.directApiPhase.circuitEvents);

  // The compact direct pool list is no longer needed after integration.
  sourceState.directApiPools = [];
  sourceState.lookups.symbolToIds = new Map();
  sourceState.lookups.symbolToChainScopedIds = new Map();
  sourceState.lookups.addressToId = new Map();
  sourceState.lookups.chainAddressToId = new Map();
  sourceState.lookups.contractMetaByChainAddress = new Map();

  await reportDexLiquidityProgress(ctx, {
    stage: "pool-processing-core-complete",
    message: "Completed primary and direct pool integration",
    providerFamily: "dex-liquidity",
    itemsDone: metrics.size,
    itemsTotal: ACTIVE_STABLECOINS.length,
    metadata: {
      countTotals: {
        metricRows: metrics.size,
        directApiAccepted: Object.values(directApiIntegration.acceptedByProtocolChain).reduce(
          (sum, count) => sum + count,
          0,
        ),
      },
    },
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
  sourceState.authoritativeConfirmation = {
    enforcedChainsByProtocol: new Map(),
    confirmedExactKeysByProtocol: new Map(),
  };

  await reportDexLiquidityProgress(ctx, {
    stage: "pool-processing-staged-complete",
    message: "Completed staged pool merge",
    providerFamily: "dex-liquidity",
    itemsDone: staged.mergedCount,
    itemsTotal: staged.mergedCount + staged.skippedCount,
    metadata: {
      countTotals: {
        stagedPoolsMerged: staged.mergedCount,
        stagedPoolsSkipped: staged.skippedCount,
      },
    },
  });

  const fallback = await runFallbackCrawlerPhase({
    metrics,
    priceObservations: sourceState.priceObservations,
    signal: ctx.signal,
    failedSources: sourceState.failedSources,
  });
  await reportDexLiquidityProgress(ctx, {
    stage: "pool-processing-complete",
    message: "Completed pool merge and bounded market telemetry",
    providerFamily: "dex-liquidity",
    itemsDone: metrics.size,
    itemsTotal: ACTIVE_STABLECOINS.length,
    metadata: {
      countTotals: {
        metricRows: metrics.size,
        stagedPoolsMerged: staged.mergedCount,
        stagedPoolsSkipped: staged.skippedCount,
        directApiAccepted: Object.values(directApiIntegration.acceptedByProtocolChain).reduce(
          (sum, count) => sum + count,
          0,
        ),
        weakCoverageCoinsBeforeFallback: fallback.weakCoverageCoinsBeforeFallback,
        coverageRecoveredCoins: fallback.coverageRecoveredCoins,
      },
    },
  });

  return {
    fallback,
    metrics,
    pancakeMeasuredExecutionTargets: sourceState.pancakeMeasuredExecutionTargets,
    fluidMeasuredExecutionTargets: sourceState.fluidMeasuredExecutionTargets,
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
  sourceState: DexLiquiditySourceState,
  poolState: DexLiquidityPoolState,
): Promise<DexLiquidityScoreState> {
  await reportDexLiquidityProgress(ctx, {
    stage: "scoring",
    message: "Scoring DEX liquidity coverage",
    providerFamily: "internal",
    itemsDone: 0,
    itemsTotal: ACTIVE_STABLECOINS.length,
    metadata: {
      countTotals: {
        metricRows: poolState.metrics.size,
        activeStablecoins: ACTIVE_STABLECOINS.length,
      },
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
    sourceState.dataSources.protocolTvlCaps,
    sourceState.stablecoinMcapById,
    ctx.syncStartSec,
    poolState.pancakeMeasuredExecutionTargets,
    poolState.fluidMeasuredExecutionTargets,
    ctx.signal,
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
  await reportDexLiquidityProgress(ctx, {
    stage: "scoring-complete",
    message: "Completed DEX liquidity scoring",
    providerFamily: "internal",
    itemsDone: scoreResults.size,
    itemsTotal: ACTIVE_STABLECOINS.length,
    metadata: {
      countTotals: {
        scoreRows: scoreResults.size,
        currentCoverage: analysis.currentCoverage,
        currentGlobalTvl: Math.round(analysis.currentGlobalTvl),
      },
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
  sourceState: DexLiquiditySourceState,
  poolState: DexLiquidityPoolState,
  scoreState: DexLiquidityScoreState,
): Promise<DexLiquidityPersistenceState> {
  const skippedReason = getPersistenceSkipReason(sourceState.criticalSourceFailures);
  if (skippedReason) {
    await reportDexLiquidityProgress(ctx, {
      stage: "persistence-skipped",
      message: `Skipping DEX liquidity publication: ${skippedReason}`,
      providerFamily: "d1",
      itemsDone: 0,
      itemsTotal: scoreState.scoreResults.size,
      metadata: {
        skippedReason,
        failedSources: sourceState.failedSources,
        countTotals: {
          candidateRows: scoreState.scoreResults.size,
        },
      },
    });
    console.warn(`[dex-liquidity] Skipping persistence because ${skippedReason}`);
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

  await reportDexLiquidityProgress(ctx, {
    stage: "persistence",
    message: "Publishing DEX liquidity generation",
    providerFamily: "d1",
    itemsDone: 0,
    itemsTotal: scoreState.scoreResults.size,
    metadata: {
      countTotals: {
        candidateRows: scoreState.scoreResults.size,
      },
    },
  });
  const persistence = (await runWithOverloadRetry(
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
  };
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
    },
    ctx.signal,
  );
  const dexPriceDiagnostics = await computeDexPrices(
    ctx.db,
    scoreState.retainedPoolsByStablecoin,
    ctx.syncStartSec,
    sourceState.validationReferences,
    ctx.signal,
    sourceState.priceObservations,
  );

  const historicalSnapshot = (await writeHistoricalSnapshots(
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
  };

  await computeDepthStability(ctx.db, scoreState.tvlStabilityMap, ctx.signal);
  await reportDexLiquidityProgress(ctx, {
    stage: "persistence-complete",
    message: "Published DEX liquidity generation",
    providerFamily: "d1",
    itemsDone: scoreState.scoreResults.size,
    itemsTotal: scoreState.scoreResults.size,
    metadata: {
      generationId: persistence.generationId,
      countTotals: {
        rowsWritten: scoreState.scoreResults.size,
        placeholderRowsWritten: persistence.placeholderCount,
        inactiveMetricRowsSkipped: persistence.inactiveMetricRowsSkipped,
        inactiveMetricIdsSkipped: persistence.inactiveMetricIdsSkipped?.slice(0, 25) ?? [],
        orphanRowsDeleted: persistence.orphanRowsDeleted,
        historicalSnapshotRows: historicalSnapshot.snapshotRowsWritten,
        historicalRowsPruned: historicalSnapshot.historyRowsPruned,
      },
      orphanCleanupFailed: persistence.orphanCleanupFailed,
      retentionPruneFailed: historicalSnapshot.retentionPruneFailed,
      dexPriceDiagnostics,
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
        rowsRead: sourceState.primaryPoolCounts.rawPoolCount,
        rowsWritten: persistenceState.persistence.skipped ? 0 : scoreState.scoreResults.size,
        stagedPoolsMerged: poolState.stagedMergedCount,
        stagedPoolsSkipped: poolState.stagedSkippedCount,
        stagedPoolsSkippedByExactIdentity: poolState.stagedSkippedByExactIdentityCount,
        stagedPoolsSkippedByUniqueDerivedIdentity: poolState.stagedSkippedByUniqueDerivedIdentityCount,
        stagedPoolsSkippedByOptionalWildcardIdentity: poolState.stagedSkippedByOptionalWildcardIdentityCount,
        stagedPoolsSkippedByAuthoritativeProtocol: poolState.stagedSkippedByAuthoritativeProtocolCount,
        stagedPoolSkipDimensions: poolState.stagedSkipDimensions,
        directApiSourceSummary: {
          acceptedByProtocolChain: poolState.directApiIntegration.acceptedByProtocolChain,
          excludedByReason: poolState.directApiIntegration.excludedByReason,
          circuitEvents: sourceState.directApiPhase.circuitEvents,
          sourceWarnings: sourceState.directApiPhase.sourceWarnings,
          pagination: sourceState.directApiPhase.results.flatMap((entry) =>
            entry.result.pagination ? [{ source: entry.circuitKey, ...entry.result.pagination }] : [],
          ),
        },
        sourceCoverage: scoreState.analysis.sourceCoverage,
        challengerPublication: persistenceState.challengerPublication,
        dexPriceDiagnostics: persistenceState.dexPriceDiagnostics,
        failedSources: sourceState.failedSources,
        fallbackSignals: sourceState.fallbackSignals,
        persistence: persistenceState.persistence,
        historicalSnapshot: persistenceState.historicalSnapshot,
      }),
    ),
  };
}
