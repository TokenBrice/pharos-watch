import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinData } from "@shared/types/market";
import type { DexApiPool } from "../../lib/dex-api-common";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { CronProgressReporter, CronProgressUpdate, CronResult } from "../../lib/cron-logger";
import type { LlamaPool } from "../dex-liquidity/types";

function makeDirectApiResult() {
  return { pools: [], ok: true, degraded: false, errors: [] as string[] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("../dex-liquidity/subgraph-source-families", () => ({
  fetchUniV3Data: vi.fn(async () => ({
    uniV3PoolFees: new Map(),
    uniV3SymbolFees: new Map(),
    uniV3PriceObs: new Map(),
    uniV3ExecutionCandidates: new Map(),
  })),
  fetchAerodromeData: vi.fn(async () => ({
    aerodromePriceObs: new Map(),
    aerodromeIsStable: new Map(),
    aerodromeV2ExecutionCandidates: new Map(),
  })),
  fetchUniswapV4Data: vi.fn(async () => ({
    uniswapV4ExecutionCandidates: new Map(),
  })),
}));

vi.mock("../dex-liquidity/fetch-primary", () => ({
  fetchDataSources: vi.fn(async () => null),
  buildCurveLookups: vi.fn(async () => ({ curvePoolMap: new Map(), priceObservations: new Map() })),
  buildKnownPoolAddresses: vi.fn(() => ({
    exactKeys: new Set<string>(),
    exactStablecoinIdsByKey: new Map<string, Set<string>>(),
    derivedKeyCounts: new Map<string, number>(),
    derivedToExactKeys: new Map<string, Set<string>>(),
    wildcardKeyCounts: new Map<string, number>(),
    wildcardToExactKeys: new Map<string, Set<string>>(),
    concreteFeeVariantKeys: new Map<string, Set<string>>(),
  })),
}));

vi.mock("../dex-liquidity/process-pools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dex-liquidity/process-pools")>()),
  processPoolMetrics: vi.fn(() => ({ metrics: new Map(), rejections: [] })),
}));

vi.mock("../dex-liquidity/staging-merge", () => ({
  mergeStagedPools: vi.fn(async () => ({
    mergedCount: 0,
    skippedCount: 0,
    skippedByExactIdentityCount: 0,
    skippedByUniqueDerivedIdentityCount: 0,
    skippedByOptionalWildcardIdentityCount: 0,
    skippedByAuthoritativeProtocolCount: 0,
    skipDimensions: [],
    priceObservations: new Map(),
  })),
}));

vi.mock("../dex-liquidity/scoring", () => ({
  loadCurrentDexScoringGenerationId: vi.fn(async () => null),
  computeStablecoinScores: vi.fn(async () => ({
    scores: new Map([["usdt-tether", { coverageClass: "primary", tvl: 0 }]]),
    globalAgg: { totalTvl: 0 },
    retainedPoolsByStablecoin: new Map(),
    tvlStabilityMap: new Map(),
    diagnostics: {
      protocolCapReductions: { cappedPoolCount: 0, cappedProtocols: 0, reducedTvlUsd: 0 },
    },
  })),
  computeDepthStability: vi.fn(async () => {}),
  computeDexPrices: vi.fn(async () => {}),
}));

vi.mock("../dex-liquidity/persistence", () => ({
  persistScores: vi.fn(async (_db, _metrics, _scores, _globalAgg, nowSec: number) => ({
    generationId: `dex-liquidity-${nowSec}`,
  })),
  writeHistoricalSnapshots: vi.fn(async () => {}),
}));

// The stage tables round-trip is covered by dex-liquidity/__tests__/scoring-stage.test.ts
// against real SQLite; here the D1 layer is replaced by an in-memory chunk buffer so the
// two production entrypoints still exchange the exact encoded scoring input.
const scoringStage = vi.hoisted(() => ({
  chunks: [] as Array<{ payload: string; payloadBytes: number; recordCount: number }>,
  sourceSlotStartedAt: 0,
  syncStartSec: 0,
}));

vi.mock("../dex-liquidity/scoring-stage", async () => {
  const actual = await vi.importActual<typeof import("../dex-liquidity/scoring-stage")>(
    "../dex-liquidity/scoring-stage",
  );
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
    loadDexLiquidityScoringStage: vi.fn(async () => {
      const decoded = actual.decodeDexLiquidityScoringStageChunks(scoringStage.chunks);
      return {
        generationId: `dex-liquidity-scoring-stage:${scoringStage.sourceSlotStartedAt}`,
        sourceSlotStartedAt: scoringStage.sourceSlotStartedAt,
        syncStartSec: scoringStage.syncStartSec,
        sourceState: decoded.sourceState,
        poolState: decoded.poolState,
      };
    }),
    markDexLiquidityScoringStageConsumed: vi.fn(async () => {}),
  };
});

