import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinData } from "@shared/types/market";
import type { DexApiPool } from "../../lib/dex-api-common";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { CronProgressUpdate } from "../../lib/cron-logger";
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
}));

vi.mock("../dex-liquidity/fetch-primary", () => ({
  fetchDataSources: vi.fn(async () => null),
  buildCurveLookups: vi.fn(async () => ({ curvePoolMap: new Map(), priceObservations: new Map() })),
  buildKnownPoolAddresses: vi.fn(() => ({
    exactKeys: new Set<string>(),
    derivedKeyCounts: new Map<string, number>(),
    derivedToExactKeys: new Map<string, Set<string>>(),
    wildcardKeyCounts: new Map<string, number>(),
    wildcardToExactKeys: new Map<string, Set<string>>(),
    concreteFeeVariantKeys: new Map<string, Set<string>>(),
  })),
}));

vi.mock("../dex-liquidity/process-pools", () => ({
  processPoolMetrics: vi.fn(() => new Map()),
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

vi.mock("../dex-liquidity/fetch-fallbacks", () => ({
  fetchDsFallbackPools: vi.fn(async () => ({ newPools: new Map(), priceObs: new Map() })),
  fetchCgTickersFallback: vi.fn(async () => ({ newPools: new Map(), priceObs: new Map() })),
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

import { syncDexLiquidity } from "../dex-liquidity/orchestrator";
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
import { computeDepthStability, computeDexPrices, computeStablecoinScores } from "../dex-liquidity/scoring";
import { persistScores, writeHistoricalSnapshots } from "../dex-liquidity/persistence";
import { filterPrimaryPoolsPreferDirectApi } from "../dex-liquidity/orchestrator";
import { buildSymbolLookups } from "../dex-liquidity/pool-helpers";
import { processPoolMetrics } from "../dex-liquidity/process-pools";
import { mergeStagedPools } from "../dex-liquidity/staging-merge";
import { fetchCgTickersFallback, fetchDsFallbackPools } from "../dex-liquidity/fetch-fallbacks";
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

describe("syncDexLiquidity", () => {
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
  });

  it("throws on catastrophic source failure instead of silently returning", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce(null);
    await expect(syncDexLiquidity(db, "graph-key")).rejects.toThrow("catastrophic source failure");
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

    const result = await syncDexLiquidity(db, "graph-key");

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

    const result = await syncDexLiquidity(db, "graph-key");

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

    const result = await syncDexLiquidity(guardDb, "graph-key");

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
    const result = await syncDexLiquidity(db, "graph-key");

    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
      stagedPoolsSkippedByExactIdentity?: number;
      stagedPoolsSkippedByUniqueDerivedIdentity?: number;
      sourceCoverage?: {
        nearCoverageGuard?: boolean;
        weakCoverageCoins?: number;
        coverageRecoveredCoins?: number;
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
    expect(metadata.sourceCoverage?.coverageRecoveredCoins).toBe(0);
    expect(metadata.sourceCoverage?.directCexOrderbookDepth).toMatchObject({
      observations: 3,
      maxDepthDown2PctUsdBySymbol: { USDT: 1_000_000, USDC: 500_000 },
    });
    expect(metadata.sourceCoverage?.qualityDriftSeverity).toBe("none");
    expect(metadata.sourceCoverage?.qualityDriftFlags).toEqual([]);
    expect(metadata.sourceCoverage?.coinsWithoutMeasuredBalances).toBe(0);
    expect(metadata.sourceCoverage?.protocolCapReductions?.reducedTvlUsd).toBe(0);
    expect(fetchDsFallbackPools).not.toHaveBeenCalled();
    expect(fetchCgTickersFallback).not.toHaveBeenCalled();
  });

  it("fetches bounded market telemetry before pool graphs accumulate", async () => {
    const knownPoolIndex = {
      exactKeys: new Set(["ethereum:0xpool"]),
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

    await syncDexLiquidity(db, "graph-key");
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

    await syncDexLiquidity(db, "graph-key");

    expect(fetchDataSources).toHaveBeenCalledOnce();
  });

  it("reports high-SLO stage metadata during source and scoring phases", async () => {
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });

    await syncDexLiquidity(db, "graph-key", undefined, undefined, undefined, reportProgress);

    const directApiFetch = progressUpdates.find((update) => update.stage === "direct-api-fetch");
    const scoringComplete = progressUpdates.find((update) => update.stage === "scoring-complete");

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

    const result = await syncDexLiquidity(db, "graph-key", undefined, undefined, undefined, async (update) => {
      progressUpdates.push(update);
    });

    const knownPoolCalls = vi.mocked(buildKnownPoolAddresses).mock.calls;
    const processPoolCalls = vi.mocked(processPoolMetrics).mock.calls;
    expect(knownPoolCalls[knownPoolCalls.length - 1]?.[0]).toEqual([trackedPool]);
    expect(processPoolCalls[processPoolCalls.length - 1]?.[0]).toEqual([trackedPool]);
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
    const result = await syncDexLiquidity(db, "graph-key");
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

    const result = await syncDexLiquidity(db, "graph-key");

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

  it("waits for direct API fetches before loading primary and subgraph sources", async () => {
    const fluidGate = deferred<ReturnType<typeof makeDirectApiResult>>();
    vi.mocked(fetchFluidPools).mockImplementationOnce(() => fluidGate.promise);

    const syncPromise = syncDexLiquidity(db, "graph-key");

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

  it("passes scheduled chain RPCs into Fluid enrichment", async () => {
    const chainRpcs = new Map<string, ChainRpcConfig>();

    await syncDexLiquidity(db, "graph-key", undefined, undefined, chainRpcs);

    expect(fetchFluidPools).toHaveBeenCalledWith(expect.any(AbortSignal), chainRpcs);
  });

  it("threads tracked stablecoin cache prices into direct API conversion and observations", async () => {
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
    vi.mocked(convertToGtNewPools).mockReturnValueOnce(new Map([["usdc-circle", []]]));
    vi.mocked(extractPriceObservations).mockReturnValueOnce(new Map([["usdc-circle", []]]));

    await syncDexLiquidity(db, "graph-key");

    const convertCall = vi.mocked(convertToGtNewPools).mock.calls[0];
    expect(convertCall).toBeDefined();
    const convertStablecoinPrices = convertCall?.[4];
    expect(convertStablecoinPrices).toBeInstanceOf(Map);
    expect(Array.from(convertStablecoinPrices?.entries() ?? [])).toEqual([
      ["usdc-circle", 0.97],
      ["usdt-tether", 1.01],
    ]);

    const observationCall = vi.mocked(extractPriceObservations).mock.calls[0];
    expect(observationCall).toBeDefined();
    const observationStablecoinPrices = observationCall?.[4];
    expect(observationStablecoinPrices).toBeInstanceOf(Map);
    expect(Array.from(observationStablecoinPrices?.entries() ?? [])).toEqual([
      ["usdc-circle", 0.97],
      ["usdt-tether", 1.01],
    ]);
  });

  it("warns and falls back to reference pricing when the stablecoins cache is unusable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncDexLiquidity(db, "graph-key");

    expect(warnSpy).toHaveBeenCalledWith(
      "[dex-liquidity] Stablecoins cache unavailable for tracked quote pricing and market cap data; using reference-only / absolute fallback",
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

    const result = await syncDexLiquidity(driftDb, "graph-key");
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

describe("filterPrimaryPoolsPreferDirectApi", () => {
  it("does not let an absurd direct-API pool suppress a healthy primary pool", () => {
    const pools: LlamaPool[] = [
      {
        pool: "0xpool",
        chain: "Fantom",
        project: "balancer-stable",
        symbol: "USDC-USDT",
        tvlUsd: 2_500_000,
        volumeUsd1d: 250_000,
        volumeUsd7d: 1_500_000,
        stablecoin: true,
        underlyingTokens: ["0xusdc", "0xusdt"],
        apyBase: null,
        apyReward: null,
        apy: 0,
        sigma: 0,
        exposure: "multi",
        count: 2,
      },
    ];
    const directApiPools: DexApiPool[] = [
      {
        source: "balancer",
        chain: "Fantom",
        poolAddress: "0xpool",
        poolType: "balancer-stable",
        tokens: [
          { address: "0xusdc", symbol: "USDC", decimals: 6 },
          { address: "0xusdt", symbol: "USDT", decimals: 6 },
        ],
        price: 1,
        tvlUsd: 337_000_000_000,
        volume24hUsd: 100_000,
        feeRate: 0.0001,
        balances: [1_000_000, 1_000_000],
      },
    ];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(1);
    expect(result.skippedByExactIdentity).toBe(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(0);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("deduplicates an Orca DL pool via optional wildcard identity when only fee metadata is missing", () => {
    const pools: LlamaPool[] = [
      {
        pool: "4f44c5d5-b1c2-4b1c-a111-123456789abc",
        chain: "Solana",
        project: "orca-dex",
        symbol: "SOL-USDC",
        tvlUsd: 29_000_000,
        volumeUsd1d: 2_500_000,
        volumeUsd7d: 17_000_000,
        stablecoin: false,
        underlyingTokens: [
          "So11111111111111111111111111111111111111112",
          "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1",
        ],
        apyBase: null,
        apyReward: null,
        apy: 0,
        sigma: 0,
        exposure: "multi",
        count: 20,
      },
    ];
    const directApiPools: DexApiPool[] = [
      {
        source: "orca",
        chain: "solana",
        poolAddress: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
        poolType: "orca-whirlpool",
        tokens: [
          { address: "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", symbol: "USDC", decimals: 6 },
          { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
        ],
        price: 150,
        tvlUsd: 29_000_000,
        volume24hUsd: 2_500_000,
        feeRate: 0.0001,
        balances: [100_000, 200_000],
      },
    ];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(0);
    expect(result.skippedByExactIdentity).toBe(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(1);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("deduplicates a Balancer V3 DL stable pool via na-variant derived identity when DL omits the stable subtype", () => {
    const pools: LlamaPool[] = [
      {
        pool: "0511276f-4d37-4919-95ab-6cdf418ddd08",
        chain: "Plasma",
        project: "balancer-v3",
        symbol: "USDAI-WAPLAUSDT0",
        tvlUsd: 547_701,
        volumeUsd1d: null,
        volumeUsd7d: null,
        stablecoin: true,
        underlyingTokens: ["0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", "0xe0126f0c4451b2b917064a93040fd4770d6774b5"],
        apyBase: null,
        apyReward: null,
        apy: 1.39196,
        sigma: 0,
        exposure: "multi",
        count: 180,
      },
    ];
    const directApiPools: DexApiPool[] = [
      {
        source: "balancer",
        chain: "Plasma",
        poolAddress: "0x01e2c7fcde2b8d5d1413732c4e274ba5b06b1e54",
        poolType: "balancer-stable",
        tokens: [
          { address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", symbol: "USDai", decimals: 18 },
          { address: "0xe0126f0c4451b2b917064a93040fd4770d6774b5", symbol: "waPlaUSDT0", decimals: 18 },
        ],
        price: 0.999939,
        tvlUsd: 547_664.8,
        volume24hUsd: 5_900.52,
        feeRate: 0.0001,
        balances: [240_716.79906230856, 301_609.539917],
      },
    ];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(0);
    expect(result.skippedByExactIdentity).toBe(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(1);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("deduplicates a DL raydium-amm stable pair against the direct Raydium pool via the tracked-pair stability hint", () => {
    // Live duplicate observed in production: DL marks USDS-USDC stable
    // (pool.stablecoin) while the direct Raydium pool type carries no
    // stability, so without the tracked-pair hint the stability buckets
    // diverge and both rows survive, double-counting ~$9.1M TVL.
    const USDS_MINT = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA";
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const pools: LlamaPool[] = [
      {
        pool: "5b6c56a9-3b81-48ee-bee7-3f0dcd862e4d",
        chain: "Solana",
        project: "raydium-amm",
        symbol: "USDS-USDC",
        tvlUsd: 9_101_152,
        volumeUsd1d: 1_034_471,
        volumeUsd7d: null,
        stablecoin: true,
        underlyingTokens: [USDS_MINT, USDC_MINT],
        apyBase: null,
        apyReward: null,
        apy: 0,
        sigma: 0,
        exposure: "multi",
        count: 20,
      },
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

    // Two direct pools with the same identity keep the DL row by the deliberate
    // pool-level ambiguity guard (the DL row could be a third uncovered pool);
    // the wildcard fallback is ambiguous for the same reason.
    const ambiguousTwins = [...singleTwin, directPool("7kJb5ZQF2jWc5m9R8t2xVb4nD6yPeHhTQ3sLuNvAaBbC", 56_127)];
    const ambiguous = filterPrimaryPoolsPreferDirectApi(pools, ambiguousTwins, chainAddressToId);
    expect(ambiguous.filteredPools).toHaveLength(1);
  });

  it("does not use optional wildcard dedup when multiple direct API Orca pools share the same pair", () => {
    const pools: LlamaPool[] = [
      {
        pool: "4f44c5d5-b1c2-4b1c-a111-123456789abc",
        chain: "Solana",
        project: "orca-dex",
        symbol: "SOL-USDC",
        tvlUsd: 29_000_000,
        volumeUsd1d: 2_500_000,
        volumeUsd7d: 17_000_000,
        stablecoin: false,
        underlyingTokens: [
          "So11111111111111111111111111111111111111112",
          "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1",
        ],
        apyBase: null,
        apyReward: null,
        apy: 0,
        sigma: 0,
        exposure: "multi",
        count: 20,
      },
    ];
    const directApiPools: DexApiPool[] = [
      {
        source: "orca",
        chain: "solana",
        poolAddress: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
        poolType: "orca-whirlpool",
        tokens: [
          { address: "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", symbol: "USDC", decimals: 6 },
          { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
        ],
        price: 150,
        tvlUsd: 29_000_000,
        volume24hUsd: 2_500_000,
        feeRate: 0.0001,
        balances: [100_000, 200_000],
      },
      {
        source: "orca",
        chain: "solana",
        poolAddress: "8k6N7m5b4V3c2X1z9Y8w7u6T5r4e3W2q1P9o8i7u6Y5",
        poolType: "orca-whirlpool",
        tokens: [
          { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
          { address: "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", symbol: "USDC", decimals: 6 },
        ],
        price: 150,
        tvlUsd: 500_000,
        volume24hUsd: 50_000,
        feeRate: 0.0005,
        balances: [10_000, 20_000],
      },
    ];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(1);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });
});
