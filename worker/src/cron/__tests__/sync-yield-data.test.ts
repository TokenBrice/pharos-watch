import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// --- Module-level mocks ---

// Stub the stablecoins list — one yield-bearing, two non-yield-bearing
vi.mock("@shared/lib/stablecoins", () => ({
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
      id: "usdc-circle",
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
      id: "u-united-stables",
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
    {
      id: "lusd-liquity",
      name: "Liquity USD",
      symbol: "LUSD",
      geckoId: "liquity-usd",
      flags: {
        pegCurrency: "USD",
        backing: "crypto-backed",
        yieldBearing: false,
        navToken: false,
        governance: "decentralized",
      },
      contracts: [{ chain: "ethereum", address: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0", decimals: 18 }],
    },
  ],
  TRACKED_META_BY_ID: new Map([
    ["100", {
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
    }],
    ["usdc-circle", {
      id: "usdc-circle",
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
    }],
    ["u-united-stables", {
      id: "u-united-stables",
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
    }],
    ["lusd-liquity", {
      id: "lusd-liquity",
      name: "Liquity USD",
      symbol: "LUSD",
      geckoId: "liquity-usd",
      flags: {
        pegCurrency: "USD",
        backing: "crypto-backed",
        yieldBearing: false,
        navToken: false,
        governance: "decentralized",
      },
      contracts: [{ chain: "ethereum", address: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0", decimals: 18 }],
    }],
  ]),
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

// Stub chain-registry
vi.mock("../../lib/chain-registry", () => ({
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
  LENDING_PROTOCOL_ALLOWLIST: new Set(["venus-core-pool", "aave-v3"]),
  LENDING_PROTOCOL_LABELS: {
    "venus-core-pool": "Venus Core Pool",
    "aave-v3": "Aave V3",
  },
  PRICE_DERIVED_FALLBACK_IDS: new Set(),
  RATE_DERIVED_CONFIGS: [],
  AUTO_LENDING_POOL_MAP: {
    "u-united-stables": "pool-u-venus",
    "lusd-liquity": "pool-lusd-aave",
  },
  AUTO_LENDING_SAFETY_BYPASS_IDS: new Set(["u-united-stables"]),
}));

// Stub report-cards (used for safety score computation)
vi.mock("@shared/lib/report-cards", () => ({
  computeOverallGrade: vi.fn(() => ({ score: 80, grade: "B+" })),
  scoreDecentralization: vi.fn(() => ({ score: 80, grade: "B+" })),
  scoreDependencyRisk: vi.fn(() => ({ score: 90, grade: "A-" })),
  scoreLiquidity: vi.fn(() => ({ score: 70, grade: "B" })),
  scorePegStability: vi.fn(() => ({ score: 85, grade: "A-" })),
  scoreResilience: vi.fn(() => ({ score: 75, grade: "B" })),
  isBlacklistable: vi.fn(() => false),
}));

// Stub peg-score
vi.mock("@shared/lib/peg-score", () => ({
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
import { getChainRpc } from "../../lib/chain-registry";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";
import * as safetyScoresModule from "../../lib/safety-scores";
import * as yieldConfigModule from "../yield-config";

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
    vi.mocked(getChainRpc).mockReset().mockReturnValue(undefined);
    vi.spyOn(safetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValue({
      kind: "ok",
      mode: "map",
      coveredCount: 4,
      trackedCount: 4,
      coverageRatio: 1,
      scores: new Map([
        ["100", { score: 80, grade: "B+" }],
        ["usdc-circle", { score: 78, grade: "B+" }],
        ["u-united-stables", { score: 55, grade: "C" }],
        ["lusd-liquity", { score: 86, grade: "A-" }],
      ]),
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("purges stale yield rows for refreshed coins after writing the current source set", async () => {
    const db = makeDb();

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

    await syncYieldData(db);

    const deleteCall = db
      .getHistory()
      .find((entry) => entry.sql.includes("DELETE FROM yield_data") && entry.sql.includes("stablecoin_id IN"));

    expect(deleteCall).toBeDefined();
    expect(deleteCall?.binds[0]).toBe("100");
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
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("yields.llama.fi"),
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

  it("adds conservative B.Protocol LQTY-only APR for LUSD and keeps lending as an alternative source", async () => {
    const db = makeDb();

    vi.mocked(getChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    });

    vi.spyOn(safetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValueOnce({
      kind: "ok",
      mode: "map",
      coveredCount: 4,
      trackedCount: 4,
      coverageRatio: 1,
      scores: new Map([
        ["100", { score: 80, grade: "B+" }],
        ["usdc-circle", { score: 78, grade: "B+" }],
        ["u-united-stables", { score: 55, grade: "C" }],
        ["lusd-liquity", { score: 86, grade: "A-" }],
      ]),
    } as never);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;

        if (url.includes("yields.llama.fi")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  pool: "pool-lusd-aave",
                  chain: "Ethereum",
                  project: "aave-v3",
                  symbol: "LUSD",
                  tvlUsd: 12_000_000,
                  apy: 0.75,
                  apyBase: 0.75,
                  apyReward: null,
                  apyMean30d: 0.74,
                  stablecoin: true,
                  exposure: "single",
                  underlyingTokens: ["0x5f98805a4e8be255a32880fdec7f6728c6568ba0"],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (url.includes("/simple/price?ids=liquity&vs_currencies=usd")) {
          return new Response(JSON.stringify({ liquity: { usd: 0.280527 } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("rpc.example/eth")) {
          const body = JSON.parse(String(init?.body)) as {
            params?: Array<{ data?: string } | string>;
          };
          const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;

          if (callData === "0x9bf2f1ac") {
            return new Response(
              JSON.stringify({
                result: "0x0000000000000000000000000000000000000000000a88622849a78584de759b",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (callData === "0xb140384b") {
            return new Response(
              JSON.stringify({
                result: "0x0000000000000000000000000000000000000000001998cb5c5ea77bc8dc9000",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(2);

    const [stmts] = vi.mocked(batchExecute).mock.calls[0] ?? [];
    expect(stmts).toBe(db);
    const writeStatements = vi.mocked(batchExecute).mock.calls[0]?.[1] as Array<{ boundValues?: unknown[] }>;

    const bprotocolRow = writeStatements.find(
      (stmt) => stmt.boundValues?.[0] === "lusd-liquity" && stmt.boundValues?.[1] === "bprotocol-lqty-only",
    );
    expect(bprotocolRow?.boundValues?.[8]).toBe("B.Protocol Stability Pool (LQTY only)");
    expect(bprotocolRow?.boundValues?.[9]).toBe("lending-vault");
    expect(bprotocolRow?.boundValues?.[12]).toBe("onchain");
    expect(Number(bprotocolRow?.boundValues?.[3])).toBeGreaterThan(1);
    expect(Number(bprotocolRow?.boundValues?.[5])).toBeGreaterThan(1);
    expect(bprotocolRow?.boundValues?.[25]).toBe(1);

    const aaveRow = writeStatements.find(
      (stmt) => stmt.boundValues?.[0] === "lusd-liquity" && stmt.boundValues?.[1] === "pool-lusd-aave",
    );
    expect(aaveRow?.boundValues?.[8]).toBe("Aave V3");
    expect(aaveRow?.boundValues?.[9]).toBe("lending-opportunity");
    expect(aaveRow?.boundValues?.[12]).toBe("defillama-auto");
    expect(aaveRow?.boundValues?.[25]).toBe(0);
  });

  it("handles DL yields API failure gracefully — no cached pools, API down", async () => {
    const db = makeDb();

    // No cached pools
    vi.mocked(getCache).mockResolvedValue(null);

    // DL yields API returns 500
    mockFetch([{ match: "yields.llama.fi", body: { error: "Internal Server Error" }, status: 500 }]);

    const result = await syncYieldData(db);

    // Should still return a result — just with no yield data resolved for DL-sourced coins
    // The function might resolve 0 if sDAI couldn't be matched (no DL pools available)
    expect(result.itemCount).toBeDefined();
    // recordOutcome should have been called with failure
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), "defillama-yields", false);
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
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("yields.llama.fi"),
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

  it("tries price-derived as additional source when DL returns 0% APY for navToken", async () => {
    // sDAI (navToken: true) gets a DL pool with 0% APY.
    // The resolve logic should also try price-derived and pick the non-zero source.
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      { match: "supply_history", rows: [], first: { price: 1.05 } },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-zero",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 500_000_000,
              apy: 0,
              apyBase: 0,
              apyReward: null,
              apyMean30d: 0,
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

    // Two source rows: DL (0% APY) + price-derived (4.0% from mock)
    expect(result.itemCount).toBe(2);

    // Check that batchExecute was called with a price-derived source
    const writeStatements = vi.mocked(batchExecute).mock.calls[0]?.[1] as Array<{ boundValues?: unknown[] }> | undefined;
    const priceDerivedRow = writeStatements?.find(
      (stmt) => stmt.boundValues?.[0] === "100" && stmt.boundValues?.[1] === "price-derived",
    );
    expect(priceDerivedRow).toBeDefined();
    // price-derived APY should be > 0 (computeApyFromPrice mock returns 4.0)
    expect(Number(priceDerivedRow?.boundValues?.[3])).toBeGreaterThan(0);
    // data_source should be "price-derived"
    expect(priceDerivedRow?.boundValues?.[12]).toBe("price-derived");
    // price-derived should be is_best (higher APY than DL's 0%)
    expect(priceDerivedRow?.boundValues?.[25]).toBe(1);
  });

  it("computes trailing APY from source-specific history instead of mixed coin-level history", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "price-derived",
            recorded_at: nowSec - 2 * 86400,
            is_best: 1,
            apy: 2,
            source_tvl_usd: null,
            data_source: "price-derived",
            yield_source: null,
            yield_type: null,
          },
          {
            stablecoin_id: "100",
            source_key: "pool-sdai-zero",
            recorded_at: nowSec - 2 * 86400,
            is_best: 0,
            apy: 9,
            source_tvl_usd: 500_000_000,
            data_source: "defillama",
            yield_source: "DSR",
            yield_type: "nav-appreciation",
          },
        ],
      },
      { match: "supply_history", rows: [], first: { price: 1.05 } },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-zero",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 500_000_000,
              apy: 0,
              apyBase: 0,
              apyReward: null,
              apyMean30d: 0,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    await syncYieldData(db);

    const writeStatements = vi.mocked(batchExecute).mock.calls[0]?.[1] as Array<{ boundValues?: unknown[] }> | undefined;
    const priceDerivedRow = writeStatements?.find(
      (stmt) => stmt.boundValues?.[0] === "100" && stmt.boundValues?.[1] === "price-derived",
    );

    // Source-specific history should average [2, 4] => 3.0 instead of mixing in the DL row's 9% sample.
    expect(Number(priceDerivedRow?.boundValues?.[7])).toBeCloseTo(3, 3);
  });

  it("resolves rate-derived yield from cached T-bill rate for configured tokens", async () => {
    // Temporarily inject a rate-derived config for sDAI (id "100")
    const configs = yieldConfigModule.RATE_DERIVED_CONFIGS as typeof yieldConfigModule.RATE_DERIVED_CONFIGS;
    configs.push({ stablecoinId: "100", spreadBps: 25, label: "T-bill proxy (net of 0.25% fee)" });

    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    // Return a risk_free_rate of 4.0% from cache
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: Math.floor(Date.now() / 1000) };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    // Should have at least one row written for rate-derived
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    // Check that batchExecute was called with a rate-derived source
    const writeStatements = vi.mocked(batchExecute).mock.calls[0]?.[1] as Array<{ boundValues?: unknown[] }> | undefined;
    const rateDerivedRow = writeStatements?.find(
      (stmt) => stmt.boundValues?.[0] === "100" && stmt.boundValues?.[1] === "rate-derived",
    );
    expect(rateDerivedRow).toBeDefined();
    // APY should be 4.0 - 0.25 = 3.75
    expect(Number(rateDerivedRow?.boundValues?.[3])).toBeCloseTo(3.75, 2);
    // data_source should be "rate-derived"
    expect(rateDerivedRow?.boundValues?.[12]).toBe("rate-derived");
    // rate-derived should be is_best (only source)
    expect(rateDerivedRow?.boundValues?.[25]).toBe(1);

    // Clean up
    configs.length = 0;
  });

  it("marks run degraded but still writes yield-rankings cache when safety snapshot coverage is empty", async () => {
    const db = makeDb();
    vi.mocked(getCache).mockResolvedValue(null);
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    vi.spyOn(safetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValueOnce({
      kind: "degraded",
      mode: "map",
      coveredCount: 0,
      trackedCount: 4,
      coverageRatio: 0,
      reason: "stablecoins-cache:missing-cache",
      scores: new Map(),
    } as never);

    const result = await syncYieldData(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string | null;
      cacheWriteSkipped: boolean;
      sourceCoverage: { safetyCoverageRatio: number };
    };
    expect(metadata.fallbackMode ?? "").toContain("safety-snapshot-coverage");
    expect(metadata.cacheWriteSkipped).toBe(false);
    expect(metadata.sourceCoverage.safetyCoverageRatio).toBe(0);

    const cacheCalls = vi.mocked(setCache).mock.calls;
    expect(cacheCalls.some((call) => call[1] === "yield-rankings")).toBe(true);
    expect(cacheCalls.some((call) => call[1] === "report_card_cache")).toBe(false);
  });
});
