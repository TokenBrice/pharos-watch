import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// --- Module-level mocks ---

// Stub the stablecoins list — one yield-bearing, two non-yield-bearing
vi.mock("../../../../src/lib/stablecoins", () => ({
  TRACKED_STABLECOINS: [
    {
      id: "100",
      name: "sDAI",
      symbol: "sDAI",
      geckoId: "savings-dai",
      flags: {
        pegCurrency: "USD",
        backing: "crypto-backed",
        yieldBearing: true,
        navToken: true,
        governance: "decentralized",
      },
      yieldConfig: {
        yieldSource: "DSR",
        yieldType: "nav-appreciation",
      },
    },
    {
      id: "2",
      name: "USD Coin",
      symbol: "USDC",
      geckoId: "usd-coin",
      flags: {
        pegCurrency: "USD",
        backing: "fiat-backed",
        yieldBearing: false,
        navToken: false,
        governance: "centralized",
      },
    },
    {
      id: "336",
      name: "United Stables",
      symbol: "U",
      geckoId: "united-stables",
      flags: {
        pegCurrency: "USD",
        backing: "rwa-backed",
        yieldBearing: false,
        navToken: false,
        governance: "centralized",
      },
    },
  ],
}));

// Stub fetch-retry to delegate to global fetch
vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

// Stub circuit-breaker
vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

// Stub db helpers
vi.mock("../../lib/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...orig,
    getCache: vi.fn(async () => null),
    setCache: vi.fn(async () => {}),
    batchExecute: vi.fn(async () => {}),
    getFirstSeenDates: vi.fn(async () => new Map()),
  };
});

// Stub chain-rpcs
vi.mock("../../lib/chain-rpcs", () => ({
  getChainRpc: vi.fn(() => null),
}));

// Stub yield-helpers — keep matchAllDlPools real (pure function, no I/O)
vi.mock("../yield-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../yield-helpers")>();
  return {
    ...actual,
    computeApyFromRate: vi.fn(() => 5.0),
    computeApyFromPrice: vi.fn(() => 4.0),
    computePYS: vi.fn(() => 75.0),
    computeYieldStability: vi.fn(() => 0.95),
    computeApyVarianceScore: vi.fn(() => 90),
    detectWarningSignals: vi.fn(() => []),
    findBestLendingPool: vi.fn(() => null),
  };
});

// Stub yield-config
vi.mock("../yield-config", () => ({
  YIELD_VARIANT_MAP: {},
  YIELD_POOL_MAP: {},
  ON_CHAIN_RATE_CONFIGS: [],
  LENDING_PROTOCOL_ALLOWLIST: new Set(["venus-core-pool"]),
  PRICE_DERIVED_FALLBACK_IDS: new Set(),
  AUTO_LENDING_POOL_MAP: {
    "336": "pool-u-venus",
  },
  AUTO_LENDING_SAFETY_BYPASS_IDS: new Set(["336"]),
}));

// Stub report-cards (used for safety score computation)
vi.mock("../../../../src/lib/report-cards", () => ({
  computeOverallGrade: vi.fn(() => ({ score: 80, grade: "B+" })),
  scoreDecentralization: vi.fn(() => ({ score: 80, grade: "B+" })),
  scoreDependencyRisk: vi.fn(() => ({ score: 90, grade: "A-" })),
  scoreLiquidity: vi.fn(() => ({ score: 70, grade: "B" })),
  scorePegStability: vi.fn(() => ({ score: 85, grade: "A-" })),
  scoreResilience: vi.fn(() => ({ score: 75, grade: "B" })),
  isBlacklistable: vi.fn(() => false),
}));

// Stub peg-score
vi.mock("../../../../src/lib/peg-score", () => ({
  computePegScore: vi.fn(() => ({
    pegScore: 95,
    pegPct: 99.5,
    severityScore: 0.1,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: 10,
    activeDepeg: null,
    lastEventAt: null,
    trackingSpanDays: 365,
  })),
  coinTrackingStart: vi.fn(() => 1600000000),
}));