vi.mock("../dex-liquidity/challenger-persistence", async () => {
  const actual = await vi.importActual<typeof import("../dex-liquidity/challenger-persistence")>(
    "../dex-liquidity/challenger-persistence",
  );
  return {
    ...actual,
    publishDexPriceChallengerSnapshots: vi.fn(async () => ({
      publishedStablecoins: 0,
      skippedStablecoins: 0,
      missingTables: false,
    })),
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
vi.mock("../dex-liquidity/fetch-sunswap", () => ({
  fetchSunSwapPools: vi.fn(async () => makeDirectApiResult()),
}));
vi.mock("../dex-liquidity/fetch-slipstream", () => ({
  fetchSlipstreamPools: vi.fn(async () => makeDirectApiResult()),
}));
vi.mock("../dex-liquidity/fetch-uniswap-v3-bsc", () => ({
  fetchUniswapV3BscShadowPools: vi.fn(async () => makeDirectApiResult()),
}));
vi.mock("../../lib/stablecoins-cache", async () => {
  const actual = await vi.importActual<typeof import("../../lib/stablecoins-cache")>("../../lib/stablecoins-cache");
  return {
    ...actual,
    loadStablecoinsCache: vi.fn(async () => ({
      kind: "error" as const,
      reason: "missing-cache" as const,
      updatedAt: null,
    })),
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
vi.mock("../../lib/cex-orderbooks", () => ({
  fetchMajorStablecoinOrderbookDepthSummary: vi.fn(async () => ({
    checkedSymbols: 2,
    venueCount: 2,
    observations: 3,
    maxDepthDown2PctUsdBySymbol: { USDT: 1_000_000, USDC: 500_000 },
    maxDepthUp2PctUsdBySymbol: { USDT: 900_000, USDC: 450_000 },
  })),
}));

import {
  consumeDexLiquidityScoringStage,
  reuseCurrentDexLiquidityScoringGeneration,
  stageDexLiquidityScoring,
} from "../dex-liquidity/orchestrator";
import { UNIV3_SUBGRAPHS } from "../dex-liquidity/constants";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { convertToGtNewPools, extractPriceObservations } from "../../lib/dex-api-common";
import { buildCurveLookups, fetchDataSources, buildKnownPoolAddresses } from "../dex-liquidity/fetch-primary";
import { fetchAerodromeData, fetchUniV3Data } from "../dex-liquidity/subgraph-source-families";
import { fetchFluidPools } from "../dex-liquidity/fetch-fluid";
import { fetchBalancerPools } from "../dex-liquidity/fetch-balancer";
import { fetchRaydiumPools } from "../dex-liquidity/fetch-raydium";
import { fetchOrcaPools } from "../dex-liquidity/fetch-orca";
import { fetchMeteoraPools } from "../dex-liquidity/fetch-meteora";
import { fetchPancakeSwapPools } from "../dex-liquidity/fetch-pancakeswap";
import { fetchSlipstreamPools } from "../dex-liquidity/fetch-slipstream";
import { fetchUniswapV3BscShadowPools } from "../dex-liquidity/fetch-uniswap-v3-bsc";
import {
  computeDepthStability,
  computeDexPrices,
  computeStablecoinScores,
  loadCurrentDexScoringGenerationId,
} from "../dex-liquidity/scoring";
import { persistScores, writeHistoricalSnapshots } from "../dex-liquidity/persistence";
import { buildSymbolLookups } from "../dex-liquidity/pool-helpers";
import { processPoolMetrics } from "../dex-liquidity/process-pools";
import { mergeStagedPools } from "../dex-liquidity/staging-merge";
import { fetchMajorStablecoinOrderbookDepthSummary } from "../../lib/cex-orderbooks";

const db = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: [] }),
      first: async () => ({ cnt: 0 }),
      run: async () => ({ success: true, meta: {} }),
    }),
    all: async () => ({ results: [] }),
    first: async () => ({ cnt: 0 }),
    run: async () => ({ success: true, meta: {} }),
  }),
  batch: async () => [],
  exec: async () => ({ count: 0, duration: 0 }),
  dump: async () => new ArrayBuffer(0),
} as unknown as D1Database;

