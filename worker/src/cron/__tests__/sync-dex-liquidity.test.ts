import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../dex-liquidity/fetch-primary", () => ({
  fetchDataSources: vi.fn(async () => null),
  buildCurveLookups: vi.fn(async () => ({ curvePoolMap: new Map(), priceObservations: new Map() })),
  fetchUniV3Data: vi.fn(async () => ({ uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(), uniV3PriceObs: new Map() })),
  fetchAerodromeData: vi.fn(async () => ({ aerodromePriceObs: new Map(), aerodromeIsStable: new Map() })),
  buildKnownPoolAddresses: vi.fn(() => new Set<string>()),
}));

vi.mock("../dex-liquidity/process-pools", () => ({
  processPoolMetrics: vi.fn(() => new Map()),
}));

vi.mock("../dex-liquidity/scoring", () => ({
  computeStablecoinScores: vi.fn(async () => ({ scores: new Map([["usdt-tether", {}]]), globalAgg: {} })),
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

import { syncDexLiquidity } from "../dex-liquidity";
import { fetchDataSources } from "../dex-liquidity/fetch-primary";

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

  it("returns ok when required source families succeed", async () => {
    const result = await syncDexLiquidity(db, "graph-key");

    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
      stagedPoolsSkippedByAddress?: number;
      stagedPoolsSkippedByFingerprint?: number;
      sourceCoverage?: { nearCoverageGuard?: boolean };
    };
    expect(metadata.failedSources).toEqual([]);
    expect(metadata.stagedPoolsSkippedByAddress).toBe(0);
    expect(metadata.stagedPoolsSkippedByFingerprint).toBe(0);
    expect(metadata.sourceCoverage?.nearCoverageGuard).toBe(false);
  });
});