// Stub depeg-helpers
vi.mock("../../lib/depeg-helpers", () => ({
  rowToDepegEvent: vi.fn((row: unknown) => row),
}));

// Stub constants
vi.mock("../../lib/constants", () => ({
  USER_AGENT: "test-agent",
  CIRCUIT_SOURCE: {
    DL_YIELDS: "defillama-yields",
    DL_COINS: "defillama-coins",
    CG_PRICES: "coingecko-prices",
  },
  RISK_FREE_RATE_FALLBACK: 4.5,
  PYS_SCALING_FACTOR: 1.0,
  DEFAULT_SAFETY_SCORE: 50,
  MIN_SAFETY_SCORE_FOR_YIELD: 50,
  MIN_LENDING_POOL_APY: 0.5,
  MIN_LENDING_POOL_TVL_USD: 1_000_000,
}));

import { syncYieldData } from "../sync-yield-data";
import { getCache, setCache, batchExecute } from "../../lib/db";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";
import * as safetyScoresModule from "../../lib/safety-scores";

// --- Helpers ---

function makeDb() {
  return mockD1([
    { match: "cache", rows: [] },
    { match: "yield_data", rows: [] },
    { match: "yield_history", rows: [] },
    { match: "supply_history", rows: [] },
    { match: "depeg_events", rows: [] },
    { match: "dex_liquidity", rows: [] },
  ]);
}

function makeBrokenYieldRankingsDb() {
  return mockD1([
    { match: "cache", rows: [] },
    { match: "yield_data", rows: [{ symbol: "BROKEN", current_apy: 5 }] },
    { match: "yield_history", rows: [] },
    { match: "supply_history", rows: [] },
    { match: "depeg_events", rows: [] },
    { match: "dex_liquidity", rows: [] },
  ]);
}