/** Drive the scheduled composition: the stage producer followed by its consumer. */
async function runDexLiquidityScoringCycle(
  database: D1Database,
  graphApiKey: string | null,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  reportProgress?: CronProgressReporter,
  options?: { publishLiquidity?: boolean; publishShadowTargets?: boolean },
): Promise<CronResult> {
  await stageDexLiquidityScoring(database, graphApiKey, signal, coingeckoApiKey, chainRpcs, reportProgress);
  return await consumeDexLiquidityScoringStage(database, signal, reportProgress, undefined, options);
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
    vi.mocked(fetchDataSources).mockResolvedValue({
      pools: [],
      rawPoolCount: 0,
      dexProjects: new Set<string>(),
      protocolTvlCaps: new Map<string, number>(),
      curvePayloads: [],
      graphApiKey: "graph-key",
      dlYieldsAvailable: true,
      dlProtocolsAvailable: true,
    });
    vi.mocked(loadStablecoinsCache).mockResolvedValue({
      kind: "error",
      reason: "missing-cache",
      updatedAt: null,
    });
    vi.mocked(convertToGtNewPools).mockReturnValue(new Map());
    vi.mocked(extractPriceObservations).mockReturnValue(new Map());
    vi.mocked(loadCurrentDexScoringGenerationId).mockResolvedValue(null);
  });

  it("throws on catastrophic source failure instead of silently returning", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce(null);
    await expect(runDexLiquidityScoringCycle(db, "graph-key")).rejects.toThrow("catastrophic source failure");
  });

  it("returns degraded when non-catastrophic critical source family fails", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce({
      pools: [],
      rawPoolCount: 0,
      dexProjects: new Set<string>(),
      protocolTvlCaps: new Map<string, number>(),
      curvePayloads: [],
      graphApiKey: "graph-key",
      dlYieldsAvailable: true,
      dlProtocolsAvailable: false,
    });

    const result = await runDexLiquidityScoringCycle(db, "graph-key");

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
      fallbackMode?: string[];
      rowsWritten?: number;
      persistence?: {
        skipped?: boolean;
        skippedReason?: string | null;
      };
    };
    expect(metadata.failedSources).toContain("defillama-protocols");
    expect(metadata.fallbackMode).toContain("dl-protocols-unavailable");
    expect(metadata.rowsWritten).toBe(0);
    expect(metadata.persistence?.skipped).toBe(true);
    expect(metadata.persistence?.skippedReason).toBe("defillama-protocols-unavailable");
    expect(persistScores).not.toHaveBeenCalled();
    expect(computeDexPrices).not.toHaveBeenCalled();
    expect(writeHistoricalSnapshots).not.toHaveBeenCalled();
    expect(computeDepthStability).not.toHaveBeenCalled();
  });

  it("returns degraded when DL fails but Curve succeeds", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce({
      pools: [],
      rawPoolCount: 0,
      dexProjects: new Set<string>(),
      protocolTvlCaps: new Map<string, number>(),
      curvePayloads: [{ data: { poolData: [] } }],
      graphApiKey: "graph-key",
      dlYieldsAvailable: false,
      dlProtocolsAvailable: false,
    });

    const result = await runDexLiquidityScoringCycle(db, "graph-key");

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
    };
    expect(metadata.failedSources).toContain("defillama-yields");
    expect(persistScores).not.toHaveBeenCalled();
  });

  it("degrades and skips persistence instead of tripping hard value guard when DL yields is unavailable", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce({
      pools: [],
      rawPoolCount: 0,
      dexProjects: new Set<string>(["curve"]),
      protocolTvlCaps: new Map<string, number>(),
      curvePayloads: [{ data: { poolData: [] } }],
      graphApiKey: "graph-key",
      dlYieldsAvailable: false,
      dlProtocolsAvailable: true,
    });
    vi.mocked(computeStablecoinScores).mockResolvedValueOnce({
      scores: new Map([["usdt-tether", { coverageClass: "primary", tvl: 2_000_000_000 }]]),
      globalAgg: { totalTvl: 2_000_000_000 },
      retainedPoolsByStablecoin: new Map(),
      tvlStabilityMap: new Map(),
      diagnostics: {
        protocolCapReductions: { cappedPoolCount: 0, cappedProtocols: 0, reducedTvlUsd: 0 },
      },
    } as Awaited<ReturnType<typeof computeStablecoinScores>>);
    const guardDb = {
      prepare(sql: string) {
        if (sql.includes("COUNT(*) as cnt FROM dex_liquidity")) {
          return { first: async () => ({ cnt: 165 }) };
        }
        if (sql.includes("SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'")) {
          return { first: async () => ({ total_tvl_usd: 6_000_000_000, updated_at: 1_777_556_412 }) };
        }
        if (sql.includes("GROUP BY coverage_class")) {
          return { all: async () => ({ results: [] }) };
        }
        if (sql.includes("ORDER BY total_tvl_usd DESC")) {
          return { all: async () => ({ results: [{ stablecoin_id: "usdt-tether", total_tvl_usd: 4_000_000_000 }] }) };
        }
        if (sql.includes("FROM cron_runs")) {
          return { all: async () => ({ results: [] }) };
        }
        if (sql.includes("WHERE stablecoin_id IN")) {
          return { bind: () => ({ all: async () => ({ results: [] }) }) };
        }
        return {
          bind: () => ({
            all: async () => ({ results: [] }),
            first: async () => ({ cnt: 0 }),
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async () => ({ results: [] }),
          first: async () => ({ cnt: 0 }),
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const result = await runDexLiquidityScoringCycle(guardDb, "graph-key");

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
      rowsWritten?: number;
      persistence?: { skipped?: boolean; skippedReason?: string | null };
      sourceCoverage?: { currentGlobalTvl?: number; nearValueGuard?: boolean };
    };
    expect(metadata.failedSources).toContain("defillama-yields");
    expect(metadata.rowsWritten).toBe(0);
    expect(metadata.persistence?.skipped).toBe(true);
    expect(metadata.persistence?.skippedReason).toBe("defillama-yields-unavailable");
    expect(metadata.sourceCoverage?.currentGlobalTvl).toBe(2_000_000_000);
    expect(metadata.sourceCoverage?.nearValueGuard).toBe(true);
    expect(persistScores).not.toHaveBeenCalled();
    expect(computeDexPrices).not.toHaveBeenCalled();
  });

  it("returns ok when required source families succeed", async () => {
    const result = await runDexLiquidityScoringCycle(db, "graph-key");

    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
      stagedPoolsSkippedByExactIdentity?: number;
      stagedPoolsSkippedByUniqueDerivedIdentity?: number;
      sourceCoverage?: {
        nearCoverageGuard?: boolean;
        weakCoverageCoins?: number;
        directCexOrderbookDepth?: {
          observations: number;
          maxDepthDown2PctUsdBySymbol: Record<string, number>;
        } | null;
        qualityDriftSeverity?: string;
        qualityDriftFlags?: string[];
        coinsWithoutMeasuredBalances?: number;
        protocolCapReductions?: { reducedTvlUsd?: number };
      };
    };
    expect(metadata.failedSources).toEqual([]);
    expect(metadata.stagedPoolsSkippedByExactIdentity).toBe(0);
    expect(metadata.stagedPoolsSkippedByUniqueDerivedIdentity).toBe(0);
    expect(metadata.sourceCoverage?.nearCoverageGuard).toBe(false);
    expect(metadata.sourceCoverage?.weakCoverageCoins).toBe(0);
    expect(metadata.sourceCoverage?.directCexOrderbookDepth).toMatchObject({
      observations: 3,
      maxDepthDown2PctUsdBySymbol: { USDT: 1_000_000, USDC: 500_000 },
    });
    expect(metadata.sourceCoverage?.qualityDriftSeverity).toBe("none");
    expect(metadata.sourceCoverage?.qualityDriftFlags).toEqual([]);
    expect(metadata.sourceCoverage?.coinsWithoutMeasuredBalances).toBe(0);
    expect(metadata.sourceCoverage?.protocolCapReductions?.reducedTvlUsd).toBe(0);
  });

  it("reuses the current generation for hourly prices without liquidity writes", async () => {
    vi.mocked(loadCurrentDexScoringGenerationId).mockResolvedValueOnce("dex-liquidity-current");

    const result = await runDexLiquidityScoringCycle(
      db,
      "graph-key",
      undefined,
      undefined,
      undefined,
      undefined,
      { publishLiquidity: false, publishShadowTargets: false },
    );

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      rowsWritten?: number;
      persistence?: { generationId?: string; skippedReason?: string | null };
    };
    expect(result.status).toBe("ok");
    expect(metadata.rowsWritten).toBe(0);
    expect(metadata.persistence).toMatchObject({
      generationId: "dex-liquidity-current",
      skippedReason: "liquidity-cadence-reuse",
    });
    const scoreCalls = vi.mocked(computeStablecoinScores).mock.calls;
    expect(scoreCalls[scoreCalls.length - 1]?.[11]).toBe("none");
    expect(persistScores).not.toHaveBeenCalled();
    expect(writeHistoricalSnapshots).not.toHaveBeenCalled();
    expect(computeDepthStability).not.toHaveBeenCalled();
    expect(computeDexPrices).toHaveBeenCalledOnce();
  });

  it("bootstraps full liquidity publication when the current generation is missing", async () => {
    const result = await runDexLiquidityScoringCycle(
      db,
      "graph-key",
      undefined,
      undefined,
      undefined,
      undefined,
      { publishLiquidity: false, publishShadowTargets: false },
    );

    expect(result.status).toBe("ok");
    const scoreCalls = vi.mocked(computeStablecoinScores).mock.calls;
    expect(scoreCalls[scoreCalls.length - 1]?.[11]).toBe("active");
    expect(persistScores).toHaveBeenCalledOnce();
    expect(writeHistoricalSnapshots).toHaveBeenCalledOnce();
    expect(computeDepthStability).toHaveBeenCalledOnce();
  });

  it("publishes active and shadow measured targets during the daily inventory cycle", async () => {
    await runDexLiquidityScoringCycle(
      db,
      "graph-key",
      undefined,
      undefined,
      undefined,
      undefined,
      { publishLiquidity: true, publishShadowTargets: true },
    );

    const scoreCalls = vi.mocked(computeStablecoinScores).mock.calls;
    expect(scoreCalls[scoreCalls.length - 1]?.[11]).toBe("active-and-shadow");
  });

  it("returns explicit neutral and degraded results when reusing a scoring generation", async () => {
    vi.mocked(loadCurrentDexScoringGenerationId)
      .mockResolvedValueOnce("dex-liquidity-current")
      .mockResolvedValueOnce(null);

    const reused = await reuseCurrentDexLiquidityScoringGeneration(db);
    const missing = await reuseCurrentDexLiquidityScoringGeneration(db);

    expect(reused).toMatchObject({
      status: "skipped_neutral",
      productivity: { productive: false, reason: "liquidity-cadence-reuse" },
    });
    expect(JSON.parse(reused.metadata ?? "{}")).toMatchObject({
      cadenceReuse: true,
      persistence: { generationId: "dex-liquidity-current", skipped: false },
    });
    expect(missing).toMatchObject({
      status: "degraded",
      productivity: { productive: false, reason: "current-dex-liquidity-generation-missing" },
    });
    expect(JSON.parse(missing.metadata ?? "{}")).toMatchObject({
      reason: "current-dex-liquidity-generation-missing",
      persistence: { generationId: null, skipped: true, skippedReason: "hourly-price-not-due" },
    });
  });

  it("fetches bounded market telemetry before pool graphs accumulate", async () => {
    const knownPoolIndex = {
      exactKeys: new Set(["ethereum:0xpool"]),
      exactStablecoinIdsByKey: new Map([["ethereum:0xpool", new Set(["usdt-tether"])]]),
      derivedKeyCounts: new Map([["derived", 1]]),
      derivedToExactKeys: new Map([["derived", new Set(["ethereum:0xpool"])]]),
      wildcardKeyCounts: new Map([["wildcard", 1]]),
      wildcardToExactKeys: new Map([["wildcard", new Set(["ethereum:0xpool"])]]),
      concreteFeeVariantKeys: new Map([["variant", new Set(["derived"])]]),
    };
    const stagedPriceObservations = new Map([
      ["usdt-tether", [{ price: 1, tvl: 1_000_000, chain: "Ethereum", protocol: "curve", sourceFamily: "cg_onchain" }]],
    ]);
    vi.mocked(buildKnownPoolAddresses).mockReturnValueOnce(knownPoolIndex);
    vi.mocked(mergeStagedPools).mockResolvedValueOnce({
      mergedCount: 0,
      skippedCount: 0,
      skippedByExactIdentityCount: 0,
      skippedByUniqueDerivedIdentityCount: 0,
      skippedByOptionalWildcardIdentityCount: 0,
      skippedByAuthoritativeProtocolCount: 0,
      skipDimensions: [],
      priceObservations: stagedPriceObservations,
    });
    vi.mocked(fetchMajorStablecoinOrderbookDepthSummary).mockImplementationOnce(async () => {
      expect(fetchDataSources).not.toHaveBeenCalled();
      expect(buildKnownPoolAddresses).not.toHaveBeenCalled();
      expect(processPoolMetrics).not.toHaveBeenCalled();
      expect(mergeStagedPools).not.toHaveBeenCalled();
      return {
        checkedSymbols: 0,
        venueCount: 0,
        observations: 0,
        maxDepthDown2PctUsdBySymbol: {},
        maxDepthUp2PctUsdBySymbol: {},
      };
    });

    await runDexLiquidityScoringCycle(db, "graph-key");
  });

  it("finishes direct providers before loading primary sources", async () => {
    vi.mocked(fetchDataSources).mockImplementationOnce(async () => {
      expect(fetchFluidPools).toHaveBeenCalledOnce();
      expect(fetchBalancerPools).toHaveBeenCalledOnce();
      expect(fetchPancakeSwapPools).toHaveBeenCalledOnce();
      expect(fetchMeteoraPools).toHaveBeenCalledOnce();
      expect(fetchRaydiumPools).toHaveBeenCalledOnce();
      expect(fetchOrcaPools).toHaveBeenCalledOnce();
      expect(fetchSlipstreamPools).toHaveBeenCalledTimes(2);
      return {
        pools: [],
        rawPoolCount: 0,
        dexProjects: new Set<string>(),
        protocolTvlCaps: new Map<string, number>(),
        curvePayloads: [],
        graphApiKey: "graph-key",
        dlYieldsAvailable: true,
        dlProtocolsAvailable: true,
      };
    });

    await runDexLiquidityScoringCycle(db, "graph-key");

    expect(fetchDataSources).toHaveBeenCalledOnce();
  });

  it("reports high-SLO stage metadata during source and scoring phases", async () => {
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });

    await runDexLiquidityScoringCycle(db, "graph-key", undefined, undefined, undefined, reportProgress);

    const directApiFetch = progressUpdates.find((update) => update.stage === "direct-api-fetch");
    const scoringComplete = progressUpdates.find((update) => update.stage === "scoring-complete");
    const priceCompleteIndex = progressUpdates.findIndex(
      (update) => update.stage === "persistence-prices-complete",
    );
    const challengerCompleteIndex = progressUpdates.findIndex(
      (update) => update.stage === "persistence-challengers-complete",
    );

    expect(directApiFetch).toMatchObject({
      stage: "direct-api-fetch",
      metadata: {
        providerFamily: "protocol-native-dex",
        phase: "direct-api-fetch",
        providerFamilies: expect.arrayContaining(["fluid", "balancer"]),
        countTotals: { sourceFamilies: expect.any(Number) },
      },
    });
    expect(scoringComplete).toMatchObject({
      stage: "scoring-complete",
      metadata: {
        providerFamily: "internal",
        phase: "scoring-complete",
        countTotals: {
          scoreRows: expect.any(Number),
        },
      },
    });
    expect(priceCompleteIndex).toBeGreaterThan(-1);
    expect(challengerCompleteIndex).toBeGreaterThan(priceCompleteIndex);
  });

  it("accepts compacted production-scale primary rows while reporting raw counts", async () => {
    const rawPoolCount = 15_430;
    const lookups = buildSymbolLookups();
    const [trackedKey] = lookups.chainAddressToId.keys();
    expect(trackedKey).toBeDefined();
    const separator = trackedKey!.indexOf(":");
    const trackedChain = trackedKey!.slice(0, separator);
    const trackedAddress = trackedKey!.slice(separator + 1);
    const trackedPool: LlamaPool = {
      pool: "tracked-pool",
      chain: trackedChain,
      project: "scale-dex",
      symbol: "TRACKED-QUOTE",
      tvlUsd: 1_000_000,
      volumeUsd1d: 50_000,
      volumeUsd7d: 300_000,
      stablecoin: false,
      underlyingTokens: [trackedAddress, "unknown-quote"],
      apyBase: null,
      apyReward: null,
      apy: 0,
      sigma: 0,
      exposure: "multi",
      count: 20,
    };
    vi.mocked(fetchDataSources).mockResolvedValueOnce({
      pools: [trackedPool],
      rawPoolCount,
      dexProjects: new Set(["scale-dex"]),
      protocolTvlCaps: new Map(),
      curvePayloads: [],
      graphApiKey: "graph-key",
      dlYieldsAvailable: true,
      dlProtocolsAvailable: true,
    });
    const progressUpdates: CronProgressUpdate[] = [];

    const result = await runDexLiquidityScoringCycle(db, "graph-key", undefined, undefined, undefined, async (update) => {
      progressUpdates.push(update);
    });

    const knownPoolCalls = vi.mocked(buildKnownPoolAddresses).mock.calls;
    const processPoolCalls = vi.mocked(processPoolMetrics).mock.calls;
    expect(knownPoolCalls[knownPoolCalls.length - 1]?.[0]).toEqual([trackedPool]);
    expect(processPoolCalls[processPoolCalls.length - 1]?.[0]?.pools).toEqual([trackedPool]);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ rowsRead: rawPoolCount });
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
    const primaryPool: LlamaPool = {
      pool: "primary-pool",
      chain,
      project: "memory-dex",
      symbol: "TRACKED-QUOTE",
      tvlUsd: 1_000_000,
      volumeUsd1d: 50_000,
      volumeUsd7d: 300_000,
      stablecoin: false,
      underlyingTokens: [address, quoteAddress],
      apyBase: null,
      apyReward: null,
      apy: 0,
      sigma: 0,
      exposure: "multi",
      count: 20,
    };
    const sourceData = {
      pools: [primaryPool],
      rawPoolCount: 1,
      dexProjects: new Set(["memory-dex"]),
      protocolTvlCaps: new Map<string, number>(),
      curvePayloads: [],
      graphApiKey: "graph-key",
      dlYieldsAvailable: true,
      dlProtocolsAvailable: true,
    };
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
    const directResult = {
      pools: [directPool],
      ok: true,
      degraded: false,
      errors: [] as string[],
      pagination: {
        state: "partial" as const,
        headRefreshed: true,
        pagesFetched: 5,
        cursor: "next-page",
        cycleCompleted: false,
      },
    };
    const pancakeResult = { pools: [pancakePool], ok: true, degraded: false, errors: [] as string[] };
    const curvePoolMap = new Map([["curve-key", {} as never]]);
    const uniV3PoolFees = new Map([["fee-key", 500]]);
    const uniV3ExecutionCandidates = new Map([["candidate-key", []]]);

    vi.mocked(fetchFluidPools).mockResolvedValueOnce(directResult);
    vi.mocked(fetchPancakeSwapPools).mockResolvedValueOnce(pancakeResult);
    vi.mocked(fetchRaydiumPools).mockResolvedValueOnce({
      pools: [],
      ok: true,
      degraded: false,
      errors: [],
      warnings: ["release-warning"],
    });
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
    });
    vi.mocked(mergeStagedPools).mockImplementationOnce(
      async (_db, _metrics, _known, _now, _references, confirmation) => {
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
          mergedCount: 0,
          skippedCount: 0,
          skippedByExactIdentityCount: 0,
          skippedByUniqueDerivedIdentityCount: 0,
          skippedByOptionalWildcardIdentityCount: 0,
          skippedByAuthoritativeProtocolCount: 0,
          skipDimensions: [],
          priceObservations: new Map(),
        };
      },
    );

    const startedAt = Math.floor(Date.now() / 1000);
    const result = await runDexLiquidityScoringCycle(db, "graph-key");
    expect(mergeStagedPools).toHaveBeenCalledOnce();
    const scoreCalls = vi.mocked(computeStablecoinScores).mock.calls;
    const scoreCall = scoreCalls[scoreCalls.length - 1];
    const pancakeTargets = scoreCall?.[5];
    const fluidTargets = scoreCall?.[6];
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
    expect([...fluidTargets!.values()]).toContainEqual(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        adapterProfileId: "fluid-resolver-measured",
        poolId: "ethereum:0x1111111111111111111111111111111111111111",
        poolTokenAddresses: [address, quoteAddress],
        tokenIn: expect.objectContaining({ address, trackedAssetId: "usdt-tether" }),
        tokenOut: expect.objectContaining({ address: quoteAddress, trackedAssetId: "usdc-circle" }),
        retainedTvlUsd: 1_000_000,
        capturedAt: expect.any(Number),
      }),
    );
    expect([...fluidTargets!.values()].every((target) => target.capturedAt >= startedAt)).toBe(true);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      directApiSourceSummary?: {
        sourceWarnings?: string[];
        pagination?: Array<Record<string, unknown>>;
      };
    };
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
    vi.mocked(fetchRaydiumPools).mockResolvedValueOnce({
      pools: [],
      ok: false,
      degraded: true,
      errors: ["query poolType type error"],
    });

    const result = await runDexLiquidityScoringCycle(db, "graph-key");

    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
      fallbackMode?: string[];
      sourceCoverage?: {
        sourceDegradedFamilies?: string[];
      };
    };
    expect(metadata.failedSources).toContain("raydium-api");
    expect(metadata.fallbackMode).toContain("raydium-api-unavailable");
    expect(metadata.sourceCoverage?.sourceDegradedFamilies).toEqual([]);
    expect(persistScores).toHaveBeenCalled();
  });

  it("carries BSC Uniswap V3 direct candidates into the shadow target accumulator", async () => {
    const pool: DexApiPool = {
      source: "uniswap-v3-shadow",
      chain: "bsc",
      poolAddress: "0xf150d29d92e7460a1531cbc9d1abeab33d6998e4",
      poolType: "uniswap-v3",
      tokens: [
        { address: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT", decimals: 18 },
        { address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", symbol: "USD1", decimals: 18 },
      ],
      price: 1,
      tvlUsd: 2_000_000,
      volume24hUsd: 50_000,
      feeRate: 0.0001,
      balances: [1_000_000, 1_000_000],
    };
    vi.mocked(fetchUniswapV3BscShadowPools).mockResolvedValueOnce({
      pools: [pool],
      ok: true,
      degraded: false,
      errors: [],
    });

    await runDexLiquidityScoringCycle(db, "graph-key");

    const scoreCalls = vi.mocked(computeStablecoinScores).mock.calls;
    const scoreCall = scoreCalls[scoreCalls.length - 1];
    const shadowTargets = scoreCall?.[9];
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
    vi.mocked(fetchFluidPools).mockImplementationOnce(() => fluidGate.promise);

    const syncPromise = runDexLiquidityScoringCycle(db, "graph-key");

    await vi.waitFor(() => expect(fetchFluidPools).toHaveBeenCalledOnce());
    expect(fetchDataSources).not.toHaveBeenCalled();
    expect(fetchUniV3Data).not.toHaveBeenCalled();
    expect(fetchAerodromeData).not.toHaveBeenCalled();

    fluidGate.resolve(makeDirectApiResult());
    await syncPromise;
    expect(fetchDataSources).toHaveBeenCalledOnce();
    expect(fetchUniV3Data).toHaveBeenCalledOnce();
    expect(fetchAerodromeData).toHaveBeenCalledOnce();
  });

  it("stages the exact bounded six-chain Uni V3 source family", async () => {
    expect(Object.keys(UNIV3_SUBGRAPHS)).toEqual([
      "ethereum",
      "base",
      "arbitrum",
      "polygon",
      "celo",
      "bsc",
    ]);

    await runDexLiquidityScoringCycle(db, "graph-key");

    expect(fetchUniV3Data).toHaveBeenCalledOnce();
    const [graphApiKey, symbolToChainScopedIds, chainAddressToId, signal, references] =
      vi.mocked(fetchUniV3Data).mock.calls[0]!;
    expect(graphApiKey).toBe("graph-key");
    expect(symbolToChainScopedIds).toBeInstanceOf(Map);
    expect(chainAddressToId).toBeInstanceOf(Map);
    expect(signal).toBeUndefined();
    expect(references).toEqual(expect.any(Object));
  });

  it("passes scheduled chain RPCs into Fluid enrichment", async () => {
    const chainRpcs = new Map<string, ChainRpcConfig>();

    await runDexLiquidityScoringCycle(db, "graph-key", undefined, undefined, chainRpcs);

    expect(fetchFluidPools).toHaveBeenCalledWith(expect.any(AbortSignal), chainRpcs);
  });

  it("threads tracked stablecoin cache prices into direct API conversion and observations", async () => {
    let convertedStablecoinPrices: Map<string, number> | undefined;
    let observedStablecoinPrices: Map<string, number> | undefined;
    const fluidPool: DexApiPool = {
      source: "fluid",
      chain: "Ethereum",
      poolAddress: "0x1111111111111111111111111111111111111111",
      poolType: "fluid-dex",
      tokens: [
        { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
        { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 },
      ],
      price: 1,
      tvlUsd: 500_000,
      volume24hUsd: 120_000,
      feeRate: 0.0001,
      balances: [250_000, 250_000],
    };
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
    vi.mocked(fetchFluidPools).mockResolvedValueOnce({
      pools: [fluidPool],
      ok: true,
      degraded: false,
      errors: [] as string[],
    });
    vi.mocked(convertToGtNewPools).mockImplementationOnce((...args) => {
      convertedStablecoinPrices = new Map(args[4]);
      return new Map([["usdc-circle", []]]);
    });
    vi.mocked(extractPriceObservations).mockImplementationOnce((...args) => {
      observedStablecoinPrices = new Map(args[4]);
      return new Map([["usdc-circle", []]]);
    });

    await runDexLiquidityScoringCycle(db, "graph-key");

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

  it("warns and falls back to reference pricing when the stablecoins cache is unusable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runDexLiquidityScoringCycle(db, "graph-key");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[dex-liquidity] Stablecoins cache unavailable for tracked quote pricing and market cap data; using reference-only / absolute fallback"),
    );
  });

  it("records drift and evidence telemetry when previous run metadata exists", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce({
      pools: [],
      rawPoolCount: 0,
      dexProjects: new Set<string>(),
      protocolTvlCaps: new Map<string, number>([["curve", 50]]),
      curvePayloads: [],
      graphApiKey: "graph-key",
      dlYieldsAvailable: true,
      dlProtocolsAvailable: true,
    });
    vi.mocked(fetchFluidPools).mockResolvedValueOnce({
      pools: [
        {
          source: "fluid",
          chain: "Ethereum",
          poolAddress: "0xfluid-pool",
          poolType: "fluid",
          tokens: [
            { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
            { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 },
          ],
          price: 1,
          tvlUsd: 100_000,
          volume24hUsd: 10_000,
          feeRate: 0.0001,
          balances: [50_000_000_000, 50_000_000_000],
        },
      ],
      ok: true,
      degraded: false,
      errors: [],
    });
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
    vi.mocked(computeStablecoinScores).mockResolvedValueOnce({
      scores: new Map([
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
      ]),
      globalAgg: { totalTvl: 100 },
      retainedPoolsByStablecoin: new Map([
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
      ]),
      tvlStabilityMap: new Map(),
      diagnostics: {
        protocolCapReductions: { cappedPoolCount: 1, cappedProtocols: 1, reducedTvlUsd: 50 },
      },
    } as Awaited<ReturnType<typeof computeStablecoinScores>>);

    const driftDb = {
      prepare(sql: string) {
        if (sql.includes("COUNT(*) as cnt FROM dex_liquidity WHERE stablecoin_id != '__global__'")) {
          return { first: async () => ({ cnt: 5 }) };
        }
        if (sql.includes("SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'")) {
          return { first: async () => ({ total_tvl_usd: 100 }) };
        }
        if (sql.includes("GROUP BY coverage_class")) {
          return { all: async () => ({ results: [] }) };
        }
        if (sql.includes("ORDER BY total_tvl_usd DESC")) {
          return { all: async () => ({ results: [{ stablecoin_id: "usdc-circle", total_tvl_usd: 100 }] }) };
        }
        if (sql.includes("SELECT started_at, status, metadata") && sql.includes("cron_runs")) {
          return {
            all: async () => ({
              results: [
                {
                  started_at: 1,
                  status: "ok",
                  metadata: JSON.stringify({
                    stagedPoolsMerged: 10,
                    stagedPoolsSkipped: 0,
                    sourceCoverage: {
                      dlYieldsAvailable: true,
                      dlProtocolsAvailable: true,
                      currentGlobalTvl: 100,
                      priceObservationCoins: 5,
                      measuredBalanceCoveragePct: 0.5,
                      weakCoverageCoins: 0,
                    },
                  }),
                },
              ],
            }),
          };
        }
        if (sql.includes("WHERE stablecoin_id IN")) {
          return {
            bind: () => ({
              all: async () => ({
                results: [
                  {
                    stablecoin_id: "usdc-circle",
                    pool_count: 5,
                    coverage_confidence: 0.9,
                    total_tvl_usd: 100,
                    balance_measured_tvl_usd: 50,
                  },
                ],
              }),
            }),
          };
        }
        return {
          bind: () => ({
            all: async () => ({ results: [] }),
            first: async () => ({ cnt: 0 }),
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async () => ({ results: [] }),
          first: async () => ({ cnt: 0 }),
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const result = await runDexLiquidityScoringCycle(driftDb, "graph-key");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sourceCoverage?: {
        qualityDriftSeverity?: string;
        qualityDriftFlags?: string[];
        coinsWithoutMeasuredBalances?: number;
        coinsGtOnly?: number;
        coinsCrawlerOnly?: number;
        coinsPriceOnlyNoMeasuredLiquidity?: number;
        protocolCapReductions?: {
          topProtocols?: Array<{ protocol: string; reducedTvlUsd: number }>;
          topStablecoins?: Array<{ stablecoinId: string; reducedTvlUsd: number }>;
        };
        topAssetCoverageDeltas?: Array<{ stablecoinId: string; poolCountPctDelta: number | null }>;
      };
    };

    expect(metadata.sourceCoverage?.qualityDriftSeverity).toBe("high");
    expect(metadata.sourceCoverage?.qualityDriftFlags).toEqual(
      expect.arrayContaining(["price-observation-drop", "measured-balance-drop", "watchlist-pool-drop:usdc-circle"]),
    );
    expect(metadata.sourceCoverage?.coinsWithoutMeasuredBalances).toBe(1);
    expect(metadata.sourceCoverage?.coinsGtOnly).toBe(1);
    expect(metadata.sourceCoverage?.coinsCrawlerOnly).toBe(1);
    expect(metadata.sourceCoverage?.coinsPriceOnlyNoMeasuredLiquidity).toBe(1);
    expect(metadata.sourceCoverage?.protocolCapReductions?.topProtocols).toEqual([
      expect.objectContaining({ protocol: "curve", reducedTvlUsd: 50 }),
    ]);
    expect(metadata.sourceCoverage?.protocolCapReductions?.topStablecoins).toEqual([
      expect.objectContaining({ stablecoinId: "usdc-circle", reducedTvlUsd: 50 }),
    ]);
    expect(metadata.sourceCoverage?.topAssetCoverageDeltas).toEqual([
      expect.objectContaining({ stablecoinId: "usdc-circle", poolCountPctDelta: -0.8 }),
      expect.objectContaining({ stablecoinId: "usdt-tether", poolCountPctDelta: null }),
      expect.objectContaining({ stablecoinId: "dai-makerdao", poolCountPctDelta: null }),
      expect.objectContaining({ stablecoinId: "usds-sky", poolCountPctDelta: null }),
      expect.objectContaining({ stablecoinId: "usde-ethena", poolCountPctDelta: null }),
    ]);
  });
});
