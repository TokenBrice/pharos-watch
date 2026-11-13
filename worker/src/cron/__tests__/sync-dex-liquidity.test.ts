import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getCronQualityReasons } from "@shared/lib/cron-quality-reasons";
import type { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@shared/types/cloudflare-runtime";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import type { StablecoinData } from "@shared/types/supply";
import type { DexApiPool } from "../../lib/dex-api-common";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { CronProgressReporter, CronProgressUpdate, CronResult } from "../../lib/cron-logger";
import type { LlamaPool } from "../dex-liquidity/types";
import type { PoolProcessingRejection } from "../dex-liquidity/process-pool-types";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import * as priceValidation from "../../lib/price-validation";
import * as realPoolShaping from "../../lib/dex-api-pool-shaping";
import { CRON_TIMEOUT_MS, createSlotDeadline } from "../../lib/cron-timeouts";
import { getCronMetadataBudgetBytes } from "../../lib/cron-metadata-persistence";
import { DexLiquidityCronMetadataSchema } from "../../lib/schemas";
import * as v2Enrichment from "../dex-liquidity/constant-product-v2";
import * as quoterEnrichment from "../dex-liquidity/enrich-quoter-v2-targets";
import * as v4Enrichment from "../dex-liquidity/uniswap-v4-identity";
import * as priceRefresh from "../dex-liquidity/price-refresh";
import { buildStagedPoolWriteback } from "../dex-liquidity/staged-pool-writeback";

afterEach(() => {
  vi.restoreAllMocks();
});

const phaseFixtures = vi.hoisted(() => {
  function primary(overrides: Record<string, unknown> = {}) {
    return {
      pools: [],
      rawPoolCount: 0,
      poolRejections: [] as PoolProcessingRejection[],
      dexProjects: new Set<string>(),
      protocolTvlCaps: new Map<string, number>(),
      curvePayloads: [],
      curveFailedChains: [],
      graphApiKey: "graph-key",
      dlYieldsAvailable: true,
      dlProtocolsAvailable: true,
      ...overrides,
    };
  }

  function stagedPools() {
    return {
      registryEvaluatedAtSec: Math.floor(Date.now() / 1000),
      mergedCount: 0,
      skippedCount: 0,
      skippedByExactIdentityCount: 0,
      skippedByUniqueDerivedIdentityCount: 0,
      skippedByOptionalWildcardIdentityCount: 0,
      skippedByAuthoritativeProtocolCount: 0,
      skipDimensions: [],
      priceObservations: new Map(),
      registryRowsRead: 0,
      registryMultiSourcePools: 0,
      registryFamilyBySource: {},
      deadPoolUnindexedChainSkips: {},
    };
  }

  function diagnostics(extra: Record<string, unknown> = {}) {
    return {
      protocolTvlQuarantine: { reason: "fallback-protocol-tvl-exceeds-headroom", poolCount: 0, protocolCount: 0, tvlUsd: 0 },
      globalProtocolOverCapUsd: 0,
      measuredTargetFunnel: { stageOrigin: "scheduled", groups: [], groupsOmitted: 0, sourceFailures: [], sourceFailuresOmitted: 0 },
      routeRemovalEvidence: new Map(), ...extra,
    };
  }

  function scored(extra: Record<string, unknown> = {}) {
    return {
      scoredMetrics: new Map(),
      measuredTargetInventory: { mode: "active", active: [], shadow: [] },
      scores: new Map([["usdt-tether", { coverageClass: "primary", tvl: 0 }]]),
      globalAgg: { totalTvl: 0 },
      retainedPoolsByStablecoin: new Map(),
      tvlStabilityMap: new Map(),
      diagnostics: diagnostics({ fallbackCounters: { tvlDepthMcapFallback: 2, retainedExclusionBlockedDex: 1 } }), ...extra,
    };
  }

  function create(overrides: Record<string, unknown> = {}) {
    return {
      directApi: { pools: [], ok: true, degraded: false, errors: [] as string[] },
      uniV3: {
        uniV3PoolFees: new Map(),
        uniV3SymbolFees: new Map(),
        uniV3PriceObs: new Map(),
        uniV3ExecutionCandidates: new Map(),
        failedChains: [],
        chainFailures: [],
      },
      uniswapV4: {
        uniswapV4ExecutionCandidates: new Map(), failedChains: [], chainFailures: [], exactAnsweredPoolIdsByChain: new Map(),
      },
      primary: primary(),
      curve: { curvePoolMap: new Map(), priceObservations: new Map() },
      knownPools: {
        exactKeys: new Set<string>(),
        exactStablecoinIdsByKey: new Map<string, Set<string>>(),
        derivedKeyCounts: new Map<string, number>(),
        derivedToExactKeys: new Map<string, Set<string>>(),
        wildcardKeyCounts: new Map<string, number>(),
        wildcardToExactKeys: new Map<string, Set<string>>(),
        concreteFeeVariantKeys: new Map<string, Set<string>>(),
      },
      poolMetrics: { metrics: new Map(), rejections: [] },
      stagedPools: stagedPools(),
      scores: scored(),
      stablecoinsCache: { kind: "error" as const, reason: "missing-cache" as const, updatedAt: null },
      challenger: { publishedStablecoins: 0, skippedStablecoins: 0 },
      ...overrides,
    };
  }

  let current = create();
  return {
    primary, stagedPools, scored, diagnostics,
    get current() {
      return current;
    },
    reset(overrides: Record<string, unknown> = {}) {
      current = create(overrides);
    },
  };
});

function makeDirectApiResult() {
  return phaseFixtures.current.directApi;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("../dex-liquidity/subgraph-source-families", () => ({
  fetchUniV3Data: vi.fn(async () => phaseFixtures.current.uniV3),
  fetchUniswapV4Data: vi.fn(async () => phaseFixtures.current.uniswapV4),
}));

vi.mock("../dex-liquidity/fetch-primary", () => ({
  fetchDataSources: vi.fn(async () => phaseFixtures.current.primary),
  buildCurveLookups: vi.fn(async () => phaseFixtures.current.curve),
  buildKnownPoolAddresses: vi.fn(() => phaseFixtures.current.knownPools),
}));

vi.mock("../dex-liquidity/process-pools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dex-liquidity/process-pools")>()),
  processPoolMetrics: vi.fn(() => phaseFixtures.current.poolMetrics),
}));

vi.mock("../dex-liquidity/staging-merge", async () => {
  const { buildStagedPoolWriteback } = await import("../dex-liquidity/staged-pool-writeback");
  const { captureObservedPoolPrices } = await import("../dex-liquidity/price-refresh");
  return {
    mergeStagedPools: vi.fn<typeof import("../dex-liquidity/staging-merge").mergeStagedPools>(async (_db, metrics, _known, now, _tracked, _references, _confirmation, _counters, _signal, priceObservations) => ({
      ...phaseFixtures.current.stagedPools,
      stagedWriteback: buildStagedPoolWriteback(metrics, now),
      observedThisRun: captureObservedPoolPrices({ metrics, priceObservations }, now),
    })),
  };
});

vi.mock("../dex-liquidity/scoring", () => ({
  loadCurrentDexScoringGenerationId: vi.fn(async () => null),
  computeStablecoinScores: vi.fn(async () => phaseFixtures.current.scores),
  publishStablecoinScoreTargets: vi.fn(async () => {}),
  computeDexPrices: vi.fn(async () => {}),
}));

vi.mock("../dex-liquidity/persistence", () => ({
  persistScores: vi.fn(async (_db, _metrics, _scores, _globalAgg, nowSec: number) => ({
    generationId: `dex-liquidity-${nowSec}`,
  })),
  writeHistoricalSnapshots: vi.fn(async () => {}),
  buildDexLiquidityPublicationGenerationId: (startSec: number) => `dex-liquidity-${startSec}`,
}));

// SQLite round-trips live in scoring-stage.test.ts; this buffer exchanges the same encoded input.
const scoringStage = vi.hoisted(() => ({
  chunks: [] as Array<{ payload: string; payloadBytes: number; recordCount: number }>,
  sourceSlotStartedAt: 0,
  syncStartSec: 0,
}));

vi.mock("../dex-liquidity/scoring-stage", async () => {
  const actual = await vi.importActual<typeof import("../dex-liquidity/scoring-stage")>(
    "../dex-liquidity/scoring-stage",
  );
  const loadStoredStage = async () => {
    const decoded = actual.decodeDexLiquidityScoringStageChunks(scoringStage.chunks);
    return {
      generationId: `dex-liquidity-scoring-stage:${scoringStage.sourceSlotStartedAt}`,
      sourceSlotStartedAt: scoringStage.sourceSlotStartedAt,
      syncStartSec: scoringStage.syncStartSec,
      sourceState: decoded.sourceState,
      poolState: decoded.poolState,
    };
  };
  return {
    ...actual,
    persistDexLiquidityScoringStage: vi.fn(
      async (_db: D1Database, input: Parameters<typeof actual.persistDexLiquidityScoringStage>[1]) => {
        scoringStage.chunks = [];
        let recordCount = 0;
        let payloadBytes = 0;
        for (const chunk of actual.encodeDexLiquidityScoringStageChunks(
          input.sourceState,
          input.poolState,
          actual.DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES,
          true,
        )) {
          scoringStage.chunks.push({ ...chunk });
          recordCount += chunk.recordCount;
          payloadBytes += chunk.payloadBytes;
        }
        scoringStage.sourceSlotStartedAt = input.sourceSlotStartedAt;
        scoringStage.syncStartSec = input.syncStartSec;
        return {
          generationId: `dex-liquidity-scoring-stage:${input.sourceSlotStartedAt}`,
          sourceSlotStartedAt: input.sourceSlotStartedAt,
          chunkCount: scoringStage.chunks.length,
          recordCount,
          payloadBytes,
          retention: {
            cutoff: 0,
            deletedRows: 0,
            deletedChunkRows: 0,
            deletedStageRows: 0,
            oldestRemainingAt: null,
            durationMs: 0,
            error: null,
          },
        };
      },
    ),
    loadDexLiquidityScoringStage: vi.fn(loadStoredStage),
    loadDexLiquidityScoringStageWhenReady: vi.fn(loadStoredStage),
    markDexLiquidityScoringStageConsumed: vi.fn(async () => {}),
  };
});

vi.mock("../dex-liquidity/challenger-publish", async () => {
  const actual = await vi.importActual<typeof import("../dex-liquidity/challenger-publish")>(
    "../dex-liquidity/challenger-publish",
  );
  return {
    ...actual,
    publishDexPriceChallengerSnapshots: vi.fn(async () => phaseFixtures.current.challenger),
  };
});

vi.mock("../dex-liquidity/fetch-fallbacks", () => ({
  getFallbackTargets: vi.fn(() => []),
}));