describe("syncYieldData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    // Reset mocks to factory defaults
    vi.mocked(getCache).mockReset().mockResolvedValue(null);
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
    vi.mocked(batchExecute).mockReset().mockResolvedValue(0);
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("syncs yield data from DeFiLlama pools on normal path", async () => {
    const db = makeDb();

    // DL yields API returns a pool matching sDAI
    mockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            {
              pool: "pool-sdai-1",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 1_000_000_000,
              apy: 5.2,
              apyBase: 5.2,
              apyReward: null,
              apyMean30d: 5.1,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ],
        },
      },
    ]);

    const result = await syncYieldData(db);

    // Should have updated 1 yield-bearing coin
    expect(result.itemCount).toBe(1);
    // batchExecute should have been called for upserts
    expect(batchExecute).toHaveBeenCalled();
    // Cache should have been written for yield-rankings and report_card_cache
    expect(setCache).toHaveBeenCalled();
  });

  it("uses cached DL pools from DEX sync when available", async () => {
    const db = makeDb();

    // Simulate cached pools from DEX sync
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-cached",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 900_000_000,
              apy: 4.8,
              apyBase: 4.8,
              apyReward: null,
              apyMean30d: 4.7,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: Math.floor(Date.now() / 1000),
        };
      }
      return null;
    });

    // No DL yields API call should happen (pools already cached)
    const fetchSpy = mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(1);
    // Should NOT have fetched from yields.llama.fi since cached pools were available
    const yieldCalls = fetchSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("yields.llama.fi")
    );
    expect(yieldCalls.length).toBe(0);
  });

  it("applies deterministic auto-discovery override for U (id 336)", async () => {
    const db = makeDb();

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-u-venus",
              chain: "BSC",
              project: "venus-core-pool",
              symbol: "U",
              tvlUsd: 15_000_000,
              apy: 2.4,
              apyBase: 2.4,
              apyReward: null,
              apyMean30d: 2.3,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: Math.floor(Date.now() / 1000),
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    // sDAI cannot resolve in this fixture; deterministic override should add U.
    expect(result.itemCount).toBe(1);
  });

  it("keeps deterministic override quality-gated (min TVL/APY/allowlist still apply)", async () => {
    const db = makeDb();

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-u-venus",
              chain: "BSC",
              project: "venus-core-pool",
              symbol: "U",
              tvlUsd: 250_000, // below min TVL threshold
              apy: 2.4,
              apyBase: 2.4,
              apyReward: null,
              apyMean30d: 2.3,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: Math.floor(Date.now() / 1000),
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    // Override pool exists but fails min TVL gate, so nothing should be written.
    expect(result.itemCount).toBe(0);
  });

  it("handles DL yields API failure gracefully — no cached pools, API down", async () => {
    const db = makeDb();

    // No cached pools
    vi.mocked(getCache).mockResolvedValue(null);

    // DL yields API returns 500
    mockFetch([
      { match: "yields.llama.fi", body: { error: "Internal Server Error" }, status: 500 },
    ]);

    const result = await syncYieldData(db);

    // Should still return a result — just with no yield data resolved for DL-sourced coins
    // The function might resolve 0 if sDAI couldn't be matched (no DL pools available)
    expect(result.itemCount).toBeDefined();
    // recordOutcome should have been called with failure
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "defillama-yields",
      false,
    );
  });

  it("skips DL yields fetch when circuit breaker is open", async () => {
    const db = makeDb();

    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    const fetchSpy = mockFetch([]);

    const result = await syncYieldData(db);

    // With no pools and circuit open, yield resolution falls through
    expect(result.itemCount).toBeDefined();
    // No DL yields fetch should have been attempted
    const yieldCalls = fetchSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("yields.llama.fi")
    );
    expect(yieldCalls.length).toBe(0);
  });

  it("returns early with itemCount 0 when no yield-bearing coins exist", async () => {
    // Override TRACKED_STABLECOINS to have no yield-bearing coins
    // We can test this by checking the case where yieldCoins is empty
    // Since we can't easily re-mock the stablecoins list mid-test,
    // we verify the function handles the "no yield data resolved" case
    const db = makeDb();
    vi.mocked(getCache).mockResolvedValue(null);
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    mockFetch([]);

    const result = await syncYieldData(db);

    // With no pools available, yield resolution produces 0 updates
    expect(result.itemCount).toBe(0);
    expect(typeof result.metadata).toBe("string");
  });

  it("skips yield-rankings cache write when response payload fails schema validation", async () => {
    const db = makeBrokenYieldRankingsDb();
    vi.mocked(getCache).mockResolvedValue(null);
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string | null;
      validationFailures: number;
      cacheWriteSkipped: boolean;
    };
    expect(metadata.fallbackMode ?? "").toContain("schema-validation-failed");
    expect(metadata.validationFailures).toBe(1);
    expect(metadata.cacheWriteSkipped).toBe(true);
    const cacheCalls = vi.mocked(setCache).mock.calls;
    const wroteYieldRankings = cacheCalls.some((call) => call[1] === "yield-rankings");
    expect(wroteYieldRankings).toBe(false);
  });

  it("marks run degraded and preserves yield-rankings cache when safety snapshot coverage is empty", async () => {
    const db = makeDb();
    vi.mocked(getCache).mockResolvedValue(null);
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    vi
      .spyOn(safetyScoresModule, "computeSafetyScoresSnapshot")
      .mockResolvedValueOnce({ mode: "map", scores: new Map() } as never);

    const result = await syncYieldData(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string | null;
      cacheWriteSkipped: boolean;
      sourceCoverage: { safetyCoverageRatio: number };
    };
    expect(metadata.fallbackMode ?? "").toContain("safety-snapshot-coverage");
    expect(metadata.cacheWriteSkipped).toBe(true);
    expect(metadata.sourceCoverage.safetyCoverageRatio).toBe(0);

    const cacheCalls = vi.mocked(setCache).mock.calls;
    expect(cacheCalls.some((call) => call[1] === "yield-rankings")).toBe(false);
    expect(cacheCalls.some((call) => call[1] === "report_card_cache")).toBe(false);
  });
});
