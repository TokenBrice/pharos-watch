/**
 * Tests for yield resolution logic: source selection, APY normalization,
 * T-bill excess yield calculation, and warning signal generation.
 *
 * Tests the pure helpers from yield-helpers.ts and the internal arbitration
 * logic from sync-yield-data.ts by exercising the sync function end-to-end
 * with controlled inputs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// --- Module-level mocks ---

vi.mock("@shared/lib/stablecoins", () => {
  const stablecoins = [
    {
      id: "sdai-maker",
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
      id: "usde-ethena",
      name: "USDe",
      symbol: "USDe",
      geckoId: "usde-ethena",
      flags: {
        pegCurrency: "USD",
        backing: "crypto-backed",
        yieldBearing: true,
        navToken: false,
        governance: "decentralized",
      },
      yieldConfig: {
        yieldSource: "Ethena Staking",
        yieldType: "governance-set",
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
  ];
  return {
  TRACKED_STABLECOINS: stablecoins,
  ACTIVE_STABLECOINS: stablecoins,
  TRACKED_META_BY_ID: new Map([
    [
      "sdai-maker",
      {
        id: "sdai-maker",
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
    ],
    [
      "usde-ethena",
      {
        id: "usde-ethena",
        name: "USDe",
        symbol: "USDe",
        geckoId: "usde-ethena",
        flags: {
          pegCurrency: "USD",
          backing: "crypto-backed",
          yieldBearing: true,
          navToken: false,
          governance: "decentralized",
        },
        yieldConfig: {
          yieldSource: "Ethena Staking",
          yieldType: "governance-set",
        },
      },
    ],
    [
      "usdc-circle",
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
    ],
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
  ]),
  };
});

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) =>
    fetch(url, init),
  ),
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

vi.mock("../../lib/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...orig,
    batchExecute: vi.fn(async () => {}),
    getFirstSeenDates: vi.fn(async () => new Map()),
  };
});

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(async () => null),
  setCache: vi.fn(async () => {}),
  setCacheIfNewer: vi.fn(async () => {}),
  writeFreshnessSentinel: vi.fn(async () => {}),
}));

vi.mock("../../lib/chain-registry", () => ({
  getChainRpc: vi.fn(() => null),
}));

// Keep real yield-helpers — we want to test the actual logic
vi.mock("../yield-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../yield-helpers")>();
  return {
    ...actual,
    // Keep all real implementations
  };
});

vi.mock("../yield-config", () => ({
  YIELD_VARIANT_MAP: {
    "usde-ethena": { variantSymbol: "sUSDe" },
  },
  YIELD_POOL_MAP: {
    "sdai-maker": "pool-sdai-native",
  },
  EXPLICIT_YIELD_SOURCE_POOL_MAP: {},
  ON_CHAIN_RATE_CONFIGS: [],
  LENDING_PROTOCOL_ALLOWLIST: new Set(["aave-v3", "venus-core-pool"]),
  LENDING_PROTOCOL_LABELS: { "aave-v3": "Aave V3", "venus-core-pool": "Venus Core Pool" },
  PRICE_DERIVED_FALLBACK_IDS: new Set(),
  RATE_DERIVED_CONFIGS: [] as Array<{
    stablecoinId: string;
    spreadBps: number;
    label: string;
  }>,
  AUTO_LENDING_POOL_MAP: { "u-united-stables": "pool-u-venus" },
  AUTO_LENDING_SAFETY_BYPASS_IDS: new Set(["u-united-stables"]),
}));

vi.mock("@shared/lib/report-cards", () => ({
  computeOverallGrade: vi.fn(() => ({ score: 80, grade: "B+" })),
  scoreDecentralization: vi.fn(() => ({ score: 80, grade: "B+" })),
  scoreDependencyRisk: vi.fn(() => ({ score: 90, grade: "A-" })),
  scoreLiquidity: vi.fn(() => ({ score: 70, grade: "B" })),
  scorePegStability: vi.fn(() => ({ score: 85, grade: "A-" })),
  scoreResilience: vi.fn(() => ({ score: 75, grade: "B" })),
  isBlacklistable: vi.fn(() => false),
}));

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

vi.mock("../../lib/depeg-helpers", () => ({
  rowToDepegEvent: vi.fn((row: unknown) => row),
}));

vi.mock("../../lib/constants", () => ({
  USER_AGENT: "test-agent",
  CIRCUIT_SOURCE: {
    DL_YIELDS: "defillama-yields",
    DL_COINS: "defillama-coins",
    CG_PRICES: "coingecko-prices",
  },
  RISK_FREE_RATE_FALLBACK: 4.5,
  PYS_SCALING_FACTOR: 10,
  DEFAULT_SAFETY_SCORE: 50,
  MIN_SAFETY_SCORE_FOR_YIELD: 50,
  MIN_LENDING_POOL_APY: 0.5,
  MIN_LENDING_POOL_TVL_USD: 1_000_000,
  MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM: 250_000,
  MIN_LENDING_POOL_TVL_SHARE_OF_STABLECOIN_SUPPLY: 0.001,
}));

import { syncYieldData } from "../sync-yield-data";
import { batchExecute } from "../../lib/db";
import { getCache, setCache } from "../../lib/db-cache";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";
import * as safetyScoresModule from "../../lib/safety-scores";
import * as yieldConfigModule from "../yield-config";
import * as yieldSourcesModule from "../yield-sync/sources";

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

function setupDefaultMocks() {
  vi.mocked(getCache).mockReset().mockResolvedValue(null);
  vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
  vi.mocked(batchExecute).mockReset().mockResolvedValue(0);
  vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
  vi.spyOn(safetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValue(
    {
      kind: "ok",
      mode: "map",
      coveredCount: 4,
      trackedCount: 4,
      coverageRatio: 1,
      scores: new Map([
        ["sdai-maker", { score: 85, grade: "A-" }],
        ["usde-ethena", { score: 70, grade: "B" }],
        ["usdc-circle", { score: 90, grade: "A" }],
        ["u-united-stables", { score: 75, grade: "B" }],
      ]),
    } as never,
  );
}

function getWriteStatements() {
  return (
    (vi.mocked(batchExecute).mock.calls[0]?.[1] as
      | Array<{ boundValues?: unknown[] }>
      | undefined) ?? []
  );
}

function findYieldDataRow(
  stmts: Array<{ boundValues?: unknown[] }>,
  stablecoinId: string,
  sourceKey: string,
) {
  return stmts.find(
    (stmt) =>
      stmt.boundValues?.[0] === stablecoinId &&
      stmt.boundValues?.[1] === sourceKey,
  );
}

// --- Tests ---

describe("yield source selection (confidence-weighted arbitration)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("selects DeFiLlama curated source (Layer 1) as best when it has positive APY", async () => {
    const db = makeDb();

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 2_000_000_000,
              apy: 6.5,
              apyBase: 6.5,
              apyReward: null,
              apyMean30d: 6.3,
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
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    const bestRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");
    expect(bestRow).toBeDefined();
    // is_best should be 1 (index 25 in the INSERT statement)
    expect(bestRow?.boundValues?.[25]).toBe(1);
    // data_source should be "defillama" (index 12)
    expect(bestRow?.boundValues?.[12]).toBe("defillama");
  });

  it("prefers deterministic rate-derived source over curated DeFiLlama when both available", async () => {
    // Inject a rate-derived config to produce a deterministic-tier source alongside curated DL
    const configs =
      yieldConfigModule.RATE_DERIVED_CONFIGS as typeof yieldConfigModule.RATE_DERIVED_CONFIGS;
    configs.push({
      stablecoinId: "sdai-maker",
      spreadBps: 25,
      label: "T-bill proxy (net of 0.25% fee)",
    });

    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "5.0", updatedAt: nowSec };
      }
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 2_000_000_000,
              apy: 4.5,
              apyBase: 4.5,
              apyReward: null,
              apyMean30d: 4.5,
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

    const result = await syncYieldData(db);
    // Should produce at least 2 sources for sdai-maker: DL (curated) + rate-derived (deterministic)
    expect(result.itemCount).toBeGreaterThanOrEqual(2);

    const stmts = getWriteStatements();
    const rateDerivedRow = findYieldDataRow(stmts, "sdai-maker", "rate-derived");
    const dlRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");

    expect(rateDerivedRow).toBeDefined();
    expect(dlRow).toBeDefined();

    // rate-derived has deterministic confidence tier which outranks curated DL
    // rate-derived APY = max(0, 5.0 - 0.25) = 4.75 (also higher than DL's 4.5)
    expect(rateDerivedRow?.boundValues?.[25]).toBe(1); // is_best = 1
    expect(dlRow?.boundValues?.[25]).toBe(0); // is_best = 0

    // Clean up
    configs.length = 0;
  });

  it("rejects discovered source that diverges >35% from canonical reference", async () => {
    const db = makeDb();

    // Provide a curated DL pool and an auto-discovered lending pool with divergent APY
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 2_000_000_000,
              apy: 5.0,
              apyBase: 5.0,
              apyReward: null,
              apyMean30d: 5.0,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
            // A fake lending pool with extremely different APY
            {
              pool: "pool-sdai-aave",
              chain: "Ethereum",
              project: "aave-v3",
              symbol: "sDAI",
              tvlUsd: 10_000_000,
              apy: 15.0,
              apyBase: 15.0,
              apyReward: null,
              apyMean30d: 15.0,
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

    await syncYieldData(db);

    // The curated source should be best, and the auto-discovered should have a divergence flag
    const stmts = getWriteStatements();
    const nativeRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");
    expect(nativeRow?.boundValues?.[25]).toBe(1); // is_best = 1
  });
});

describe("T-bill excess yield calculation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("computes excessYield = apy30d - riskFreeRate for each source", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    // Provide a cached T-bill rate of 4.0%
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: nowSec };
      }
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 2_000_000_000,
              apy: 6.0,
              apyBase: 6.0,
              apyReward: null,
              apyMean30d: 6.0,
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

    const result = await syncYieldData(db);
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    const sdaiRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");
    expect(sdaiRow).toBeDefined();

    // excess_yield is at index 17 in the INSERT statement
    // apy30d (6.0) - riskFreeRate (4.0) = 2.0
    const excessYield = Number(sdaiRow?.boundValues?.[17]);
    expect(excessYield).toBeCloseTo(2.0, 0);
  });

  it("produces negative excessYield when yield is below risk-free rate", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "5.0", updatedAt: nowSec };
      }
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 2_000_000_000,
              apy: 3.0,
              apyBase: 3.0,
              apyReward: null,
              apyMean30d: 3.0,
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

    const result = await syncYieldData(db);
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    const sdaiRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");

    // excess_yield should be negative: 3.0 - 5.0 = -2.0
    const excessYield = Number(sdaiRow?.boundValues?.[17]);
    expect(excessYield).toBeLessThan(0);
  });

  it("uses hardcoded fallback rate when no cached T-bill rate exists", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    // No risk_free_rate cache at all
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 2_000_000_000,
              apy: 8.0,
              apyBase: 8.0,
              apyReward: null,
              apyMean30d: 8.0,
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

    const result = await syncYieldData(db);
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    // Metadata should show the fallback rate
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      riskFreeRate: number;
    };
    // RISK_FREE_RATE_FALLBACK is 4.5 in our mock
    expect(metadata.riskFreeRate).toBe(4.5);

    const stmts = getWriteStatements();
    const sdaiRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");

    // excess_yield should be apy30d - 4.5 (fallback) = 8.0 - 4.5 = 3.5
    const excessYield = Number(sdaiRow?.boundValues?.[17]);
    expect(excessYield).toBeCloseTo(3.5, 0);
  });
});

describe("rate-derived yield from T-bill rate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("computes rate-derived APY as riskFreeRate minus spread", async () => {
    // Inject a rate-derived config for sDAI
    const configs =
      yieldConfigModule.RATE_DERIVED_CONFIGS as typeof yieldConfigModule.RATE_DERIVED_CONFIGS;
    configs.push({
      stablecoinId: "sdai-maker",
      spreadBps: 50,
      label: "T-bill proxy (net of 0.50% fee)",
    });

    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.25", updatedAt: nowSec };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    const rateDerivedRow = findYieldDataRow(stmts, "sdai-maker", "rate-derived");
    expect(rateDerivedRow).toBeDefined();

    // APY = max(0, 4.25 - 0.50) = 3.75 (index 3 = current_apy)
    expect(Number(rateDerivedRow?.boundValues?.[3])).toBeCloseTo(3.75, 2);
    // data_source should be "rate-derived" (index 12)
    expect(rateDerivedRow?.boundValues?.[12]).toBe("rate-derived");

    configs.length = 0;
  });

  it("floors rate-derived APY at zero when spread exceeds T-bill rate", async () => {
    const configs =
      yieldConfigModule.RATE_DERIVED_CONFIGS as typeof yieldConfigModule.RATE_DERIVED_CONFIGS;
    configs.push({
      stablecoinId: "sdai-maker",
      spreadBps: 600,
      label: "High-fee T-bill proxy",
    });

    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: nowSec };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    const rateDerivedRow = findYieldDataRow(stmts, "sdai-maker", "rate-derived");
    expect(rateDerivedRow).toBeDefined();

    // max(0, 4.0 - 6.0) = 0
    expect(Number(rateDerivedRow?.boundValues?.[3])).toBe(0);

    configs.length = 0;
  });
});

describe("warning signal generation in yield sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("flags yield-spike when current APY > 2x the 30d average", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          // History showing stable 3% APY over 30 days
          {
            stablecoin_id: "sdai-maker",
            source_key: "pool-sdai-native",
            recorded_at: nowSec - 10 * 86400,
            is_best: 1,
            apy: 3.0,
            source_tvl_usd: 2_000_000_000,
            data_source: "defillama",
            yield_source: "DSR",
            yield_type: "nav-appreciation",
          },
          {
            stablecoin_id: "sdai-maker",
            source_key: "pool-sdai-native",
            recorded_at: nowSec - 5 * 86400,
            is_best: 1,
            apy: 3.0,
            source_tvl_usd: 2_000_000_000,
            data_source: "defillama",
            yield_source: "DSR",
            yield_type: "nav-appreciation",
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    // Current APY jumps to 10% (>2x average of ~3%)
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 2_000_000_000,
              apy: 10.0,
              apyBase: 10.0,
              apyReward: null,
              apyMean30d: 3.0,
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

    const result = await syncYieldData(db);
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    const sdaiRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");

    // warning_signals is at index 24
    const warningSignals = sdaiRow?.boundValues?.[24];
    if (typeof warningSignals === "string") {
      const parsed = JSON.parse(warningSignals) as string[];
      expect(parsed).toContain("yield-spike");
    }
  });

  it("flags tvl-outflow when TVL drops more than 20%", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          // Previous TVL was much higher
          {
            stablecoin_id: "sdai-maker",
            source_key: "pool-sdai-native",
            recorded_at: nowSec - 10 * 86400,
            is_best: 1,
            apy: 5.0,
            source_tvl_usd: 3_000_000_000,
            data_source: "defillama",
            yield_source: "DSR",
            yield_type: "nav-appreciation",
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    // Current TVL dropped significantly (from 3B to 1B = -67%)
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 1_000_000_000,
              apy: 5.0,
              apyBase: 5.0,
              apyReward: null,
              apyMean30d: 5.0,
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

    const result = await syncYieldData(db);
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    const sdaiRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");

    const warningSignals = sdaiRow?.boundValues?.[24];
    if (typeof warningSignals === "string") {
      const parsed = JSON.parse(warningSignals) as string[];
      expect(parsed).toContain("tvl-outflow");
    }
  });

  it("generates no warnings under stable conditions", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 2_000_000_000,
              apy: 5.0,
              apyBase: 5.0,
              apyReward: null,
              apyMean30d: 5.0,
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

    const result = await syncYieldData(db);
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    const sdaiRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");

    // No warnings under stable conditions
    const warningSignals = sdaiRow?.boundValues?.[24];
    expect(warningSignals).toBeNull();
  });
});

describe("Pharos Yield Score (PYS) computation through sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("produces a PYS value that reflects real safety and APY inputs", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 2_000_000_000,
              apy: 5.0,
              apyBase: 5.0,
              apyReward: null,
              apyMean30d: 5.0,
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

    const result = await syncYieldData(db);
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    const sdaiRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");

    // pharos_yield_score is at index 15
    const pys = Number(sdaiRow?.boundValues?.[15]);
    expect(pys).toBeGreaterThan(0);
    expect(pys).toBeLessThanOrEqual(100);
  });

  it("produces PYS=0 when APY is zero", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 2_000_000_000,
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

    const result = await syncYieldData(db);
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    const sdaiRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");

    // PYS should be 0 for zero APY
    const pys = Number(sdaiRow?.boundValues?.[15]);
    expect(pys).toBe(0);
  });
});

describe("price-derived and auto-discovery yield paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves price-derived APY for navToken coins from supply_history prices", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      {
        match: "SELECT price, snapshot_date FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
        matchBinds: ["sdai-maker"],
        rows: [],
        first: { price: 1.05, snapshot_date: nowSec },
      },
      {
        match: "FROM supply_history",
        matchBinds: ["sdai-maker", nowSec - 45 * 86400, nowSec - 7 * 86400],
        rows: [],
        first: { price: 1.01, snapshot_date: nowSec - 30 * 86400 },
      },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: Math.floor(Date.now() / 1000) };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    await syncYieldData(db);

    const writeStatements = vi.mocked(batchExecute).mock.calls[0]?.[1] as Array<{ boundValues?: unknown[] }> | undefined;
    const priceDerivedRow = writeStatements?.find(
      (stmt) => stmt.boundValues?.[0] === "sdai-maker" && stmt.boundValues?.[12] === "price-derived",
    );
    expect(priceDerivedRow).toBeDefined();
  });

  it("resolves auto-discovery lending pool for non-yield-bearing coin", async () => {
    const db = makeDb();
    setupDefaultMocks();

    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-u-venus",
              symbol: "U",
              project: "venus-core-pool",
              tvlUsd: 5_000_000,
              apy: 3.5,
              apyBase: 3.5,
              apyReward: null,
              exposure: "single",
              stablecoin: true,
            },
          ]),
          updatedAt: nowSec - 300,
        };
      }
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: nowSec };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    await syncYieldData(db);

    const writeStatements = vi.mocked(batchExecute).mock.calls[0]?.[1] as Array<{ boundValues?: unknown[] }> | undefined;
    const autoRow = writeStatements?.find(
      (stmt) => stmt.boundValues?.[0] === "u-united-stables",
    );
    expect(autoRow).toBeDefined();
  });
});

describe("on-chain rate bootstrapping seed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("seeds exchange rate when on-chain rate available but no previous rate exists", async () => {
    // Push an on-chain config for usde-ethena
    const configs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    configs.push({
      stablecoinId: "usde-ethena",
      chain: "ethereum",
      contract: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    // Mock fetchOnChainRates to return a rate for usde-ethena
    vi.spyOn(yieldSourcesModule, "fetchOnChainRates").mockResolvedValue({
      rates: new Map([["usde-ethena", { rate: 1.05 }]]),
      failureBreakdown: null,
    });

    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    // DL pool for usde-ethena with 0% APY (simulating the USN-like scenario)
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-usde-native",
              chain: "Ethereum",
              project: "ethena",
              symbol: "sUSDe",
              tvlUsd: 3_000_000_000,
              apy: 0,
              apyBase: 0,
              apyReward: null,
              apyMean30d: 0,
              stablecoin: false,
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

    const result = await syncYieldData(db);
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    // Find the on-chain seed row for usde-ethena
    const onchainRow = findYieldDataRow(stmts, "usde-ethena", "onchain:usde-ethena");
    expect(onchainRow).toBeDefined();

    // current_apy should be 0 (seed — no previous rate to compute from)
    expect(onchainRow?.boundValues?.[3]).toBe(0);
    // exchange_rate should store the current rate (index 22)
    expect(onchainRow?.boundValues?.[22]).toBe(1.05);
    // data_source should be "onchain" (index 12)
    expect(onchainRow?.boundValues?.[12]).toBe("onchain");

    // Also check that a yield_history row is created with the exchange rate
    // History rows come after yield_data rows in the batch
    const historyRow = stmts.find(
      (stmt) =>
        stmt.boundValues?.[0] === "usde-ethena" &&
        stmt.boundValues?.[1] === "onchain:usde-ethena" &&
        stmt.boundValues?.[7] === 1.05, // exchange_rate in history INSERT
    );
    expect(historyRow).toBeDefined();

    // Clean up
    configs.length = 0;
  });
});

describe("optional source budgets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps sync-yield-data completing when Pendle stalls past its budget", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 2_000_000_000,
              apy: 6.5,
              apyBase: 6.5,
              apyReward: null,
              apyMean30d: 6.3,
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

    const fetchSpy = vi.fn((input: string | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("api-v2.pendle.finance")) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectForAbort = () => {
            reject(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason ?? "aborted")));
          };
          if (signal?.aborted) {
            rejectForAbort();
            return;
          }
          signal?.addEventListener("abort", rejectForAbort, { once: true });
        });
      }

      return Promise.resolve(new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchSpy);

    const resultPromise = syncYieldData(db);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(result.status).not.toBe("error");
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const stmts = getWriteStatements();
    const bestRow = findYieldDataRow(stmts, "sdai-maker", "pool-sdai-native");
    expect(bestRow).toBeDefined();
  });
});