vi.mock("../dex-liquidity/fetch-fluid", () => ({ fetchFluidPools: vi.fn(async () => makeDirectApiResult()) }));
vi.mock("../dex-liquidity/fetch-balancer", () => ({ fetchBalancerPools: vi.fn(async () => makeDirectApiResult()) }));
vi.mock("../dex-liquidity/fetch-raydium", () => ({ fetchRaydiumPools: vi.fn(async () => makeDirectApiResult()) }));
vi.mock("../dex-liquidity/fetch-orca", () => ({ fetchOrcaPools: vi.fn(async () => makeDirectApiResult()) }));
vi.mock("../dex-liquidity/fetch-meteora", () => ({ fetchMeteoraPools: vi.fn(async () => makeDirectApiResult()) }));
vi.mock("../dex-liquidity/fetch-pancakeswap", () => ({
  fetchPancakeSwapPools: vi.fn(async () => makeDirectApiResult()),
}));
vi.mock("../dex-liquidity/fetch-slipstream", () => ({
  fetchSlipstreamPools: vi.fn(async () => makeDirectApiResult()),
}));
vi.mock("../dex-liquidity/fetch-aero", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dex-liquidity/fetch-aero")>()),
  fetchAeroSlipstreamPools: vi.fn(async () => makeDirectApiResult()),
  fetchAeroBasicPools: vi.fn(async () => makeDirectApiResult()),
}));
vi.mock("../dex-liquidity/fetch-uniswap-v3-bsc", () => ({
  fetchUniswapV3BscShadowPools: vi.fn(async () => makeDirectApiResult()),
}));
vi.mock("../../lib/stablecoins-cache", async () => {
  const actual = await vi.importActual<typeof import("../../lib/stablecoins-cache")>("../../lib/stablecoins-cache");
  return {
    ...actual,
    loadStablecoinsCache: vi.fn(async () => phaseFixtures.current.stablecoinsCache),
  };
});
vi.mock("../../lib/dex-api-common", async () => {
  const actual = await vi.importActual<typeof import("../../lib/dex-api-common")>("../../lib/dex-api-common");
  return {
    ...actual,
    convertToGtNewPools: vi.fn(() => new Map()),
    extractPriceObservations: vi.fn(() => new Map()),
  };
});

import {
  DEX_LIQUIDITY_STAGE_LEAD_SEC,
  getCronSlotStartedAtForSchedule,
} from "@shared/lib/cron-jobs";
import {
  consumeDexLiquidityScoringStage as consumeScoringStage,
  filterPrimaryPoolsPreferDirectApi,
  stageDexLiquidityScoring,
} from "../dex-liquidity/orchestrator";
import {
  MissingDexLiquidityScoringStageError,
  loadDexLiquidityScoringStage,
  loadDexLiquidityScoringStageWhenReady,
  markDexLiquidityScoringStageConsumed,
  persistDexLiquidityScoringStage as persistStage,
} from "../dex-liquidity/scoring-stage";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { convertToGtNewPools, extractPriceObservations } from "../../lib/dex-api-common";
import { buildCurveLookups, fetchDataSources, buildKnownPoolAddresses } from "../dex-liquidity/fetch-primary";
import { fetchUniV3Data } from "../dex-liquidity/subgraph-source-families";
import { fetchFluidPools } from "../dex-liquidity/fetch-fluid";
import { fetchBalancerPools } from "../dex-liquidity/fetch-balancer";
import { fetchRaydiumPools } from "../dex-liquidity/fetch-raydium";
import { fetchOrcaPools } from "../dex-liquidity/fetch-orca";
import { fetchMeteoraPools } from "../dex-liquidity/fetch-meteora";
import { fetchPancakeSwapPools } from "../dex-liquidity/fetch-pancakeswap";
import { fetchSlipstreamPools } from "../dex-liquidity/fetch-slipstream";
import { fetchUniswapV3BscShadowPools } from "../dex-liquidity/fetch-uniswap-v3-bsc";
import {
  computeDexPrices,
  computeStablecoinScores,
  publishStablecoinScoreTargets as publishTargets,
  loadCurrentDexScoringGenerationId,
} from "../dex-liquidity/scoring";
import { logCronRun } from "../../lib/cron-logger";
import { persistScores, writeHistoricalSnapshots } from "../dex-liquidity/persistence";
import { publishDexPriceChallengerSnapshots } from "../dex-liquidity/challenger-publish";
import { buildSymbolLookups } from "../dex-liquidity/pool-helpers";
import { processPoolMetrics } from "../dex-liquidity/process-pools";
import { mergeStagedPools } from "../dex-liquidity/staging-merge";
import * as registryPersistence from "../dex-discovery/persistence";
import { readDexSourcePaginationState } from "../dex-liquidity/source-pagination-state";

/** Cache reads must miss: a fabricated row is a corrupt circuit record and fails closed. */
function firstRowFor(sql: string) {
  return async () => (sql.includes("FROM cache") ? null : { cnt: 0 });
}

function emptyStatement(sql: string) {
  return {
    bind: () => ({
      all: async () => ({ results: [] }),
      first: firstRowFor(sql),
      run: async () => ({ success: true, meta: {} }),
    }),
    all: async () => ({ results: [] }),
    first: firstRowFor(sql),
    run: async () => ({ success: true, meta: {} }),
  };
}

const db = makeNoopD1({
  prepare: emptyStatement,
  batch: async () => [],
  exec: async () => ({ count: 0, duration: 0 }),
  dump: async () => new ArrayBuffer(0),
});

/** A guard fixture that silently answers an unmodelled query hides SQL drift. */
function strictStubOrThrow(sql: string) {
  // Incidental cache traffic stays permissive; unknown guard SQL must still fail.
  if (sql.includes("FROM cache") || sql.includes("INTO cache")) {
    return emptyStatement(sql);
  }
  throw new Error(`Unexpected D1 query in sync-dex-liquidity test: ${sql}`);
}

function guardDatabase(tables: Array<MockTableConfig & { alsoMatch?: string }>, overrides: Record<string, unknown> = {}) {
  return makeNoopD1({
    prepare: (sql: string) => {
      const table = tables.find(({ match, alsoMatch }) => sql.includes(match) && (!alsoMatch || sql.includes(alsoMatch)));
      return table ? mockD1([table]).prepare(sql) : strictStubOrThrow(sql);
    },
    ...overrides,
  });
}

/** Drive the scheduled composition: the stage producer followed by its consumer. */
async function runScoringCycle(
  database: D1Database = db,
  graphApiKey: string | null = "graph-key",
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  reportProgress?: CronProgressReporter,
  options?: { publishShadowTargets?: boolean },
): Promise<CronResult> {
  await stageDexLiquidityScoring(database, graphApiKey, signal, coingeckoApiKey, chainRpcs, reportProgress);
  return await consumeScoringStage(database, signal, reportProgress, undefined, options);
}

function readMetadata(result: CronResult) { return JSON.parse(result.metadata ?? "{}"); }
const stageSource = () => stageDexLiquidityScoring(db, "graph-key");

function apiResult(pools: DexApiPool[] = [], extra: Partial<Awaited<ReturnType<typeof fetchOrcaPools>>> = {}) {
  return { pools, ok: true, degraded: false, errors: [] as string[], ...extra };
}

function apiPool(overrides: Partial<DexApiPool> & Pick<DexApiPool, "balances">): DexApiPool {
  return {
    source: "fluid", chain: "Ethereum", poolAddress: "0x1111111111111111111111111111111111111111", poolType: "fluid",
    tokens: [{ address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 }, { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 }],
    price: 1, tvlUsd: 100_000, volume24hUsd: 10_000, feeRate: 0.0001, ...overrides,
  };
}

function llamaPool(overrides: Pick<LlamaPool, "pool" | "chain" | "project" | "symbol" | "tvlUsd" | "underlyingTokens"> & Partial<LlamaPool>): LlamaPool {
  return {
    volumeUsd1d: null, volumeUsd7d: null, stablecoin: false, apyBase: null, apyReward: null,
    apy: 0, sigma: 0, exposure: "multi", count: 20, ...overrides,
  };
}

function makeTrackedStablecoin(id: string, symbol: string, price: number): StablecoinData {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id,
    name: symbol,
    symbol,
    geckoId: null,
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price,
    priceSource: "pyth",
    priceConfidence: "single-source",
    priceUpdatedAt: nowSec,
    priceObservedAt: nowSec,
    priceObservedAtMode: "upstream",
    priceSyncedAt: nowSec,
    consensusSources: ["pyth"],
    agreeSources: ["pyth"],
    supplySource: "defillama",
    circulating: { peggedUSD: 1_000_000 },
    circulatingPrevDay: {},
    circulatingPrevWeek: {},
    circulatingPrevMonth: {},
    chainCirculating: {},
    chains: [],
  };
}

