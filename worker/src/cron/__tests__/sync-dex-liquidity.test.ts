import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinData } from "@shared/types";
import type { DexApiPool } from "../../lib/dex-api-common";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { LlamaPool } from "../dex-liquidity/types";

function makeDirectApiResult() {
  return Object.assign([], { ok: true, degraded: false, errors: [] as string[] });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("../dex-liquidity/fetch-primary", () => ({
  fetchDataSources: vi.fn(async () => null),
  buildCurveLookups: vi.fn(async () => ({ curvePoolMap: new Map(), priceObservations: new Map() })),
  fetchUniV3Data: vi.fn(async () => ({ uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(), uniV3PriceObs: new Map() })),
  fetchAerodromeData: vi.fn(async () => ({ aerodromePriceObs: new Map(), aerodromeIsStable: new Map() })),
  buildKnownPoolAddresses: vi.fn(() => ({
    exactKeys: new Set<string>(),
    derivedKeyCounts: new Map<string, number>(),
    derivedToExactKeys: new Map<string, Set<string>>(),
  })),
}));

vi.mock("../dex-liquidity/process-pools", () => ({
  processPoolMetrics: vi.fn(() => new Map()),
}));

vi.mock("../dex-liquidity/scoring", () => ({
  computeStablecoinScores: vi.fn(async () => ({
    scores: new Map([["usdt-tether", { coverageClass: "primary", tvl: 0 }]]),
    globalAgg: { totalTvl: 0 },
    retainedPoolsByStablecoin: new Map(),
    tvlStabilityMap: new Map(),
  })),
  computeDepthStability: vi.fn(async () => {}),
  computeDexPrices: vi.fn(async () => {}),
}));

vi.mock("../dex-liquidity/persistence", () => ({
  persistScores: vi.fn(async () => {}),
  writeHistoricalSnapshots: vi.fn(async () => {}),
}));

vi.mock("../dex-liquidity/fetch-fallbacks", () => ({
  fetchDsFallbackPools: vi.fn(async () => ({ newPools: new Map(), priceObs: new Map() })),
  fetchCgTickersFallback: vi.fn(async () => ({ newPools: new Map(), priceObs: new Map() })),
}));

vi.mock("../dex-liquidity/fetch-fluid", () => ({ fetchFluidPools: vi.fn(async () => makeDirectApiResult()) }));
vi.mock("../dex-liquidity/fetch-balancer", () => ({ fetchBalancerPools: vi.fn(async () => makeDirectApiResult()) }));
vi.mock("../dex-liquidity/fetch-raydium", () => ({ fetchRaydiumPools: vi.fn(async () => makeDirectApiResult()) }));
vi.mock("../dex-liquidity/fetch-orca", () => ({ fetchOrcaPools: vi.fn(async () => makeDirectApiResult()) }));
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

import { syncDexLiquidity } from "../dex-liquidity";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { convertToGtNewPools, extractPriceObservations } from "../../lib/dex-api-common";
import { fetchAerodromeData, fetchDataSources, fetchUniV3Data } from "../dex-liquidity/fetch-primary";
import { fetchFluidPools } from "../dex-liquidity/fetch-fluid";
import { fetchRaydiumPools } from "../dex-liquidity/fetch-raydium";
import { filterPrimaryPoolsPreferDirectApi } from "../dex-liquidity/orchestrator";

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
      dexProjects: new Set<string>(),
      protocolTvlCaps: new Map<string, number>(),
      curveResponses: [],
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
    await expect(syncDexLiquidity(db, "graph-key")).rejects.toThrow(
      "catastrophic source failure",
    );
  });

  it("returns degraded when non-catastrophic critical source family fails", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce({
      pools: [],
      dexProjects: new Set<string>(),
      protocolTvlCaps: new Map<string, number>(),
      curveResponses: [],
      graphApiKey: "graph-key",
      dlYieldsAvailable: true,
      dlProtocolsAvailable: false,
    });

    const result = await syncDexLiquidity(db, "graph-key");

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
      fallbackMode?: string[];
    };
    expect(metadata.failedSources).toContain("defillama-protocols");
    expect(metadata.fallbackMode).toContain("dl-protocols-unavailable");
  });

  it("returns degraded when DL fails but Curve succeeds", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce({
      pools: [],
      dexProjects: new Set<string>(),
      protocolTvlCaps: new Map<string, number>(),
      curveResponses: [new Response("{}", { status: 200 })],
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
  });

  it("returns ok when required source families succeed", async () => {
    const result = await syncDexLiquidity(db, "graph-key");

    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
      stagedPoolsSkippedByExactIdentity?: number;
      stagedPoolsSkippedByUniqueDerivedIdentity?: number;
      sourceCoverage?: { nearCoverageGuard?: boolean };
    };
    expect(metadata.failedSources).toEqual([]);
    expect(metadata.stagedPoolsSkippedByExactIdentity).toBe(0);
    expect(metadata.stagedPoolsSkippedByUniqueDerivedIdentity).toBe(0);
    expect(metadata.sourceCoverage?.nearCoverageGuard).toBe(false);
  });

  it("returns degraded when a direct API source is unavailable", async () => {
    vi.mocked(fetchRaydiumPools).mockResolvedValueOnce(
      Object.assign([], { ok: false, degraded: true, errors: ["query poolType type error"] }),
    );

    const result = await syncDexLiquidity(db, "graph-key");

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
      fallbackMode?: string[];
    };
    expect(metadata.failedSources).toContain("raydium-api");
    expect(metadata.fallbackMode).toContain("raydium-api-unavailable");
  });

  it("waits for subgraph enrichment before starting direct API fetches", async () => {
    const emptyUniV3 = { uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(), uniV3PriceObs: new Map() };
    const emptyAerodrome = { aerodromePriceObs: new Map(), aerodromeIsStable: new Map() };
    const uniV3Gate = deferred<typeof emptyUniV3>();
    const aerodromeGate = deferred<typeof emptyAerodrome>();

    vi.mocked(fetchUniV3Data).mockImplementationOnce(() => uniV3Gate.promise);
    vi.mocked(fetchAerodromeData).mockImplementationOnce(() => aerodromeGate.promise);

    const syncPromise = syncDexLiquidity(db, "graph-key");

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchFluidPools).not.toHaveBeenCalled();

    uniV3Gate.resolve(emptyUniV3);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchFluidPools).not.toHaveBeenCalled();

    aerodromeGate.resolve(emptyAerodrome);
    await syncPromise;
    expect(fetchFluidPools).toHaveBeenCalled();
  });

  it("passes scheduled chain RPCs into Fluid enrichment", async () => {
    const chainRpcs = new Map<string, ChainRpcConfig>();

    await syncDexLiquidity(db, "graph-key", undefined, undefined, chainRpcs);

    expect(fetchFluidPools).toHaveBeenCalledWith(undefined, chainRpcs);
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
    vi.mocked(fetchFluidPools).mockResolvedValueOnce(Object.assign([fluidPool], { ok: true, degraded: false, errors: [] as string[] }));
    vi.mocked(convertToGtNewPools).mockReturnValueOnce(new Map([
      ["usdc-circle", []],
    ]));
    vi.mocked(extractPriceObservations).mockReturnValueOnce(new Map([
      ["usdc-circle", []],
    ]));

    await syncDexLiquidity(db, "graph-key");

    const convertCall = vi.mocked(convertToGtNewPools).mock.calls[0];
    expect(convertCall).toBeDefined();
    const convertStablecoinPrices = convertCall?.[5];
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
      "[dex-liquidity] Stablecoins cache unavailable for tracked quote pricing; using reference-only fallback",
    );
  });
});

describe("filterPrimaryPoolsPreferDirectApi", () => {
  it("does not let an absurd direct-API pool suppress a healthy primary pool", () => {
    const pools: LlamaPool[] = [{
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
    }];
    const directApiPools: DexApiPool[] = [{
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
    }];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(1);
    expect(result.skippedByExactIdentity).toBe(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(0);
  });
});