describe("dex liquidity scoring stage cycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    phaseFixtures.reset();
    vi.mocked(convertToGtNewPools).mockReturnValue(new Map());
    vi.mocked(extractPriceObservations).mockReturnValue(new Map());
    vi.mocked(loadCurrentDexScoringGenerationId).mockResolvedValue(null);
  });

  it("overlaps only the independent serial CL capture families and settles them before staging", async () => {
    const v4Started = deferred<void>();
    const quoterFinished = deferred<void>();
    const order: string[] = [];
    const refresh = vi.spyOn(priceRefresh, "refreshPoolPrices");
    const tail = vi.spyOn(priceRefresh, "priceRefreshDeadlines");
    vi.spyOn(quoterEnrichment, "enrichQuoterV2ExecutionTargets").mockImplementationOnce(async () => {
      order.push("quoter-start");
      await v4Started.promise;
      order.push("quoter-end");
      quoterFinished.resolve();
      return { exactPoolCount: 0, exactCapableAssets: [], telemetry: [] };
    });
    vi.spyOn(v4Enrichment, "enrichUniswapV4ExecutionTargets").mockImplementationOnce(async () => {
      order.push("v4-start");
      v4Started.resolve();
      await quoterFinished.promise;
      order.push("v4-end");
      return [];
    });
    await stageSource();
    expect(order).toEqual(["quoter-start", "v4-start", "quoter-end", "v4-end"]);
    expect(refresh.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(mergeStagedPools).mock.invocationCallOrder[0]!);
    expect(tail).toHaveBeenCalledOnce();
    expect(persistStage).toHaveBeenCalledOnce();
  });

  it("evaluates late source-stage exact captures at the consumer clock without restamping registry volume", async () => {
    const sourceClock = Date.parse("2026-10-11T12:10:00Z") / 1000;
    const consumerClock = sourceClock + 360;
    phaseFixtures.current.stagedPools.registryEvaluatedAtSec = sourceClock + 180;
    const clock = vi.spyOn(Date, "now").mockReturnValue(sourceClock * 1000);
    try {
      await stageSource();
      expect(scoringStage.syncStartSec).toBe(sourceClock);
      clock.mockReturnValue(consumerClock * 1000);
      await consumeScoringStage(db);
      const calls = vi.mocked(computeStablecoinScores).mock.calls;
      const call = calls[calls.length - 1]!;
      expect(call[4]).toBe(consumerClock);
      expect(call[9]).toBe(sourceClock + 180);
      // A pinned block captured four minutes into the stage is not future
      // relative to consumption; the old stage-start clock rejected it.
      expect(sourceClock + 240).toBeLessThanOrEqual(Number(call[4]));
      expect(scoringStage.syncStartSec).toBe(sourceClock);
      expect(vi.mocked(publishDexPriceChallengerSnapshots).mock.lastCall?.[1]).toMatchObject({
        snapshotAt: sourceClock, generationId: expect.any(String),
      });
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["registry", "stage", "after-stage"] as const)(
    "leaves a fetched tail retryable after %s failure and acknowledges its replay",
    async (failure) => {
      const fixture = createLatestSchemaSqlite();
      const database = {
        ...db,
        prepare: (sql: string) => sql.includes("dex_source_pagination_state")
          ? fixture.db.prepare(sql) : db.prepare(sql),
      } as D1Database;
      const controller = new AbortController();
      const failureError = new Error(`injected ${failure} failure`);
      const persistedStage = vi.mocked(persistStage).getMockImplementation()!;
      const fetchTail = async () => {
        vi.mocked(fetchOrcaPools).mockResolvedValueOnce(apiResult([], { pendingPaginationUpdates: [{
            sourceKey: "orca:solana", cursor: "page9", cycleStartedAt: 100, nowSec: 100,
            completed: false, pagesFetched: 4, diagnostics: [],
            expectedRevision: (await readDexSourcePaginationState(database, "orca:solana")).revision!,
            generation: crypto.randomUUID(),
          }] }));
      };
      try {
        await fetchTail();
        if (failure === "registry") {
          vi.spyOn(registryPersistence, "upsertStagedPools").mockRejectedValueOnce(failureError);
        } else if (failure === "stage") {
          vi.mocked(persistStage).mockRejectedValueOnce(failureError);
        } else {
          vi.mocked(persistStage).mockImplementationOnce(async (...args) => {
            const result = await persistedStage(...args);
            controller.abort(failureError);
            return result;
          });
        }
        const first = stageDexLiquidityScoring(database, "graph-key", controller.signal);
        if (failure === "registry") await first;
        else await expect(first).rejects.toBe(failureError);
        expect(await readDexSourcePaginationState(database, "orca:solana")).toMatchObject({ cursor: null });
        await fetchTail();
        await stageDexLiquidityScoring(database, "graph-key");
        expect(await readDexSourcePaginationState(database, "orca:solana")).toMatchObject({ cursor: "page9" });
      } finally {
        fixture.sqlite.close();
      }
    },
  );
  it("scopes Yearn vaults", async () => {
    const refresh = priceRefresh.refreshPoolPrices;
    vi.spyOn(priceRefresh, "refreshPoolPrices").mockImplementationOnce(async (...args) => {
      const summary = await refresh(...args);
      summary.demand.networks = Array(100).fill({ network: "ethereum", pools: 1, requests: 1 });
      return summary;
    });
    const real = await vi.importActual<typeof import("../dex-liquidity/process-pools")>("../dex-liquidity/process-pools");
    const pools = Array.from({ length: 67 }, (_, i) => llamaPool({ pool: `7d89af7a-24c9-4292-aa38-0000000000${i + 10}`, project: "yearn-finance", chain: "Ethereum",
      symbol: "", poolMeta: null, underlyingTokens: ["0x0000000000000000000000000000000000000000"], exposure: "single",
      tvlUsd: i ? 2_000_000 : 11_399_064 }));
    vi.mocked(processPoolMetrics).mockImplementationOnce(real.processPoolMetrics);
    Object.assign(phaseFixtures.current.primary, { pools, rawPoolCount: 67, dexProjects: new Set(["uniswap-v3"]), nonDexProjects: new Set(["yearn-finance"]) });
    for (const [job, result] of [["sync-dex-liquidity-stage", await stageSource()], ["sync-dex-liquidity", await consumeScoringStage(db)]] as const) {
      expect(Buffer.byteLength(result.metadata!)).toBeLessThanOrEqual(getCronMetadataBudgetBytes(job));
      expect(result.status).toBe("ok");
      const metadata = readMetadata(result);
      expect(metadata.reason).toBeUndefined();
      expect(metadata.poolRejections[0]).toMatchObject({ scope: "non-dex-project", protocol: "yearn-finance" });
      expect(metadata.poolRejectionMateriality).toMatchObject({ rejectedPoolCount: 67, rejectedPoolTvlUsd: 143_399_064,
        outOfScopeRejectedPoolCount: 67, candidateRejectedPoolCount: 0, candidateRejectedPoolTvlUsd: 0, detailsOmitted: 63, material: false });
    }
    const chunk = scoringStage.chunks[0]!;
    const [header, ...rest] = chunk.payload.split("\n");
    const legacy = JSON.parse(header!);
    delete legacy.pool.poolRejections[0].scope;
    chunk.payload = [JSON.stringify(legacy), ...rest].join("\n");
    chunk.payloadBytes = Buffer.byteLength(chunk.payload);
    vi.mocked(persistScores).mockClear();
    const held = await consumeScoringStage(db);
    expect([held.status, readMetadata(held).reason, readMetadata(held).poolRejections[0].scope])
      .toEqual(["degraded", "pool-rejection-scope-unavailable", "unknown-project"]);
    expect(persistScores).not.toHaveBeenCalled();
  });

  it("throws on catastrophic source failure instead of silently returning", async () => {
    phaseFixtures.reset({ primary: null });
    await expect(runScoringCycle()).rejects.toThrow("catastrophic source failure");
  });

  it.each([
    {
      label: "surfaces a missing mandatory staging table from the producer",
      producer: vi.mocked(mergeStagedPools),
      message: "D1_ERROR: no such table: dex_pool_registry",
    },
    {
      label: "surfaces a missing mandatory history table from the scoring producer",
      producer: vi.mocked(computeStablecoinScores),
      message: "D1_ERROR: no such table: dex_liquidity_history",
    },
  ])("$label", async ({ producer, message }) => {
    producer.mockRejectedValueOnce(new Error(message));
    await expect(runScoringCycle()).rejects.toThrow(message);
  });

  it("returns degraded when non-catastrophic critical source family fails", async () => {
    phaseFixtures.reset({ primary: phaseFixtures.primary({ dlProtocolsAvailable: false }) });

    const result = await runScoringCycle();

    expect(result.status).toBe("degraded");
    const metadata = readMetadata(result);
    expect(metadata.failedSources).toContain("defillama-protocols");
    expect(metadata.fallbackMode).toContain("dl-protocols-unavailable");
    expect(metadata.rowsWritten).toBe(0);
    expect(metadata.persistence?.skipped).toBe(true);
    expect(metadata.persistence?.skippedReason).toBe("defillama-protocols-unavailable");
    expect(persistScores).not.toHaveBeenCalled();
    expect(publishTargets).not.toHaveBeenCalled();
    expect(computeDexPrices).not.toHaveBeenCalled();
    expect(publishDexPriceChallengerSnapshots).not.toHaveBeenCalled();
    expect(writeHistoricalSnapshots).not.toHaveBeenCalled();
  });

  it("records the failed critical source as the stage degraded reason", async () => {
    phaseFixtures.reset({ primary: phaseFixtures.primary({ dlProtocolsAvailable: false }) });

    const result = await stageSource();

    expect(result.status).toBe("degraded");
    expect(readMetadata(result).reason).toBe("defillama-protocols-unavailable");
    const fixture = createLatestSchemaSqlite();
    try {
      await logCronRun(fixture.db, "sync-dex-liquidity-stage", async () => result);
      const run = fixture.sqlite
        .prepare("SELECT status, degraded_reason FROM cron_runs WHERE job = ?")
        .get("sync-dex-liquidity-stage") as
          | { status: string; degraded_reason: string | null }
          | undefined;
      expect(run).toEqual({ status: "degraded", degraded_reason: "defillama-protocols-unavailable" });
    } finally {
      fixture.sqlite.close();
    }
  });

  it("returns degraded when DL fails but Curve succeeds", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce(phaseFixtures.primary({ curvePayloads: [{ data: { poolData: [] } }], dlYieldsAvailable: false, dlProtocolsAvailable: false }));

    const result = await runScoringCycle();

    expect(result.status).toBe("degraded");
    const metadata = readMetadata(result);
    expect(metadata.failedSources).toContain("defillama-yields");
    expect(persistScores).not.toHaveBeenCalled();
    expect(publishTargets).not.toHaveBeenCalled();
    expect(publishDexPriceChallengerSnapshots).not.toHaveBeenCalled();
  });

  it.each([
    ["COUNT(*) as cnt FROM dex_liquidity", "coverage-count-read-failed"],
    ["SELECT total_tvl_usd, updated_at", "global-tvl-read-failed"],
    ["ORDER BY total_tvl_usd DESC", "top-ten-read-failed"],
    ["FROM cron_runs", "cron-history-read-failed"],
  ])("retains accepted rows and generation when %s is unreadable", async (match, reason) => {
    const fixture = createLatestSchemaSqlite();
    try {
      fixture.sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
        (generation_id, started_at, state, expected_row_count, created_at)
        VALUES ('accepted', 1700000000, 'published', 2, 1700000000)`).run();
      const insert = fixture.sqlite.prepare(`INSERT INTO dex_liquidity
        (stablecoin_id, symbol, total_tvl_usd, liquidity_score, coverage_class, updated_at,
         publication_generation_id, publication_state)
        VALUES (?, 'USD', 100, 80, 'primary', 1700000000, 'accepted', 'published')`);
      insert.run("usdt-tether");
      insert.run("__global__");
      const failedReadDb = mockD1([{ match, rows: [], throwError: new Error("baseline read failed") }]);
      const database = {
        ...fixture.db,
        prepare: (sql: string) => sql.includes(match) ? failedReadDb.prepare(sql) : fixture.db.prepare(sql),
      };
      const result = await runScoringCycle(database, "graph-key");
      expect(result.status).toBe("degraded");
      const metadata = readMetadata(result);
      expect(metadata).toMatchObject({
        reason: "required-baseline-read-failed",
        rowsWritten: 0,
        sourceCoverage: { baselineReadFailures: [reason] },
        persistence: { skipped: true, skippedReason: "required-baseline-read-failed" },
      });
      expect(DexLiquidityCronMetadataSchema.safeParse(metadata).success).toBe(true);
      expect(fixture.sqlite.prepare(`SELECT stablecoin_id, total_tvl_usd, updated_at,
        publication_generation_id FROM dex_liquidity ORDER BY stablecoin_id`).all()).toEqual([
        { stablecoin_id: "__global__", total_tvl_usd: 100, updated_at: 1700000000, publication_generation_id: "accepted" },
        { stablecoin_id: "usdt-tether", total_tvl_usd: 100, updated_at: 1700000000, publication_generation_id: "accepted" },
      ]);
      expect(persistScores).not.toHaveBeenCalled();
      expect(publishTargets).not.toHaveBeenCalled();
      expect(computeDexPrices).not.toHaveBeenCalled();
      expect(writeHistoricalSnapshots).not.toHaveBeenCalled();
      expect(markDexLiquidityScoringStageConsumed).not.toHaveBeenCalled();
    } finally {
      fixture.sqlite.close();
    }
  });

  it.each([
    ["GROUP BY coverage_class", "coverage-classes-read-failed"],
    ["SELECT stablecoin_id, pool_count", "watchlist-read-failed"],
    ["FROM dex_liquidity_run_rows r", "coin-tvl-read-failed"],
  ])("does not turn optional %s telemetry into a publication hold", async (match, reason) => {
    const failedReadDb = mockD1([{ match, rows: [], throwError: new Error("optional baseline unavailable") }]);
    const database = { ...db, prepare: (sql: string) => sql.includes(match) ? failedReadDb.prepare(sql) : db.prepare(sql) };
    const result = await runScoringCycle(database, "graph-key");
    expect(result.status).toBe("ok");
    expect(readMetadata(result).sourceCoverage.baselineReadFailures).toEqual([reason]);
    expect(persistScores).toHaveBeenCalledOnce();
    expect(publishTargets).toHaveBeenCalledOnce();
  });

  it("degrades and skips persistence instead of tripping hard value guard when DL yields is unavailable", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce(phaseFixtures.primary({ dexProjects: new Set<string>(["curve"]), curvePayloads: [{ data: { poolData: [] } }], dlYieldsAvailable: false }));
    vi.mocked(computeStablecoinScores).mockResolvedValueOnce(phaseFixtures.scored({ scores: new Map([["usdt-tether", { coverageClass: "primary", tvl: 2_000_000_000 }]]), globalAgg: { totalTvl: 2_000_000_000 }, diagnostics: phaseFixtures.diagnostics() }) as unknown as Awaited<ReturnType<typeof computeStablecoinScores>>);
    const guardDb = guardDatabase([
      { match: "COUNT(*) as cnt FROM dex_liquidity", rows: [], first: { cnt: 165 } },
      { match: "SELECT total_tvl_usd, updated_at, chain_tvl_json FROM dex_liquidity WHERE stablecoin_id = '__global__'", rows: [], first: { total_tvl_usd: 6_000_000_000, updated_at: 1_777_556_412 } },
      { match: "GROUP BY coverage_class", rows: [] },
      { match: "ORDER BY total_tvl_usd DESC", rows: [{ stablecoin_id: "usdt-tether", total_tvl_usd: 4_000_000_000 }] },
      { match: "SELECT r.stablecoin_id, r.total_tvl_usd, r.protocol_tvl_json", rows: [] },
      { match: "FROM cron_runs", rows: [] },
      { match: "WHERE stablecoin_id IN", rows: [] },
    ], { batch: db.batch, exec: db.exec, dump: db.dump });

    const result = await runScoringCycle(guardDb, "graph-key");

    expect(result.status).toBe("degraded");
    const metadata = readMetadata(result);
    expect(metadata.failedSources).toContain("defillama-yields");
    expect(metadata.rowsWritten).toBe(0);
    expect(metadata.persistence?.skipped).toBe(true);
    expect(metadata.persistence?.skippedReason).toBe("defillama-yields-unavailable");
    expect(metadata.sourceCoverage?.currentGlobalTvl).toBe(2_000_000_000);
    expect(metadata.sourceCoverage?.nearValueGuard).toBe(true);
    // A critical source failure suppresses the hard abort but must not blank
    // the guard evaluation that says why the run is degraded.
    expect(metadata.sourceCoverage?.nearCoverageGuard).toBe(true);
    expect(metadata.sourceCoverage?.hardCoverageGuard).toBe(true);
    expect(persistScores).not.toHaveBeenCalled();
    expect(publishTargets).not.toHaveBeenCalled();
    expect(computeDexPrices).not.toHaveBeenCalled();
    expect(publishDexPriceChallengerSnapshots).not.toHaveBeenCalled();
  });

  it.each(["critical-source", "coverage", "value", "persistence"] as const)(
    "retains the measured target catalog after %s rejection and publishes only after accepted liquidity",
    async (rejection) => {
      let catalog = "accepted-targets";
      vi.mocked(publishTargets).mockImplementationOnce(async () => { catalog = "candidate-targets"; });
      if (rejection === "critical-source") phaseFixtures.current.primary.dlYieldsAvailable = false;
      if (rejection === "persistence") vi.mocked(persistScores).mockRejectedValueOnce(new Error("liquidity publication failed"));
      const guardDb = guardDatabase([
      { match: "SELECT coverage_class, COUNT(*) as cnt", rows: [] },
      { match: "COUNT(*) as cnt FROM dex_liquidity", rows: [], first: { cnt: rejection === "coverage" ? 100 : 0 } },
      { match: "SELECT total_tvl_usd, updated_at, chain_tvl_json FROM dex_liquidity WHERE stablecoin_id = '__global__'", rows: [], first: rejection === "value"
                ? { total_tvl_usd: 1_000_000_000, updated_at: 1_777_556_412 }
                : { total_tvl_usd: null, updated_at: null } },
      { match: "GROUP BY coverage_class", rows: [] },
      { match: "ORDER BY total_tvl_usd DESC", rows: [] },
      { match: "FROM cron_runs", rows: [] },
      { match: "WHERE stablecoin_id IN", rows: [] },
      { match: "SELECT r.stablecoin_id, r.total_tvl_usd, r.protocol_tvl_json", rows: [] },
    ]);
      if (rejection === "critical-source") {
        expect((await runScoringCycle(guardDb, "graph-key")).status).toBe("degraded");
      } else {
        await expect(runScoringCycle(guardDb, "graph-key")).rejects.toThrow(
          rejection === "persistence" ? "liquidity publication failed" : "coverage guard tripped",
        );
      }
      expect(catalog).toBe("accepted-targets");
      expect(publishTargets).not.toHaveBeenCalled();

      phaseFixtures.reset();
      expect((await runScoringCycle()).status).toBe("ok");
      expect(catalog).toBe("candidate-targets");
      expect(publishTargets).toHaveBeenCalledOnce();
      expect(vi.mocked(publishTargets).mock.invocationCallOrder[0]).toBeGreaterThan(
        vi.mocked(persistScores).mock.invocationCallOrder[vi.mocked(persistScores).mock.invocationCallOrder.length - 1]!,
      );
    },
  );

  it("publishes successful source inputs without direct CEX depth traffic or metadata", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await runScoringCycle();

    expect(result.status).toBe("ok");
    const metadata = readMetadata(result);
    expect(metadata.failedSources).toEqual([]);
    expect(metadata.stagedPoolsSkippedByExactIdentity).toBe(0);
    expect(metadata.stagedPoolsSkippedByUniqueDerivedIdentity).toBe(0);
    expect(metadata.sourceCoverage?.nearCoverageGuard).toBe(false);
    expect(metadata.sourceCoverage?.weakCoverageCoins).toBe(0);
    expect(metadata.sourceCoverage).not.toHaveProperty("directCexOrderbookDepth");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(persistScores).toHaveBeenCalledWith(
      expect.objectContaining({ prepare: expect.any(Function), batch: expect.any(Function) }),
      expect.any(Map),
      phaseFixtures.current.scores.scores,
      phaseFixtures.current.scores.globalAgg,
      expect.any(Number),
      phaseFixtures.current.scores.tvlStabilityMap,
      undefined,
      phaseFixtures.current.scores.diagnostics.routeRemovalEvidence,
      phaseFixtures.current.scores.retainedPoolsByStablecoin,
    );
    expect(metadata.sourceCoverage?.qualityDriftSeverity).toBe("none");
    expect(metadata.sourceCoverage?.qualityDriftFlags).toEqual([]);
    expect(metadata.sourceCoverage?.coinsWithoutMeasuredBalances).toBe(0);
    expect(metadata.sourceCoverage?.protocolTvlQuarantine?.tvlUsd).toBe(0);
  });

  it("carries partial-source telemetry through the stage into consumer metadata", async () => {
    vi.mocked(fetchPancakeSwapPools).mockResolvedValueOnce(apiResult([], { degraded: true, errors: ["bsc: The operation was aborted due to timeout"], degradedChains: ["bsc"] }));

    const stageResult = await stageSource();
    const stageQuality = getCronQualityReasons(readMetadata(stageResult));
    expect(readMetadata(stageResult).directApiSourceSummary.sourceWarnings).toEqual(["pancakeswap-api: bsc: The operation was aborted due to timeout"]);
    expect(stageResult.status).toBe("ok");
    expect(stageQuality).toEqual(["source-partial:pancakeswap-api:bsc", "direct-api-source-warnings"]);
    const result = await consumeScoringStage(db);

    const metadata = readMetadata(result);
    expect(metadata.degradedSources).toEqual(["pancakeswap-api:bsc"]);
    expect(metadata.failedSources).toEqual([]);
    expect(getCronQualityReasons(metadata)).toEqual(stageQuality);
  });

  it("reports failed optional stage sources as findings without failing successful staging", async () => {
    phaseFixtures.reset({ uniswapV4: {
      uniswapV4ExecutionCandidates: new Map(), failedChains: ["ethereum", "arbitrum"], chainFailures: [],
      exactAnsweredPoolIdsByChain: new Map(),
    } });
    const result = await stageSource();
    expect(result.status).toBe("ok");
    expect(getCronQualityReasons(readMetadata(result))).toEqual([
      "source-failed:uniswap-v4-subgraph:ethereum", "source-failed:uniswap-v4-subgraph:arbitrum",
    ]);
  });

  it("loads the source slot derived from the registered stage and consumer offsets", async () => {
    await stageSource();
    const scheduledAtMs = Date.parse("2026-09-22T12:16:00Z");
    const consumerSlot = getCronSlotStartedAtForSchedule("halfHourlyChartsOffset", scheduledAtMs);
    const sourceSlot = getCronSlotStartedAtForSchedule("halfHourlyOffset", scheduledAtMs);

    await consumeScoringStage(db, undefined, undefined, consumerSlot);

    expect(consumerSlot - DEX_LIQUIDITY_STAGE_LEAD_SEC).toBe(sourceSlot);
    expect(loadDexLiquidityScoringStageWhenReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ prepare: expect.any(Function), batch: expect.any(Function) }),
      expect.objectContaining({ expectedSourceSlotStartedAt: sourceSlot }),
      undefined,
    );
  });


  it("publishes active and shadow measured targets during the daily inventory cycle", async () => {
    await runScoringCycle(
      db,
      "graph-key",
      undefined,
      undefined,
      undefined,
      undefined,
      { publishShadowTargets: true },
    );

    const scoreCalls = vi.mocked(computeStablecoinScores).mock.calls;
    expect(scoreCalls[scoreCalls.length - 1]?.[8]).toBe("active-and-shadow");
  });



  it("accepts compacted production-scale primary rows while reporting raw counts", async () => {
    const rawPoolCount = 15_430;
    const lookups = buildSymbolLookups();
    const [trackedKey] = lookups.chainAddressToId.keys();
    expect(trackedKey).toBeDefined();
    const separator = trackedKey!.indexOf(":");
    const trackedChain = trackedKey!.slice(0, separator);
    const trackedAddress = trackedKey!.slice(separator + 1);
    const trackedPool: LlamaPool = llamaPool({
      pool: "tracked-pool",
      chain: trackedChain,
      project: "scale-dex",
      symbol: "TRACKED-QUOTE",
      tvlUsd: 1_000_000,
      volumeUsd1d: 50_000,
      volumeUsd7d: 300_000,
      underlyingTokens: [trackedAddress, "unknown-quote"],
    });
    vi.mocked(fetchDataSources).mockResolvedValueOnce(phaseFixtures.primary({ pools: [trackedPool], rawPoolCount, dexProjects: new Set(["scale-dex"]) }));
    const progressUpdates: CronProgressUpdate[] = [];

    const result = await runScoringCycle(db, "graph-key", undefined, undefined, undefined, async (update) => {
      progressUpdates.push(update);
    });

    const knownPoolCalls = vi.mocked(buildKnownPoolAddresses).mock.calls;
    const processPoolCalls = vi.mocked(processPoolMetrics).mock.calls;
    expect(knownPoolCalls[knownPoolCalls.length - 1]?.[0]).toEqual([trackedPool]);
    expect(processPoolCalls[processPoolCalls.length - 1]?.[0]?.pools).toEqual([trackedPool]);
    expect(readMetadata(result)).toMatchObject({ rowsRead: rawPoolCount });
    expect(progressUpdates.find((update) => update.stage === "primary-sources-loaded")).toMatchObject({
      metadata: { countTotals: { defillamaPools: rawPoolCount } },
    });
    expect(progressUpdates.find((update) => update.stage === "pool-processing")).toMatchObject({
      itemsTotal: rawPoolCount,
      metadata: {
        countTotals: {
          primaryPools: rawPoolCount,
          primaryPoolsRetained: 1,
        },
      },
    });
  });

  it("releases consumed source graphs before materializing staged pools", async () => {
    const lookups = buildSymbolLookups();
    const trackedEntry = [...lookups.chainAddressToId].find(
      ([key, stablecoinId]) => key.startsWith("ethereum:") && stablecoinId === "usdt-tether",
    );
    const quoteEntry = [...lookups.chainAddressToId].find(
      ([key, stablecoinId]) => key.startsWith("ethereum:") && stablecoinId === "usdc-circle",
    );
    expect(trackedEntry).toBeDefined();
    expect(quoteEntry).toBeDefined();
    const chain = "ethereum";
    const address = trackedEntry![0].slice("ethereum:".length);
    const quoteAddress = quoteEntry![0].slice("ethereum:".length);
    const primaryPool: LlamaPool = llamaPool({
      pool: "primary-pool",
      chain,
      project: "memory-dex",
      symbol: "TRACKED-QUOTE",
      tvlUsd: 1_000_000,
      volumeUsd1d: 50_000,
      volumeUsd7d: 300_000,
      stablecoin: false,
      underlyingTokens: [address, quoteAddress],
    });
    const sourceData = phaseFixtures.primary({ pools: [primaryPool], rawPoolCount: 1, dexProjects: new Set(["memory-dex"]) });
    const directPool: DexApiPool = {
      source: "fluid",
      chain,
      poolAddress: "0x1111111111111111111111111111111111111111",
      poolType: "fluid-dex",
      tokens: [
        { address, symbol: "TRACKED", decimals: 18 },
        { address: quoteAddress, symbol: "QUOTE", decimals: 18 },
      ],
      price: 1,
      tvlUsd: 1_000_000,
      volume24hUsd: 50_000,
      feeRate: 0.0005,
      balances: [1_000_000, 1_000_000],
    };
    const pancakePool: DexApiPool = {
      ...directPool,
      source: "pancakeswap",
      poolAddress: "0x3333333333333333333333333333333333333333",
      poolType: "pancakeswap-v3",
    };
    const directResult = apiResult([directPool], { pagination: {
        state: "partial" as const,
        headRefreshed: true,
        pagesFetched: 5,
        cursor: "next-page",
        cycleCompleted: false,
      } });
    const pancakeResult = apiResult([pancakePool]);
    const curvePoolMap = new Map([["curve-key", {} as never]]);
    const uniV3PoolFees = new Map([["fee-key", 500]]);
    const uniV3ExecutionCandidates = new Map([["candidate-key", []]]);

    vi.mocked(fetchFluidPools).mockResolvedValueOnce(directResult);
    vi.mocked(fetchPancakeSwapPools).mockResolvedValueOnce(pancakeResult);
    vi.mocked(fetchRaydiumPools).mockResolvedValueOnce(apiResult([], { warnings: ["release-warning"] }));
    vi.mocked(fetchDataSources).mockImplementationOnce(async () => {
      expect(fetchFluidPools).toHaveBeenCalledOnce();
      expect(fetchBalancerPools).toHaveBeenCalledOnce();
      expect(fetchPancakeSwapPools).toHaveBeenCalledOnce();
      expect(fetchMeteoraPools).toHaveBeenCalledOnce();
      expect(fetchRaydiumPools).toHaveBeenCalledOnce();
      expect(fetchOrcaPools).toHaveBeenCalledOnce();
      expect(fetchSlipstreamPools).toHaveBeenCalledTimes(2);
      expect(directResult.pools).toEqual([]);
      expect(pancakeResult.pools).toEqual([]);
      return sourceData;
    });
    vi.mocked(buildCurveLookups).mockResolvedValueOnce({
      curvePoolMap,
      curvePoolCandidatesByFingerprint: new Map(),
      priceObservations: new Map(),
    });
    vi.mocked(fetchUniV3Data).mockResolvedValueOnce({
      uniV3PoolFees,
      uniV3SymbolFees: new Map(),
      uniV3PriceObs: new Map(),
      uniV3ExecutionCandidates,
      failedChains: [],
      failedChainReasons: {},
      chainFailures: [],
    });
    vi.mocked(mergeStagedPools).mockImplementationOnce(
      async (_db, _metrics, _known, _now, _trackedDeployments, _references, confirmation, _counters, _signal, priceObservations) => {
        expect(sourceData.pools).toEqual([]);
        expect(sourceData.dexProjects.size).toBe(0);
        expect(directResult.pools).toEqual([]);
        expect(pancakeResult.pools).toEqual([]);
        expect(curvePoolMap.size).toBe(1);
        expect(uniV3PoolFees.size).toBe(1);
        expect(uniV3ExecutionCandidates.size).toBe(1);
        expect(confirmation?.enforcedChainsByProtocol.get("fluid")).toBeUndefined();
        expect(confirmation?.confirmedExactKeysByProtocol.get("fluid")).toBeUndefined();
        return {
          ...phaseFixtures.stagedPools(),
          stagedWriteback: buildStagedPoolWriteback(_metrics, _now),
          observedThisRun: priceRefresh.captureObservedPoolPrices({ metrics: _metrics, priceObservations }, _now),
        };
      },
    );

    const startedAt = Math.floor(Date.now() / 1000);
    const result = await runScoringCycle();
    expect(mergeStagedPools).toHaveBeenCalledOnce();
    const scoreCalls = vi.mocked(computeStablecoinScores).mock.calls;
    const scoreCall = scoreCalls[scoreCalls.length - 1];
    const pancakeTargets = scoreCall?.[5];
    expect([...pancakeTargets!.values()]).toContainEqual(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        adapterProfileId: "pancakeswap-v3-quoter-v2",
        poolId: "ethereum:0x3333333333333333333333333333333333333333",
        poolTokenAddresses: [address, quoteAddress],
        tokenIn: expect.objectContaining({ address, trackedAssetId: "usdt-tether" }),
        tokenOut: expect.objectContaining({ address: quoteAddress, trackedAssetId: "usdc-circle" }),
        feePips: 500,
        retainedTvlUsd: 1_000_000,
        capturedAt: expect.any(Number),
      }),
    );
    expect([...pancakeTargets!.values()].every((target) => target.capturedAt >= startedAt)).toBe(true);
    const metadata = readMetadata(result);
    expect(metadata.directApiSourceSummary?.sourceWarnings).toContain("raydium-api: release-warning");
    expect(metadata.directApiSourceSummary?.pagination).toContainEqual({
      source: "fluid-dex-api",
      state: "partial",
      headRefreshed: true,
      pagesFetched: 5,
      cursor: "next-page",
      cycleCompleted: false,
    });
  });

  it("keeps the run ok when an optional direct API source is unavailable but coverage stays intact", async () => {
    vi.mocked(fetchRaydiumPools).mockResolvedValueOnce(apiResult([], { ok: false, degraded: true, errors: ["query poolType type error"] }));

    const result = await runScoringCycle();

    expect(result.status).toBe("ok");
    const metadata = readMetadata(result);
    expect(metadata.failedSources).toContain("raydium-api");
    expect(metadata.fallbackMode).toContain("raydium-api-unavailable");
    expect(metadata.sourceCoverage?.sourceDegradedFamilies).toEqual([]);
    expect(persistScores).toHaveBeenCalled();
  });

  it("carries BSC Uniswap V3 direct candidates into the shadow target accumulator", async () => {
    const pool: DexApiPool = apiPool({ source: "uniswap-v3-shadow", chain: "bsc", poolAddress: "0xf150d29d92e7460a1531cbc9d1abeab33d6998e4", poolType: "uniswap-v3", tokens: [
        { address: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT", decimals: 18 },
        { address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", symbol: "USD1", decimals: 18 },
      ], tvlUsd: 2_000_000, volume24hUsd: 50_000, balances: [1_000_000, 1_000_000] });
    vi.mocked(fetchUniswapV3BscShadowPools).mockResolvedValueOnce(apiResult([pool]));

    await runScoringCycle();

    const scoreCalls = vi.mocked(computeStablecoinScores).mock.calls;
    const scoreCall = scoreCalls[scoreCalls.length - 1];
    const shadowTargets = scoreCall?.[7];
    expect([...shadowTargets!.values()]).toContainEqual(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        adapterProfileId: "uniswap-v3-quoter-v2",
        chain: "bsc",
        poolId: "bsc:0xf150d29d92e7460a1531cbc9d1abeab33d6998e4",
        feePips: 100,
        retainedTvlUsd: 2_000_000,
      }),
    );
  });

  it("waits for direct API fetches before loading primary and subgraph sources", async () => {
    const fluidGate = deferred<ReturnType<typeof makeDirectApiResult>>();
    const entered = deferred<void>();
    vi.mocked(fetchFluidPools).mockImplementationOnce(() => {
      entered.resolve();
      return fluidGate.promise;
    });

    const syncPromise = runScoringCycle();

    try {
      await entered.promise;
      expect(fetchDataSources).not.toHaveBeenCalled();
      expect(fetchUniV3Data).not.toHaveBeenCalled();
    } finally {
      fluidGate.resolve(makeDirectApiResult());
      await syncPromise;
    }
    expect(fetchDataSources).toHaveBeenCalledOnce();
    expect(fetchUniV3Data).toHaveBeenCalledOnce();
  });

  it("threads tracked stablecoin cache prices into direct API conversion and observations", async () => {
    let convertedStablecoinPrices: Map<string, number> | undefined;
    let observedStablecoinPrices: Map<string, number> | undefined;
    const fluidPool: DexApiPool = apiPool({ poolType: "fluid-dex", tvlUsd: 500_000, volume24hUsd: 120_000, balances: [250_000, 250_000] });
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok",
      updatedAt: 123,
      payload: {
        peggedAssets: [
          makeTrackedStablecoin("usdc-circle", "USDC", 0.97),
          makeTrackedStablecoin("usdt-tether", "USDT", 1.01),
          makeTrackedStablecoin("ignored-zero", "ZERO", 0),
        ],
      },
    });
    vi.mocked(fetchFluidPools).mockResolvedValueOnce(apiResult([fluidPool]));
    vi.mocked(convertToGtNewPools).mockImplementationOnce((...args) => {
      convertedStablecoinPrices = new Map(args[4]);
      return new Map([["usdc-circle", []]]);
    });
    vi.mocked(extractPriceObservations).mockImplementationOnce((...args) => {
      observedStablecoinPrices = new Map(args[4]);
      return new Map([["usdc-circle", []]]);
    });

    await runScoringCycle();

    expect(convertedStablecoinPrices).toBeInstanceOf(Map);
    expect(Array.from(convertedStablecoinPrices?.entries() ?? [])).toEqual([
      ["usdc-circle", 0.97],
      ["usdt-tether", 1.01],
    ]);

    expect(observedStablecoinPrices).toBeInstanceOf(Map);
    expect(Array.from(observedStablecoinPrices?.entries() ?? [])).toEqual([
      ["usdc-circle", 0.97],
      ["usdt-tether", 1.01],
    ]);
  });

  it("prices a euro quote from FX references when the stablecoins cache is unusable", async () => {
    let observations: unknown;
    const publishPrices = vi.mocked(computeDexPrices).getMockImplementation()!;
    vi.mocked(computeDexPrices).mockImplementationOnce(async (...args) => {
      observations = structuredClone(args[0].exactPriceEvidenceByStablecoin?.get("usdc-circle"));
      return publishPrices(...args);
    });
    vi.spyOn(priceValidation, "loadPriceValidationReferences").mockResolvedValueOnce({
      rates: { peggedEUR: 1.25 }, type: "fresh", updatedAt: Math.floor(Date.now() / 1000),
    });
    vi.mocked(convertToGtNewPools).mockImplementation(realPoolShaping.convertToGtNewPools);
    vi.mocked(extractPriceObservations).mockImplementation(realPoolShaping.extractPriceObservations);
    vi.mocked(fetchFluidPools).mockResolvedValueOnce(apiResult([apiPool({ tokens: [
          { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
          { address: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c", symbol: "EURC", decimals: 6 },
        ], price: 0.8, tvlUsd: 1_000_000, volume24hUsd: 100_000, balances: [500_000, 400_000] })]));

    await runScoringCycle();

    expect(observations).toEqual([
      expect.objectContaining({ price: 1, protocol: "fluid", sourceFamily: "direct_api" }),
    ]);
    const converted = vi.mocked(convertToGtNewPools).mock.results.flatMap((result) =>
      result.type === "return" ? result.value.get("usdc-circle") ?? [] : [],
    );
    expect(converted).toEqual([
      expect.objectContaining({ address: "0x1111111111111111111111111111111111111111", price: 1 }),
    ]);
  });

  it("records drift and evidence telemetry when previous run metadata exists", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce(phaseFixtures.primary({ protocolTvlCaps: new Map<string, number>([["curve", 50]]) }));
    vi.mocked(fetchFluidPools).mockResolvedValueOnce(apiResult([
        apiPool({ poolAddress: "0xfluid-pool", balances: [50_000_000_000, 50_000_000_000] }),
      ]));
    vi.mocked(extractPriceObservations).mockReturnValueOnce(
      new Map([
        [
          "usdc-circle",
          [
            {
              sourceFamily: "gecko_terminal",
              price: 1,
              tvl: 100,
              chain: "Ethereum",
              protocol: "curve",
            },
          ],
        ],
      ]),
    );
    vi.mocked(computeStablecoinScores).mockResolvedValueOnce(phaseFixtures.scored({ scores: new Map([
        [
          "usdc-circle",
          {
            coverageClass: "fallback",
            coverageConfidence: 0.55,
            tvl: 100,
            balanceMeasuredTvlUsd: 0,
            sourceMix: { gecko_terminal: { poolCount: 1, tvlUsd: 100 } },
          },
        ],
      ]), globalAgg: { totalTvl: 100 }, retainedPoolsByStablecoin: new Map([
        [
          "usdc-circle",
          [
            {
              source: "gecko_terminal",
              tvlUsd: 100,
              project: "curve",
              extra: { measurement: { balanceMeasured: false } },
            },
          ],
        ],
      ]), diagnostics: phaseFixtures.diagnostics({ protocolTvlQuarantine: { reason: "fallback-protocol-tvl-exceeds-headroom", poolCount: 1, protocolCount: 1, tvlUsd: 50 }, globalProtocolOverCapUsd: 60 }) }) as unknown as Awaited<ReturnType<typeof computeStablecoinScores>>);

    const driftDb = guardDatabase([
      { match: "COUNT(*) as cnt FROM dex_liquidity", rows: [], first: { cnt: 5 } },
      { match: "SELECT total_tvl_usd, updated_at, chain_tvl_json FROM dex_liquidity WHERE stablecoin_id = '__global__'", rows: [], first: { total_tvl_usd: 100 } },
      { match: "GROUP BY coverage_class", rows: [] },
      { match: "ORDER BY total_tvl_usd DESC", rows: [{ stablecoin_id: "usdc-circle", total_tvl_usd: 100 }] },
      { match: "SELECT r.stablecoin_id, r.total_tvl_usd, r.protocol_tvl_json", rows: [] },
      { match: "SELECT started_at, status, metadata", alsoMatch: "cron_runs", rows: [{ started_at: 1, status: "ok", metadata: JSON.stringify({
        stagedPoolsMerged: 10,
        stagedPoolsSkipped: 0,
        sourceCoverage: {
          dlYieldsAvailable: true,
          dlProtocolsAvailable: true,
          currentGlobalTvl: 100,
          priceObservationCoins: 5,
          measuredBalanceCoveragePct: 0.5,
          weakCoverageCoins: 0,
          // Conditions already observed once: this run is the
          // second consecutive one, so each flag confirms.
          qualityDriftCandidates: [
            { flag: "price-observation-drop", consecutiveRuns: 1, baselineValue: 5, observedValue: 1 },
            { flag: "measured-balance-drop", consecutiveRuns: 1, baselineValue: 0.5, observedValue: 0 },
            { flag: "watchlist-pool-drop:usdc-circle", consecutiveRuns: 1, baselineValue: 5, observedValue: 1 },
          ],
        },
      }) }] },
      { match: "WHERE stablecoin_id IN", rows: [{ stablecoin_id: "usdc-circle", pool_count: 5, coverage_confidence: 0.9, total_tvl_usd: 100, balance_measured_tvl_usd: 50 }] },
    ], { batch: db.batch, exec: db.exec, dump: db.dump });

    const result = await runScoringCycle(driftDb, "graph-key");
    const metadata = readMetadata(result);

    expect(metadata.sourceCoverage?.qualityDriftSeverity).toBe("high");
    expect(metadata.sourceCoverage?.qualityDriftFlags).toEqual(
      expect.arrayContaining(["price-observation-drop", "measured-balance-drop", "watchlist-pool-drop:usdc-circle"]),
    );
    expect(metadata.sourceCoverage?.coinsWithoutMeasuredBalances).toBe(1);
    expect(metadata.sourceCoverage?.coinsGtOnly).toBe(1);
    expect(metadata.sourceCoverage?.coinsCrawlerOnly).toBe(1);
    expect(metadata.sourceCoverage?.coinsPriceOnlyNoMeasuredLiquidity).toBe(1);
    expect(DexLiquidityCronMetadataSchema.parse(metadata).sourceCoverage?.globalProtocolOverCapUsd).toBe(60);
    expect(DexLiquidityCronMetadataSchema.parse(metadata).sourceCoverage?.protocolTvlQuarantine).toEqual({
      reason: "fallback-protocol-tvl-exceeds-headroom", poolCount: 1, protocolCount: 1, tvlUsd: 50,
    });
    expect(metadata.sourceCoverage?.topAssetCoverageDeltas).toEqual([
      expect.objectContaining({ stablecoinId: "usdc-circle", poolCountPctDelta: -0.8 }),
      expect.objectContaining({ stablecoinId: "usdt-tether", poolCountPctDelta: null }),
      expect.objectContaining({ stablecoinId: "dai-makerdao", poolCountPctDelta: null }),
      expect.objectContaining({ stablecoinId: "usds-sky", poolCountPctDelta: null }),
      expect.objectContaining({ stablecoinId: "usde-ethena", poolCountPctDelta: null }),
    ]);
  });
});

describe("dex liquidity stage same-hour recovery", () => {
  const openDatabases: DatabaseSync[] = [];
  const scheduledAtMs = Date.parse("2026-09-23T15:16:00Z");
  const consumerSlot = getCronSlotStartedAtForSchedule("halfHourlyChartsOffset", scheduledAtMs);
  const sourceSlot = consumerSlot - DEX_LIQUIDITY_STAGE_LEAD_SEC;
  const halfHourSlot = getCronSlotStartedAtForSchedule(
    "halfHourlyChartsOffset",
    Date.parse("2026-09-23T15:46:00Z"),
  );

  interface RecoveryHarness {
    sqlite: DatabaseSync;
    db: D1Database;
  }

  let harness: RecoveryHarness;
  let actualScoringStage: typeof import("../dex-liquidity/scoring-stage");

  beforeAll(async () => {
    actualScoringStage = await vi.importActual<typeof import("../dex-liquidity/scoring-stage")>(
      "../dex-liquidity/scoring-stage",
    );
  });

  function openHarness(): RecoveryHarness {
    const harness = createLatestSchemaSqlite();
    openDatabases.push(harness.sqlite);
    return harness;
  }

  function consumeStage(harness: RecoveryHarness, options?: Parameters<typeof consumeScoringStage>[4], slot = consumerSlot, signal?: AbortSignal) {
    return consumeScoringStage(harness.db, signal, undefined, slot, options);
  }

  function recordStageRunError(harness: RecoveryHarness) {
    harness.sqlite.prepare(
      `INSERT INTO cron_runs (job, started_at, duration_ms, status, slot_started_at)
       VALUES ('sync-dex-liquidity-stage', ?, 83_449, 'error', ?)`,
    ).run(sourceSlot + 13, sourceSlot);
  }

  function recordLiveStageLease(harness: RecoveryHarness, leaseUntil = Math.floor(scheduledAtMs / 1000) + 300) {
    harness.sqlite.prepare(
      `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES ('sync-dex-liquidity-stage', 'stage-owner', ?, ?, ?)`,
    ).run(leaseUntil, Math.floor(scheduledAtMs / 1000), Math.floor(scheduledAtMs / 1000));
  }

  function usePollingClock() {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(scheduledAtMs);
  }

  /** Produce the exact slot's real stage generation through the real producer. */
  async function stageHourGeneration(harness: RecoveryHarness) {
    await stageDexLiquidityScoring(
      harness.db,
      "graph-key",
      undefined,
      undefined,
      undefined,
      undefined,
      sourceSlot,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const sqlite of openDatabases.splice(0)) sqlite.close();
  });

  beforeEach(() => {
    // Pin the incident clock so slot ages, leases, and run stamps are exact.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(scheduledAtMs);
    vi.clearAllMocks();
    phaseFixtures.reset();
    vi.mocked(loadCurrentDexScoringGenerationId).mockResolvedValue(null);
    // SQLite owns producer, persistence, load and consumption; scoring/publication remain mocked.
    vi.mocked(persistStage).mockImplementation(
      actualScoringStage.persistDexLiquidityScoringStage,
    );
    vi.mocked(loadDexLiquidityScoringStage).mockImplementation(
      actualScoringStage.loadDexLiquidityScoringStage,
    );
    vi.mocked(loadDexLiquidityScoringStageWhenReady).mockImplementation(
      actualScoringStage.loadDexLiquidityScoringStageWhenReady,
    );
    vi.mocked(markDexLiquidityScoringStageConsumed).mockImplementation(
      actualScoringStage.markDexLiquidityScoringStageConsumed,
    );
    harness = openHarness();
  });

  it("consumes ready output once across both ticks and retries of :16", async () => {
    const refresh = vi.spyOn(priceRefresh, "refreshPoolPrices");
    await stageHourGeneration(harness);
    await consumeStage(harness);
    vi.mocked(loadCurrentDexScoringGenerationId).mockResolvedValue(`dex-liquidity-${Math.floor(scheduledAtMs / 1_000)}`);
    for (const slot of [consumerSlot, halfHourSlot]) {
      const result = await consumeStage(harness, undefined, slot);
      expect(result.status).toBe("skipped_neutral");
      expect(readMetadata(result).reason).toBe("liquidity-cadence-reuse");
    }
    expect(persistScores).toHaveBeenCalledOnce();
    expect(markDexLiquidityScoringStageConsumed).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("reuses accepted output when the consumed marker failed without rescoring", async () => {
    await stageHourGeneration(harness);
    vi.mocked(markDexLiquidityScoringStageConsumed).mockRejectedValueOnce(new Error("marker unavailable"));
    await consumeStage(harness);
    vi.mocked(loadCurrentDexScoringGenerationId).mockResolvedValue(`dex-liquidity-${Math.floor(scheduledAtMs / 1_000)}`);
    const result = await consumeStage(harness, undefined, halfHourSlot);
    expect(result.status).toBe("skipped_neutral");
    expect(persistScores).toHaveBeenCalledOnce();
  });

  it("leaves a source ready when a candidate is rejected by source guards", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce({ ...phaseFixtures.current.primary, dlProtocolsAvailable: false });
    await stageHourGeneration(harness);
    await consumeStage(harness);
    expect(markDexLiquidityScoringStageConsumed).not.toHaveBeenCalled();
    expect(harness.sqlite.prepare(
      `SELECT state FROM dex_liquidity_scoring_stages WHERE source_slot_started_at = ?`,
    ).get(sourceSlot)).toEqual({ state: "ready" });
  });

  it.each([
    { label: "refuses recovery after its inherited invocation deadline before claiming the source lease", ageMs: 900_000, reason: "invocation-deadline-exhausted" },
    { label: "refuses recovery with only consumer headroom before claiming the source lease", ageMs: CRON_TIMEOUT_MS["sync-dex-liquidity"]! - 120_000, reason: "consumer-headroom-exhausted" },
  ])("$label", async ({ ageMs, reason }) => {
    recordStageRunError(harness);
    await expect(consumeStage(harness, {
      deadline: createSlotDeadline(Date.now() - ageMs),
      stageRecovery: { graphApiKey: "heavy-graph-key" },
    })).rejects.toThrow(reason);
    expect(fetchDataSources).not.toHaveBeenCalled();
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM cron_leases").get()).toEqual({ count: 0 });
  });

  it.each(["publication", "reuse"] as const)("passes the %s event deadline through recovery without using the old source slot", async (mode) => {
    recordStageRunError(harness);
    if (mode === "reuse") vi.setSystemTime(halfHourSlot * 1_000);
    const deadline = createSlotDeadline(Date.now() - 120_000);
    const v2 = vi.spyOn(v2Enrichment, "enrichEvmV2ExecutionModels");
    const quoter = vi.spyOn(quoterEnrichment, "enrichQuoterV2ExecutionTargets");
    const v4 = vi.spyOn(v4Enrichment, "enrichUniswapV4ExecutionTargets");
    const options = {
      deadline,
      stageReadyDeadlineMs: Date.now() + 90_000,
      stageRecovery: { graphApiKey: "graph-key" },
    };
    if (mode === "publication") {
      await consumeStage(harness, options);
    } else {
      await consumeStage(harness, options, halfHourSlot);
    }
    for (const enrichment of [v2, quoter, v4]) {
      expect(enrichment).toHaveBeenCalledTimes(1);
      expect(enrichment.mock.calls[0]![0].deadline).toMatchObject({
        eventEntryMs: deadline.eventEntryMs, platformDeadlineMs: Math.min(deadline.latestAdmissionMs(0, 120_000), deadline.eventEntryMs + CRON_TIMEOUT_MS["sync-dex-liquidity"]! - 120_000),
      });
    }
    expect(deadline.eventEntryMs).not.toBe(sourceSlot * 1_000);
  });

  it("re-runs an errored source stage inline and publishes with recovery metadata", async () => {
    recordStageRunError(harness);

    const result = await consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs + 90_000,
      stageRecovery: { graphApiKey: "graph-key" },
    });

    expect(result.status).toBe("ok");
    expect(readMetadata(result)).toMatchObject({
      stageRecovery: {
        reason: "stage-run-errored",
        sourceSlotStartedAt: sourceSlot,
        generationId: `dex-liquidity-scoring-stage:${sourceSlot}`,
        stageResult: {
          status: "ok",
          metadata: { graphApiKeyConfigured: true, targetEnrichment: [] },
        },
      },
      measuredTargetFunnel: { stageOrigin: "recovery", graphApiKeyConfigured: true },
    });
    expect(readMetadata(result).priceRefresh).toMatchObject({ requests: 0 });
    // Exact-slot recovery must consume its generation and release the fencing lease.
    expect(
      harness.sqlite
        .prepare(`SELECT state FROM dex_liquidity_scoring_stages WHERE source_slot_started_at = ?`)
        .get(sourceSlot),
    ).toEqual({ state: "consumed" });
    expect(
      harness.sqlite
        .prepare(`SELECT lease_until FROM cron_leases WHERE job = 'sync-dex-liquidity-stage'`)
        .get(),
    ).toBeUndefined();
  });

  it("re-runs a failed stage generation inline instead of waiting out the deadline", async () => {
    await stageHourGeneration(harness);
    harness.sqlite
      .prepare(`UPDATE dex_liquidity_scoring_stages SET state = 'failed' WHERE source_slot_started_at = ?`)
      .run(sourceSlot);

    const result = await consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs + 90_000,
      stageRecovery: { graphApiKey: "graph-key" },
    });

    expect(result.status).toBe("ok");
    expect(readMetadata(result).stageRecovery).toMatchObject({
      reason: "stage-generation-failed",
      sourceSlotStartedAt: sourceSlot,
    });
  });

  it("recovers a never-started stage once the readiness deadline has passed", async () => {

    const result = await consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs - 1,
      stageRecovery: { graphApiKey: "graph-key" },
    });

    expect(result.status).toBe("ok");
    expect(readMetadata(result).stageRecovery).toMatchObject({
      reason: "stage-missing",
      sourceSlotStartedAt: sourceSlot,
    });
  });

  it.each([null, "", "   "])("refuses misconfigured caller recovery without Graph (%j), not a heavy role restriction", async (graphApiKey) => {

    await expect(consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs - 1,
      stageRecovery: { graphApiKey },
    })).rejects.toThrow("missing-graph-api-key");

    expect(fetchDataSources).not.toHaveBeenCalled();
    expect(persistScores).not.toHaveBeenCalled();
    expect(publishTargets).not.toHaveBeenCalled();
    for (const table of ["dex_liquidity_scoring_stages", "dex_liquidity_scoring_stage_chunks", "cron_leases"]) {
      expect(harness.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it.each([1, 10_000])("carries compaction quarantine across real stage serialization into consumer quality (TVL=%s)", async (tvlUsd) => {
    phaseFixtures.reset();
    const rejection = { reason: "invalid-pool-identity" as const, poolIds: ["malformed-primary"], count: 1, tvlUsd };
    vi.mocked(fetchDataSources).mockResolvedValueOnce({ ...phaseFixtures.current.primary, poolRejections: [rejection] });
    await stageHourGeneration(harness);
    const result = await consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs - 1,
      stageRecovery: { graphApiKey: null },
    });
    expect(result.status).toBe(tvlUsd >= 10_000 ? "degraded" : "ok");
    expect(readMetadata(result)).toMatchObject({
      poolRejections: [],
      poolRejectionMateriality: { rejectedPoolCount: 1, rejectedPoolTvlUsd: tvlUsd, material: tvlUsd >= 10_000 ? null : false },
    });
  });

  it("consumes a ready source stage without requiring recovery credentials", async () => {
    await stageHourGeneration(harness);
    vi.mocked(fetchDataSources).mockClear();

    const result = await consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs - 1,
      stageRecovery: { graphApiKey: null },
    });

    expect(result.status).toBe("ok");
    expect(fetchDataSources).not.toHaveBeenCalled();
    expect(publishTargets).toHaveBeenCalledOnce();
    expect(harness.sqlite.prepare(
      `SELECT state FROM dex_liquidity_scoring_stages WHERE source_slot_started_at = ?`,
    ).get(sourceSlot)).toEqual({ state: "consumed" });
  });

  it("recovers inline with heavy's configured Graph key at the half-hour tick", async () => {
    recordStageRunError(harness);
    vi.setSystemTime(halfHourSlot * 1_000);
    const result = await consumeStage(harness, { stageRecovery: { graphApiKey: "heavy-graph-key" } }, halfHourSlot);
    expect(result.status).toBe("ok");
    expect(fetchDataSources).toHaveBeenCalled();
    expect(publishTargets).toHaveBeenCalledOnce();
    expect(readMetadata(result).stageRecovery).toMatchObject({ reason: "stage-run-errored" });
    expect(harness.sqlite.prepare(
      `SELECT state FROM dex_liquidity_scoring_stages WHERE source_slot_started_at = ?`,
    ).get(sourceSlot)).toEqual({ state: "consumed" });
  });

  it("fails fast with a machine-readable reason when a terminal stage has no recovery", async () => {
    recordStageRunError(harness);

    await expect(consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs + 90_000,
    })).rejects.toThrow(`DEX liquidity scoring stage run errored for source slot ${sourceSlot}`);
    // No rewrite happened: the terminal slot was refused, not staged.
    expect(
      harness.sqlite
        .prepare(`SELECT COUNT(*) AS count FROM dex_liquidity_scoring_stages`)
        .get(),
    ).toEqual({ count: 0 });
  });

  it("returns a nonproductive producer-running neutral at the unchanged readiness deadline", async () => {
    usePollingClock();
    recordLiveStageLease(harness);
    let completed = false;
    const pending = consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs + 90_000,
      stageRecovery: { graphApiKey: null },
    }).then((result) => {
      completed = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(Date.now()).toBe(scheduledAtMs + 90_000);
    expect(result).toMatchObject({
      status: "skipped_neutral", itemCount: 0,
      productivity: { productive: false, reason: "scoring-stage-producer-running" },
    });
    expect(readMetadata(result)).toMatchObject({
      reason: "scoring-stage-producer-running", sourceSlotStartedAt: sourceSlot,
      readinessDeadlineMs: scheduledAtMs + 90_000,
      persistence: { generationId: null, skipped: true, skippedReason: "scoring-stage-producer-running" },
      d1Cost: { coverage: "partial" },
    });
    expect(readMetadata(result).d1Cost.bindingCalls).toBeGreaterThan(0);
    expect(fetchDataSources).not.toHaveBeenCalled();
    expect(persistScores).not.toHaveBeenCalled();
    expect(publishTargets).not.toHaveBeenCalled();
    expect(markDexLiquidityScoringStageConsumed).not.toHaveBeenCalled();
    for (const table of ["dex_liquidity_scoring_stages", "dex_liquidity_scoring_stage_chunks", "dex_liquidity"]) {
      expect(harness.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(harness.sqlite.prepare(
      `SELECT lease_owner FROM cron_leases WHERE job = 'sync-dex-liquidity-stage'`,
    ).get()).toEqual({ lease_owner: "stage-owner" });
  });

  it.each(["absent", "expired"] as const)("does not classify an %s producer lease as a live wait", async (lease) => {
    usePollingClock();
    if (lease === "expired") recordLiveStageLease(harness, Math.floor(scheduledAtMs / 1000) + 60);
    const rejected = expect(consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs + 90_000,
    })).rejects.toBeInstanceOf(MissingDexLiquidityScoringStageError);
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    expect(Date.now()).toBe(scheduledAtMs + 90_000);
    expect(fetchDataSources).not.toHaveBeenCalled();
    expect(persistScores).not.toHaveBeenCalled();
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM dex_liquidity_scoring_stages").get()).toEqual({ count: 0 });
  });

  it("keeps producer probe failures as errors instead of neutral waits", async () => {
    harness.sqlite.exec("DROP TABLE cron_leases");
    await expect(consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs - 1,
    })).rejects.toThrow("no such table: cron_leases");
    expect(fetchDataSources).not.toHaveBeenCalled();
    expect(persistScores).not.toHaveBeenCalled();
  });

  it("propagates cancellation during a live producer wait without publishing", async () => {
    usePollingClock();
    recordLiveStageLease(harness);
    const controller = new AbortController();
    const failure = new Error("slot budget exhausted");
    const rejected = expect(consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs + 90_000,
      stageRecovery: { graphApiKey: "graph-key" },
    }, consumerSlot, controller.signal)).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort(failure);
    await rejected;
    expect(Date.now()).toBe(scheduledAtMs + 10_000);
    expect(fetchDataSources).not.toHaveBeenCalled();
    expect(persistScores).not.toHaveBeenCalled();
    expect(markDexLiquidityScoringStageConsumed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes the same late exact stage at :46 after a producer-running :16 wait", async () => {
    recordLiveStageLease(harness);
    const waiting = await consumeStage(harness, {
      stageReadyDeadlineMs: scheduledAtMs - 1,
      stageRecovery: { graphApiKey: null },
    });
    expect(waiting.status).toBe("skipped_neutral");
    expect(readMetadata(waiting).reason).toBe("scoring-stage-producer-running");
    expect(persistScores).not.toHaveBeenCalled();
    expect(markDexLiquidityScoringStageConsumed).not.toHaveBeenCalled();
    vi.setSystemTime(scheduledAtMs + 120_000);
    await stageHourGeneration(harness);
    vi.mocked(fetchDataSources).mockClear();
    vi.setSystemTime(Date.parse("2026-09-23T15:46:00Z"));

    const result = await consumeStage(harness, { stageRecovery: { graphApiKey: null } }, halfHourSlot);

    expect(result.status).toBe("ok");
    expect(fetchDataSources).not.toHaveBeenCalled();
    expect(persistScores).toHaveBeenCalledOnce();
    expect(readMetadata(result)).toMatchObject({
      stageRecovery: {
        reason: "stage-unconsumed",
        sourceSlotStartedAt: sourceSlot,
        generationId: `dex-liquidity-scoring-stage:${sourceSlot}`,
      },
    });
    expect(
      harness.sqlite
        .prepare(`SELECT state FROM dex_liquidity_scoring_stages WHERE source_slot_started_at = ?`)
        .get(sourceSlot),
    ).toEqual({ state: "consumed" });
  });

  it("re-runs a terminally failed source stage from the half-hour tick", async () => {
    recordStageRunError(harness);
    vi.setSystemTime(Date.parse("2026-09-23T15:46:00Z"));

    const result = await consumeStage(harness, { stageRecovery: { graphApiKey: "graph-key" } }, halfHourSlot);

    expect(result.status).toBe("ok");
    expect(readMetadata(result).stageRecovery).toMatchObject({
      reason: "stage-run-errored",
      sourceSlotStartedAt: sourceSlot,
    });
    expect(
      harness.sqlite
        .prepare(`SELECT state FROM dex_liquidity_scoring_stages WHERE source_slot_started_at = ?`)
        .get(sourceSlot),
    ).toEqual({ state: "consumed" });
  });

  it("still skips neutral at the half-hour tick when the hour's stage was consumed", async () => {
    await stageHourGeneration(harness);
    harness.sqlite
      .prepare(`UPDATE dex_liquidity_scoring_stages SET state = 'consumed' WHERE source_slot_started_at = ?`)
      .run(sourceSlot);
    vi.mocked(loadCurrentDexScoringGenerationId).mockResolvedValue("dex-liquidity-current");
    vi.setSystemTime(Date.parse("2026-09-23T15:46:00Z"));

    const result = await consumeStage(harness, { stageRecovery: { graphApiKey: "graph-key" } }, halfHourSlot);

    expect(result.status).toBe("skipped_neutral");
    expect(readMetadata(result)).toMatchObject({
      cadenceReuse: true,
      persistence: { generationId: "dex-liquidity-current" },
    });
  });
});

function makeOrcaPair() {
  const sol = "So11111111111111111111111111111111111111112";
  const usdc = "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1";
  const primary: LlamaPool = llamaPool({
    pool: "4f44c5d5-b1c2-4b1c-a111-123456789abc",
    chain: "Solana",
    project: "orca-dex",
    symbol: "SOL-USDC",
    tvlUsd: 29_000_000,
    volumeUsd1d: 2_500_000,
    volumeUsd7d: 17_000_000,
    underlyingTokens: [sol, usdc],
  });
  const direct: DexApiPool = apiPool({ source: "orca", chain: "solana", poolAddress: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc", poolType: "orca-whirlpool", tokens: [
      { address: usdc, symbol: "USDC", decimals: 6 },
      { address: sol, symbol: "SOL", decimals: 9 },
    ], price: 150, tvlUsd: 29_000_000, volume24hUsd: 2_500_000, balances: [100_000, 200_000] });
  return { primary, direct };
}

describe("filterPrimaryPoolsPreferDirectApi", () => {
  it("does not let an absurd direct-API pool suppress a healthy primary pool", () => {
    const pools: LlamaPool[] = [
      llamaPool({
        pool: "0xpool",
        chain: "Fantom",
        project: "balancer-stable",
        symbol: "USDC-USDT",
        tvlUsd: 2_500_000,
        volumeUsd1d: 250_000,
        volumeUsd7d: 1_500_000,
        stablecoin: true,
        underlyingTokens: ["0xusdc", "0xusdt"],
        count: 2,
      }),
    ];
    const directApiPools: DexApiPool[] = [
      apiPool({ source: "balancer", chain: "Fantom", poolAddress: "0xpool", poolType: "balancer-stable", tokens: [
          { address: "0xusdc", symbol: "USDC", decimals: 6 },
          { address: "0xusdt", symbol: "USDT", decimals: 6 },
        ], tvlUsd: 337_000_000_000, volume24hUsd: 100_000, balances: [1_000_000, 1_000_000] }),
    ];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(1);
    expect(result.skippedByExactIdentity).toBe(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(0);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("deduplicates an Orca DL pool via unique derived identity when fee metadata is missing", () => {
    const { primary, direct } = makeOrcaPair();
    const pools = [primary];
    const directApiPools = [direct];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(0);
    expect(result.skippedByExactIdentity).toBe(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(1);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("deduplicates a Balancer V3 DL stable pool via na-variant derived identity when DL omits the stable subtype", () => {
    const pools: LlamaPool[] = [
      llamaPool({
        pool: "0511276f-4d37-4919-95ab-6cdf418ddd08",
        chain: "Plasma",
        project: "balancer-v3",
        symbol: "USDAI-WAPLAUSDT0",
        tvlUsd: 547_701,
        stablecoin: true,
        underlyingTokens: ["0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", "0xe0126f0c4451b2b917064a93040fd4770d6774b5"],
        apy: 1.39196,
        count: 180,
      }),
    ];
    const directApiPools: DexApiPool[] = [
      apiPool({ source: "balancer", chain: "Plasma", poolAddress: "0x01e2c7fcde2b8d5d1413732c4e274ba5b06b1e54", poolType: "balancer-stable", tokens: [
          { address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", symbol: "USDai", decimals: 18 },
          { address: "0xe0126f0c4451b2b917064a93040fd4770d6774b5", symbol: "waPlaUSDT0", decimals: 18 },
        ], price: 0.999939, tvlUsd: 547_664.8, volume24hUsd: 5_900.52, balances: [240_716.79906230856, 301_609.539917] }),
    ];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(0);
    expect(result.skippedByExactIdentity).toBe(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(1);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("deduplicates a DL raydium-amm stable pair against the direct Raydium pool via the tracked-pair stability hint", () => {
    // DL calls USDS-USDC stable; the untyped native pair needs the tracked hint to avoid doubling ~$9.1M TVL.
    const USDS_MINT = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA";
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const pools: LlamaPool[] = [
      llamaPool({
        pool: "5b6c56a9-3b81-48ee-bee7-3f0dcd862e4d",
        chain: "Solana",
        project: "raydium-amm",
        symbol: "USDS-USDC",
        tvlUsd: 9_101_152,
        volumeUsd1d: 1_034_471,
        stablecoin: true,
        underlyingTokens: [USDS_MINT, USDC_MINT],
      }),
    ];
    const directPool = (poolAddress: string, tvlUsd: number): DexApiPool => ({
      source: "raydium",
      chain: "solana",
      poolAddress,
      poolType: "raydium-amm",
      tokens: [
        { address: USDS_MINT, symbol: "USDS", decimals: 6 },
        { address: USDC_MINT, symbol: "USDC", decimals: 6 },
      ],
      price: 1,
      tvlUsd,
      volume24hUsd: tvlUsd / 9,
      feeRate: 0.0025,
      balances: [tvlUsd / 2, tvlUsd / 2],
    });
    const chainAddressToId = new Map([
      [`solana:${USDS_MINT}`, "usds-sky"],
      [`solana:${USDC_MINT}`, "usdc-circle"],
    ]);
    const singleTwin = [directPool("AS5MV3ib4bfudpsb65yfmyQwrB9nRbY4rEqMSpjwbAcT", 9_101_153)];

    const withHint = filterPrimaryPoolsPreferDirectApi(pools, singleTwin, chainAddressToId);
    expect(withHint.filteredPools).toHaveLength(0);
    expect(withHint.skippedByUniqueDerivedIdentity).toBe(1);

    // Ambiguous native twins cannot suppress a possible third DL pool, including via wildcard fallback.
    const ambiguousTwins = [...singleTwin, directPool("7kJb5ZQF2jWc5m9R8t2xVb4nD6yPeHhTQ3sLuNvAaBbC", 56_127)];
    const ambiguous = filterPrimaryPoolsPreferDirectApi(pools, ambiguousTwins, chainAddressToId);
    expect(ambiguous.filteredPools).toHaveLength(1);
  });

  it("deduplicates a DL Concentrated raydium-amm pool against the identical direct Raydium CLMM pool", () => {
    // 2026-08-19: DL Raydium needs the poolMeta CLMM hint to match native concentrated identity and avoid doubled TVL.
    const USDS_MINT = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA";
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const pools: LlamaPool[] = [
      llamaPool({
        pool: "5b6c56a9-3b81-48ee-bee7-3f0dcd862e4d",
        chain: "Solana",
        project: "raydium-amm",
        symbol: "USDS-USDC",
        poolMeta: "Concentrated - 0.01%",
        tvlUsd: 3_234_788,
        volumeUsd1d: 1_034_471,
        stablecoin: true,
        underlyingTokens: [USDS_MINT, USDC_MINT],
      }),
    ];
    const directApiPools: DexApiPool[] = [
      apiPool({ source: "raydium", chain: "solana", poolAddress: "AS5MV3ib4bfudpsb65yfmyQwrB9nRbY4rEqMSpjwbAcT", poolType: "raydium-clmm", tokens: [
          { address: USDS_MINT, symbol: "USDS", decimals: 6 },
          { address: USDC_MINT, symbol: "USDC", decimals: 6 },
        ], tvlUsd: 3_234_790, volume24hUsd: 1_034_500, balances: [1_617_000, 1_617_500] }),
    ];
    const chainAddressToId = new Map([
      [`solana:${USDS_MINT}`, "usds-sky"],
      [`solana:${USDC_MINT}`, "usdc-circle"],
    ]);

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools, chainAddressToId);

    expect(result.filteredPools).toHaveLength(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(1);
  });

  it("does not use optional wildcard dedup when multiple direct API Orca pools share the same pair", () => {
    const { primary, direct } = makeOrcaPair();
    const pools = [primary];
    const directApiPools = [direct, {
      ...direct,
      poolAddress: "8k6N7m5b4V3c2X1z9Y8w7u6T5r4e3W2q1P9o8i7u6Y5",
      tvlUsd: 500_000, volume24hUsd: 50_000, feeRate: 0.0005, balances: [10_000, 20_000],
    }];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(1);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("uses optional wildcard matching for a stable pair without a direct stability hint", () => {
    const { primary, direct } = makeOrcaPair();
    const usds = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA";
    primary.underlyingTokens = [usds, direct.tokens[0].address];
    primary.symbol = "USDS-USDC";
    primary.stablecoin = true;
    direct.tokens[1] = { address: usds, symbol: "USDS", decimals: 6 };
    direct.price = 1;
    const unrelated = { ...primary, pool: "unrelated", underlyingTokens: ["another-token", "different-token"] };
    const result = filterPrimaryPoolsPreferDirectApi([primary, unrelated], [direct]);
    expect(result.filteredPools.map((pool) => pool.pool)).toEqual(["unrelated"]);
    expect(result.skippedByOptionalWildcardIdentity).toBe(1);
    expect(result.skippedByUniqueDerivedIdentity).toBe(0);
    expect(result.skippedByExactIdentity).toBe(0);
  });

  it("prefers a healthy exact-address direct pool", () => {
    const { primary, direct } = makeOrcaPair();
    const result = filterPrimaryPoolsPreferDirectApi([{ ...primary, pool: direct.poolAddress }], [direct]);
    expect(result.filteredPools).toEqual([]);
    expect(result.skippedByExactIdentity).toBe(1);
    expect(result.skippedByUniqueDerivedIdentity).toBe(0);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("retains both primary pools when their derived identity is ambiguous", () => {
    const { primary, direct } = makeOrcaPair();
    const result = filterPrimaryPoolsPreferDirectApi([primary, { ...primary, pool: "second-primary" }], [direct]);
    expect(result.filteredPools.map((pool) => pool.pool)).toEqual([primary.pool, "second-primary"]);
    expect(result.skippedByUniqueDerivedIdentity).toBe(0);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });
});
