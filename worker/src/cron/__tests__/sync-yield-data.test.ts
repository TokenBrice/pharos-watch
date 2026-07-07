import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  mockCircuitBreaker,
  mockCircuitOutcomeRecord,
  mockDbCache,
  mockFetchRetry,
  mockRegistry,
} from "../../test-helpers/cron";

// --- Module-level mocks ---

// Stub the stablecoins list — one yield-bearing, two non-yield-bearing
vi.mock("@shared/lib/stablecoins/registry", () =>
  mockRegistry({
    stablecoins: [
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
  }),
);

// Stub fetch-retry to delegate to global fetch
vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

// Stub circuit-breaker
vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker());

// Stub db helpers
vi.mock("../../lib/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...orig,
    batchExecute: vi.fn(async () => {}),
    getFirstSeenDates: vi.fn(async () => new Map()),
  };
});

vi.mock("../../lib/db-cache", () => mockDbCache());

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
    computeApyVarianceScore: vi.fn(() => 0.1),
    detectWarningSignals: vi.fn(() => []),
    findBestLendingPool: vi.fn(() => null),
  };
});

// Stub yield-config
vi.mock("../yield-config", () => ({
  YIELD_VARIANT_MAP: {},
  YIELD_POOL_MAP: {},
  YIELD_WEIGHTED_POOL_GROUPS: {},
  EXPLICIT_YIELD_SOURCE_POOL_MAP: {},
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
  isAutoLendingCollisionBlockedForStablecoin: () => false,
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
  MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM: 250_000,
  MIN_LENDING_POOL_TVL_SHARE_OF_STABLECOIN_SUPPLY: 0.001,
}));

import { syncYieldData } from "../sync-yield-data";
import { batchExecute } from "../../lib/db";
import { getCache, getCaches, setCache, setCacheIfNewer, writeFreshnessSentinel } from "../../lib/db-cache";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { getChainRpc, type ChainRpcConfig } from "../../lib/chain-registry";
import type { CronProgressUpdate } from "../../lib/cron-logger";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import * as safetyScoresModule from "../../lib/safety-scores";
import * as yieldConfigModule from "../yield-config";
import * as yieldHelpersModule from "../yield-helpers";
import * as publicationModule from "../yield-sync/publication";
import * as evmRpcModule from "../../lib/evm-rpc";
import { YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY } from "../../lib/yield-history-cleanup";

const mutableActiveStablecoins = ACTIVE_STABLECOINS as typeof ACTIVE_STABLECOINS extends readonly (infer T)[] ? T[] : never;
const mutableTrackedMetaById = TRACKED_META_BY_ID as Map<string, (typeof ACTIVE_STABLECOINS)[number]>;

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

function makeStablecoinsCacheValue(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    peggedAssets: [
      {
        id: "usdc-circle",
        name: "USD Coin",
        symbol: "USDC",
        geckoId: "usd-coin",
        pegType: "peggedUSD",
        pegMechanism: "fiat-backed",
        price: 1,
        priceSource: "defillama",
        priceConfidence: "high",
        priceUpdatedAt: nowSec,
        priceObservedAt: nowSec,
        priceObservedAtMode: "upstream",
        priceSyncedAt: nowSec,
        consensusSources: [],
        agreeSources: [],
        circulating: { peggedUSD: 42_000_000 },
        circulatingPrevDay: { peggedUSD: 41_000_000 },
        circulatingPrevWeek: { peggedUSD: 40_000_000 },
        circulatingPrevMonth: { peggedUSD: 39_000_000 },
        chainCirculating: {
          Ethereum: {
            current: 42_000_000,
            circulatingPrevDay: 41_000_000,
            circulatingPrevWeek: 40_000_000,
            circulatingPrevMonth: 39_000_000,
          },
        },
        chains: ["Ethereum"],
      },
    ],
  });
}

function makeCacheWriteFailureDb(error: Error) {
  return mockD1([
    { match: "INSERT INTO cache (key, value, updated_at)", rows: [], throwError: error },
    { match: "cache", rows: [] },
    { match: "yield_data", rows: [] },
    { match: "yield_history", rows: [] },
    { match: "supply_history", rows: [] },
    { match: "depeg_events", rows: [] },
    { match: "dex_liquidity", rows: [] },
  ]);
}

type MockHistoryDb = {
  getHistory: () => Array<{ sql: string; binds: unknown[] }>;
};

type YieldDataTestRow = {
  stablecoin_id: string;
  source_key: string;
  current_apy: number;
  apy_reward: number | null;
  apy_7d: number;
  apy_30d: number;
  yield_source: string;
  yield_type: string;
  data_source: string;
  exchange_rate_prev: number | null;
  is_best: number;
};

function getPublishedYieldRows(db: MockHistoryDb): YieldDataTestRow[] {
  const entry = db.getHistory().find((item) => item.sql.includes("INSERT OR REPLACE INTO yield_data"));
  return entry ? (JSON.parse(String(entry.binds[0] ?? "[]")) as YieldDataTestRow[]) : [];
}

function findPublishedYieldRow(
  db: MockHistoryDb,
  stablecoinId: string,
  predicate: (row: YieldDataTestRow) => boolean,
): YieldDataTestRow | undefined {
  return getPublishedYieldRows(db).find((row) => row.stablecoin_id === stablecoinId && predicate(row));
}

function getYieldRankingsCachePayload(db: MockHistoryDb): unknown {
  const entry = db
    .getHistory()
    .find(
      (item) => item.sql.includes("INSERT INTO cache (key, value, updated_at)") && item.binds[0] === "yield-rankings",
    );
  return entry ? JSON.parse(String(entry.binds[1])) : undefined;
}

function makeYieldOrphanDb(orphanIds: string[]) {
  return mockD1([
    { match: "pharos:yield-sync:yield-data-existing-ids", rows: orphanIds.map((stablecoin_id) => ({ stablecoin_id })) },
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

function mockHealthyRiskFreeRateCache() {
  const nowSec = Math.floor(Date.now() / 1000);
  vi.mocked(getCache).mockImplementation(async (_db, key) => {
    if (key === "risk_free_rate") {
      return {
        value: JSON.stringify({
          rate: 4.0,
          source: "fred",
          fetchedAt: nowSec - 3600,
          recordDate: "2025-06-15",
          isFallback: false,
          fallbackMode: null,
        }),
        updatedAt: nowSec - 3600,
      };
    }
    return null;
  });
}

describe("syncYieldData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    (yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS).length = 0;
    (yieldConfigModule.RATE_DERIVED_CONFIGS as typeof yieldConfigModule.RATE_DERIVED_CONFIGS).length = 0;
    const poolMap = yieldConfigModule.YIELD_POOL_MAP as Record<string, string>;
    for (const key of Object.keys(poolMap)) delete poolMap[key];
    const explicitPoolMap =
      yieldConfigModule.EXPLICIT_YIELD_SOURCE_POOL_MAP as typeof yieldConfigModule.EXPLICIT_YIELD_SOURCE_POOL_MAP;
    for (const key of Object.keys(explicitPoolMap)) delete explicitPoolMap[key];
    // Reset mocks to factory defaults
    vi.mocked(getCache).mockReset().mockResolvedValue(null);
    vi.mocked(getCaches).mockReset().mockImplementation(async (db, keys) => {
      const rowsByKey = new Map<string, { value: string; updatedAt: number }>();
      for (const key of keys) {
        const row = await getCache(db, key);
        if (row) rowsByKey.set(key, row);
      }
      return rowsByKey;
    });
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
    vi.mocked(setCacheIfNewer).mockReset().mockResolvedValue({ written: true, skippedBecauseNewer: false });
    vi.mocked(writeFreshnessSentinel).mockReset().mockResolvedValue(undefined);
    vi.mocked(batchExecute).mockReset().mockResolvedValue(0);
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(mockCircuitOutcomeRecord());
    vi.mocked(getChainRpc).mockReset().mockReturnValue(undefined);
    vi.mocked(yieldHelpersModule.findBestLendingPool).mockReset().mockReturnValue(null);
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
    expect(getPublishedYieldRows(db)).toHaveLength(1);
    expect(getYieldRankingsCachePayload(db)).toBeDefined();
    expect(writeFreshnessSentinel).toHaveBeenCalledWith(db, "yield-data", Math.floor(Date.now() / 1000), undefined);
  });

  it("reuses the stablecoins cache load for supply gates and safety scores", async () => {
    const db = makeDb();
    const updatedAt = Math.floor(Date.now() / 1000);
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "stablecoins") {
        return { value: makeStablecoinsCacheValue(), updatedAt };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    await syncYieldData(db);

    const stablecoinsReads = vi.mocked(getCache).mock.calls.filter((call) => call[1] === "stablecoins");
    const safetyCalls = vi.mocked(safetyScoresModule.computeSafetyScoresSnapshot).mock.calls;
    const safetyCall = safetyCalls[safetyCalls.length - 1];

    expect(stablecoinsReads).toHaveLength(1);
    expect(safetyCall?.[0]).toBe(db);
    expect(safetyCall?.[1]).toMatchObject({
      includeNavTokens: true,
      outputMode: "map",
      preloadedStablecoinsCache: {
        kind: "ok",
        updatedAt,
      },
    });
  });

  it("reports writer-pause progress metadata before returning", async () => {
    const db = makeDb();
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY) {
        return {
          value: JSON.stringify({
            reason: "history-cleanup",
            operator: "ops",
            pausedAt: Math.floor(Date.now() / 1000) - 60,
          }),
          updatedAt: Math.floor(Date.now() / 1000) - 60,
        };
      }
      return null;
    });

    const result = await syncYieldData(db, undefined, undefined, undefined, undefined, reportProgress);
    const writerPaused = progressUpdates.find((update) => update.stage === "writer-paused");

    expect(result.status).toBe("degraded");
    expect(writerPaused).toMatchObject({
      stage: "writer-paused",
      metadata: {
        providerFamily: "yield",
        phase: "writer-paused",
        writerPaused: true,
        countTotals: {
          yieldBearingCoins: expect.any(Number),
          opportunityCoins: expect.any(Number),
          totalTrackedForYield: expect.any(Number),
        },
      },
    });
  });

  it("publishes evaluated warning signals into the yield rankings cache", async () => {
    const db = makeDb();
    vi.mocked(yieldHelpersModule.detectWarningSignals).mockReturnValue(["yield-spike"]);

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
              apy: 9,
              apyBase: 9,
              apyReward: null,
              apyMean30d: 3,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ],
        },
      },
    ]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(1);
    const parsed = getYieldRankingsCachePayload(db) as {
      rankings: Array<{ warningSignals: string[] }>;
    };
    expect(parsed.rankings[0]?.warningSignals).toContain("yield-spike");
  });

  it("continues when published-generation repair fails before history load", async () => {
    const db = makeDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(publicationModule, "repairPublishedYieldGenerationFromCache").mockRejectedValueOnce(
      new Error("repair failed"),
    );

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

    expect(result.itemCount).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[sync-yield-data] Failed to repair published yield generation before history load:",
      expect.any(Error),
    );
  });

  it("returns a degraded no-op result while the cleanup writer pause is armed", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "yield-history-cleanup:writer-pause") {
        return {
          value: JSON.stringify({
            reason: "yield-history-cleanup",
            pausedAt: nowSec - 60,
            operator: "tester",
          }),
          updatedAt: nowSec - 60,
        };
      }
      return null;
    });

    const result = await syncYieldData(db);

    expect(result).toMatchObject({
      status: "degraded",
      itemCount: 0,
    });
    expect(result.metadata).toContain('"writerPaused":true');
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("purges stale yield rows for refreshed coins after writing the current source set", async () => {
    const db = makeDb();
    mockHealthyRiskFreeRateCache();

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
    expect(deleteCall?.binds).toEqual(
      expect.arrayContaining(["100", "usdc-circle", "u-united-stables", "lusd-liquity"]),
    );
    expect(deleteCall?.binds[deleteCall.binds.length - 1]).toBe(Math.floor(Date.now() / 1000));
  });

  it("purges orphan yield rows for coins outside the tracked stablecoin set", async () => {
    const db = makeYieldOrphanDb(["orphan-coin", "legacy-coin"]);
    mockHealthyRiskFreeRateCache();

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

    const orphanScanCall = db
      .getHistory()
      .find((entry) => entry.sql.includes("pharos:yield-sync:yield-data-existing-ids"));

    expect(orphanScanCall).toBeDefined();

    const orphanDeleteCall = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("DELETE FROM yield_data") &&
          entry.sql.includes("stablecoin_id IN") &&
          !entry.sql.includes("updated_at <"),
      );

    expect(orphanDeleteCall).toBeDefined();
    expect(orphanDeleteCall?.binds).toEqual(expect.arrayContaining(["orphan-coin", "legacy-coin"]));
  });

  it("chunks stale-yield cleanup under the D1 bind limit", async () => {
    const db = makeDb();
    const originalLength = ACTIVE_STABLECOINS.length;
    mockHealthyRiskFreeRateCache();

    for (let i = 0; i < 120; i++) {
      mutableActiveStablecoins.push({
        id: `extra-${i}`,
        name: `Extra ${i}`,
        symbol: `E${i}`,
        geckoId: `extra-${i}`,
        flags: {
          pegCurrency: "USD",
          backing: ACTIVE_STABLECOINS[1]!.flags.backing,
          yieldBearing: false,
          rwa: false,
          navToken: false,
          governance: "centralized",
        },
      });
    }

    try {
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
    } finally {
      mutableActiveStablecoins.splice(originalLength);
    }

    const staleDeleteCalls = db
      .getHistory()
      .filter(
        (entry) =>
          entry.sql.includes("DELETE FROM yield_data") &&
          entry.sql.includes("stablecoin_id IN") &&
          entry.sql.includes("updated_at <"),
      );

    expect(staleDeleteCalls.length).toBeGreaterThan(1);
    expect(Math.max(...staleDeleteCalls.map((entry) => entry.binds.length))).toBeLessThanOrEqual(91);
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

  it("uses cached supplemental sources on the hourly publication path", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 6.1,
                  apyBase: 6.1,
                  apyReward: null,
                  sourcePool: "vault-sdai-morpho",
                  sourceTvlUsd: 50_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xvault",
                  yieldSource: "Morpho: sDAI Vault",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(1);
    const supplementalRow = findPublishedYieldRow(
      db,
      "100",
      (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xvault",
    );
    expect(supplementalRow).toBeDefined();
    expect(vi.mocked(getCaches)).toHaveBeenCalledWith(
      db,
      expect.arrayContaining([
        "yield:supplemental-sources:v1:morpho",
        "yield:supplemental-sources:v1:beefy",
      ]),
    );
  });

  it("loads valid supplemental family caches even when another family cache is malformed", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1:morpho") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 6.1,
                  apyBase: 6.1,
                  apyReward: null,
                  sourcePool: "vault-sdai-morpho",
                  sourceTvlUsd: 50_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xvault",
                  yieldSource: "Morpho: sDAI Vault",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      if (key === "yield:supplemental-sources:v1:beefy") {
        return {
          value: "{bad json",
          updatedAt: nowSec,
        };
      }
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: "{bad aggregate",
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(1);
    const supplementalRow = findPublishedYieldRow(
      db,
      "100",
      (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xvault",
    );
    expect(supplementalRow).toBeDefined();
  });

  it("merges aggregate supplemental candidates for missing per-family caches", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1:morpho") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 6.1,
                  apyBase: 6.1,
                  apyReward: null,
                  sourcePool: "vault-sdai-morpho",
                  sourceTvlUsd: 50_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xvault",
                  yieldSource: "Morpho: sDAI Vault",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 2,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 6.1,
                  apyBase: 6.1,
                  apyReward: null,
                  sourcePool: "vault-sdai-morpho",
                  sourceTvlUsd: 50_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xvault",
                  yieldSource: "Morpho: sDAI Vault",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 5.8,
                  apyBase: 5.8,
                  apyReward: null,
                  sourcePool: "beefy-sdai",
                  sourceTvlUsd: 20_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:beefy:ethereum:beefy-sdai",
                  yieldSource: "Beefy: sDAI",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(2);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sourceCoverage?: { supplementalFallbackMode?: string | null };
    };
    expect(metadata.sourceCoverage?.supplementalFallbackMode).toBe("partial-family-cache-aggregate-merge");
    const rows = getPublishedYieldRows(db);
    expect(
      rows.some(
        (row) => row.stablecoin_id === "100" && row.source_key === "protocol-api:morpho-vault:ethereum:0xvault",
      ),
    ).toBe(true);
    expect(
      rows.some((row) => row.stablecoin_id === "100" && row.source_key === "protocol-api:beefy:ethereum:beefy-sdai"),
    ).toBe(true);
  });

  it("keeps a higher native wrapper APY ahead of a lower supplemental lending source that clears size gates", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const poolMap = yieldConfigModule.YIELD_POOL_MAP as typeof yieldConfigModule.YIELD_POOL_MAP;
    poolMap["100"] = "pool-sdai-native";

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 84_819_532,
              apy: 4.45953,
              apyBase: 4.45953,
              apyReward: null,
              apyMean30d: 4.43603,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: nowSec,
        };
      }
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 2.23864,
                  apyBase: 2.23864,
                  apyReward: null,
                  sourcePool: "vault-sdai-prime",
                  sourceTvlUsd: 25_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xsdai",
                  yieldSource: "Morpho: sDAI Prime",
                  yieldType: "lending-opportunity",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    try {
      const result = await syncYieldData(db);

      expect(result.itemCount).toBe(2);
      const nativeRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "pool-sdai-native");
      const supplementalRow = findPublishedYieldRow(
        db,
        "100",
        (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xsdai",
      );

      expect(nativeRow?.yield_source).toBe("DSR");
      expect(nativeRow?.data_source).toBe("defillama");
      expect(nativeRow?.is_best).toBe(1);
      expect(supplementalRow?.yield_source).toBe("Morpho: sDAI Prime");
      expect(supplementalRow?.data_source).toBe("protocol-api");
      expect(supplementalRow?.is_best).toBe(0);
    } finally {
      delete poolMap["100"];
    }
  });

  it("filters blocked USR-linked supplemental lending suggestions", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 2,
            data: [
              {
                symbol: "USDC",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 8.5,
                  apyBase: 8.5,
                  apyReward: null,
                  sourcePool: "vault-resolv-usdc",
                  sourceTvlUsd: 25_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xresolv",
                  yieldSource: "Morpho: Resolv USDC",
                  yieldType: "lending-opportunity",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
              {
                symbol: "USDC",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 3.2,
                  apyBase: 3.2,
                  apyReward: null,
                  sourcePool: "vault-usdc-prime",
                  sourceTvlUsd: 30_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xusdc-prime",
                  yieldSource: "Morpho: USDC Prime",
                  yieldType: "lending-opportunity",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    await syncYieldData(db);

    const blockedRow = findPublishedYieldRow(
      db,
      "usdc-circle",
      (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xresolv",
    );
    const allowedRow = findPublishedYieldRow(
      db,
      "usdc-circle",
      (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xusdc-prime",
    );

    expect(blockedRow).toBeUndefined();
    expect(allowedRow).toBeDefined();
  });

  it("drops supplemental lending suggestions when venue TVL is unavailable", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "USDC",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 3.2,
                  apyBase: 3.2,
                  apyReward: null,
                  sourcePool: null,
                  sourceTvlUsd: null,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "aave-v3-onchain:ethereum:0xusdc",
                  yieldSource: "Aave v3 (ethereum)",
                  yieldType: "lending-opportunity",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    await syncYieldData(db);

    const droppedRow = findPublishedYieldRow(
      db,
      "usdc-circle",
      (row) => row.source_key === "aave-v3-onchain:ethereum:0xusdc",
    );

    expect(droppedRow).toBeUndefined();
  });

  it("drops lending suggestions smaller than 0.1% of tracked stablecoin supply", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "stablecoins") {
        return {
          value: JSON.stringify({
            peggedAssets: [
              {
                id: "usdc-circle",
                symbol: "USDC",
                name: "USD Coin",
                price: 1,
                circulating: { peggedUSD: 20_000_000_000 },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "USDC",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 4.1,
                  apyBase: 4.1,
                  apyReward: null,
                  sourcePool: "vault-usdc-small",
                  sourceTvlUsd: 5_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xusdc-small",
                  yieldSource: "Morpho: USDC Small",
                  yieldType: "lending-opportunity",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    await syncYieldData(db);

    const droppedRow = findPublishedYieldRow(
      db,
      "usdc-circle",
      (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xusdc-small",
    );

    expect(droppedRow).toBeUndefined();
  });

  it("skips deterministic on-chain reads while cooldown is active", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x0000000000000000000000000000000000000001",
      method: "exchangeRate",
      scale: 1e18,
    } as never);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 6.1,
                  apyBase: 6.1,
                  apyReward: null,
                  sourcePool: "vault-sdai-morpho",
                  sourceTvlUsd: 50_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xvault",
                  yieldSource: "Morpho: sDAI Vault",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      if (key === "yield:onchain-health:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            consecutiveAllFailRuns: 2,
            consecutiveMaskedAllFailRuns: 2,
            cooldownUntil: nowSec + 3600,
            lastAttemptedAt: nowSec - 3600,
            lastAllFailedAt: nowSec - 3600,
            lastSuccessAt: null,
            lastSkippedAt: null,
            lastFailureMissingIds: [],
          }),
          updatedAt: nowSec - 60,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    const fetchSpy = mockFetch([]);

    try {
      const result = await syncYieldData(db);
      const metadata = JSON.parse(result.metadata ?? "{}") as {
        sourceCoverage?: {
          onChainSkippedDueToCooldown?: boolean;
          onChainCooldownActive?: boolean;
        };
      };

      expect(result.itemCount).toBe(1);
      expect(metadata.sourceCoverage?.onChainSkippedDueToCooldown).toBe(true);
      expect(metadata.sourceCoverage?.onChainCooldownActive).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      onChainConfigs.length = 0;
    }
  });

  it("marks the run degraded when deterministic cooldown leaves a coverage gap", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x0000000000000000000000000000000000000001",
      method: "exchangeRate",
      scale: 1e18,
    } as never);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-placeholder",
              chain: "Ethereum",
              project: "aave-v3",
              symbol: "USDC",
              tvlUsd: 5_000_000,
              apy: 3.25,
              apyBase: 3.25,
              apyReward: null,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: nowSec - 60,
        };
      }
      if (key === "risk_free_rate") {
        return {
          value: JSON.stringify({
            rate: 4.0,
            source: "fred",
            fetchedAt: nowSec - 3600,
            recordDate: "2025-06-15",
            isFallback: false,
            fallbackMode: null,
          }),
          updatedAt: nowSec - 3600,
        };
      }
      if (key === "yield:onchain-health:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            consecutiveAllFailRuns: 2,
            consecutiveMaskedAllFailRuns: 2,
            cooldownUntil: nowSec + 3600,
            lastAttemptedAt: nowSec - 3600,
            lastAllFailedAt: nowSec - 3600,
            lastSuccessAt: null,
            lastSkippedAt: null,
            lastFailureMissingIds: [],
          }),
          updatedAt: nowSec - 60,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    const fetchSpy = mockFetch([]);

    try {
      const result = await syncYieldData(db);
      const metadata = JSON.parse(result.metadata ?? "{}") as {
        fallbackMode?: string | null;
        sourceCoverage?: {
          onChainSkippedDueToCooldown?: boolean;
          onChainAlternativeCoverageMissingIds?: string[];
        };
      };

      expect(result.status).toBe("degraded");
      expect(metadata.fallbackMode ?? "").toContain("onchain-rates:cooldown-coverage-gap");
      expect(metadata.sourceCoverage?.onChainSkippedDueToCooldown).toBe(true);
      expect(metadata.sourceCoverage?.onChainAlternativeCoverageMissingIds).toEqual(["100"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      onChainConfigs.length = 0;
    }
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

  it("publishes curated exact-pool coverage for XAUT without enabling generic gold auto-discovery", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const xautMeta = {
      id: "xaut-tether",
      name: "Tether Gold",
      symbol: "XAUT",
      geckoId: "tether-gold",
      flags: {
        pegCurrency: "GOLD",
        backing: "rwa-backed",
        yieldBearing: false,
        navToken: false,
        rwa: true,
        governance: "centralized",
      },
      contracts: [{ chain: "ethereum", address: "0x68749665ff8d2d112fa859aa293f07a622782f38", decimals: 6 }],
    };
    const explicitPoolMap =
      yieldConfigModule.EXPLICIT_YIELD_SOURCE_POOL_MAP as typeof yieldConfigModule.EXPLICIT_YIELD_SOURCE_POOL_MAP;

    mutableActiveStablecoins.push(xautMeta as never);
    mutableTrackedMetaById.set("xaut-tether", xautMeta as never);
    explicitPoolMap["xaut-tether"] = [
      {
        poolId: "pool-xaut-yo",
        yieldSource: "Yo Protocol",
        yieldType: "lending-opportunity",
        dataSource: "defillama",
        expectedProject: "yo-protocol",
        expectedSymbol: "XAUT",
        expectedChain: "ethereum",
      },
    ];

    vi.spyOn(safetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValueOnce({
      kind: "ok",
      mode: "map",
      coveredCount: 5,
      trackedCount: 5,
      coverageRatio: 1,
      scores: new Map([
        ["100", { score: 80, grade: "B+" }],
        ["usdc-circle", { score: 78, grade: "B+" }],
        ["u-united-stables", { score: 55, grade: "C" }],
        ["lusd-liquity", { score: 86, grade: "A-" }],
        ["xaut-tether", { score: 82, grade: "B+" }],
      ]),
    } as never);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-xaut-yo",
              chain: "Ethereum",
              project: "yo-protocol",
              symbol: "XAUT",
              tvlUsd: 3_200_000,
              apy: 11.4,
              apyBase: 11.4,
              apyReward: null,
              apyMean30d: 11.1,
              stablecoin: false,
              exposure: "single",
              underlyingTokens: ["0x68749665ff8d2d112fa859aa293f07a622782f38"],
            },
          ]),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    try {
      const result = await syncYieldData(db);
      const xautRow = findPublishedYieldRow(db, "xaut-tether", (row) => row.source_key === "pool-xaut-yo");

      expect(result.itemCount).toBe(1);
      expect(xautRow?.yield_source).toBe("Yo Protocol");
      expect(xautRow?.yield_type).toBe("lending-opportunity");
      expect(xautRow?.data_source).toBe("defillama");
      expect(xautRow?.is_best).toBe(1);
    } finally {
      delete explicitPoolMap["xaut-tether"];
      mutableTrackedMetaById.delete("xaut-tether");
      mutableActiveStablecoins.pop();
    }
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

    let activeRpcCalls = 0;
    let maxActiveRpcCalls = 0;
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
          activeRpcCalls += 1;
          maxActiveRpcCalls = Math.max(maxActiveRpcCalls, activeRpcCalls);
          await Promise.resolve();
          try {
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
          } finally {
            activeRpcCalls -= 1;
          }
        }

        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/eth",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    const result = await syncYieldData(db, undefined, testChainRpcs);

    expect(result.itemCount).toBe(2);
    expect(maxActiveRpcCalls).toBe(1);

    const bprotocolRow = findPublishedYieldRow(db, "lusd-liquity", (row) => row.source_key === "onchain:lusd-liquity");
    expect(bprotocolRow?.yield_source).toBe("B.Protocol Stability Pool (LQTY only)");
    expect(bprotocolRow?.yield_type).toBe("lending-vault");
    expect(bprotocolRow?.data_source).toBe("onchain");
    expect(Number(bprotocolRow?.current_apy)).toBeGreaterThan(1);
    expect(Number(bprotocolRow?.apy_reward)).toBeGreaterThan(1);
    expect(bprotocolRow?.is_best).toBe(1);

    const aaveRow = findPublishedYieldRow(db, "lusd-liquity", (row) => row.source_key === "pool-lusd-aave");
    expect(aaveRow?.yield_source).toBe("Aave V3");
    expect(aaveRow?.yield_type).toBe("lending-opportunity");
    expect(aaveRow?.data_source).toBe("defillama-auto");
    expect(aaveRow?.is_best).toBe(0);
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

  it("marks the run degraded when the direct DL yields fetch returns an invalid payload", async () => {
    const db = makeDb();

    vi.mocked(getCache).mockResolvedValue(null);
    mockFetch([{ match: "yields.llama.fi", body: { nope: [] }, status: 200 }]);

    const result = await syncYieldData(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as { fallbackMode: string | null };
    expect(metadata.fallbackMode ?? "").toContain("dl-pools:direct-fetch-invalid-payload");
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
    const originalYieldCoins = [...ACTIVE_YIELD_BEARING_STABLECOINS];
    const db = makeDb();

    ACTIVE_YIELD_BEARING_STABLECOINS.splice(0, ACTIVE_YIELD_BEARING_STABLECOINS.length);

    try {
      const result = await syncYieldData(db);

      expect(result.itemCount).toBe(0);
      expect(result.metadata).toBe("no yield-bearing coins");
      expect(shouldAttemptFetch).not.toHaveBeenCalled();
      expect(batchExecute).not.toHaveBeenCalled();
    } finally {
      ACTIVE_YIELD_BEARING_STABLECOINS.push(...originalYieldCoins);
    }
  });

  it("returns degraded when published yield-bearing coverage regresses against the previous rankings snapshot", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "yield-rankings") {
        return {
          value: JSON.stringify({
            rankings: Array.from({ length: 10 }, () => ({ id: "100" })),
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string | null;
      previousPublishedYieldBearingCount: number;
      currentPublishedYieldBearingCount: number;
    };
    expect(metadata.reason).toBe("published-yield-coverage-regression");
    expect(metadata.previousPublishedYieldBearingCount).toBe(10);
    expect(metadata.currentPublishedYieldBearingCount).toBe(0);
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("returns degraded when published lending-opportunity coverage regresses against the previous snapshot", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "yield-rankings") {
        return {
          value: JSON.stringify({
            rankings: [{ id: "100" }, ...Array.from({ length: 10 }, () => ({ id: "usdc-circle" }))],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
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

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string | null;
      previousPublishedOpportunityCount: number;
      currentPublishedOpportunityCount: number;
      previousPublishedRankingCount: number;
      currentPublishedRankingCount: number;
    };
    expect(metadata.reason).toBe("published-lending-opportunity-coverage-regression");
    expect(metadata.previousPublishedOpportunityCount).toBe(10);
    expect(metadata.currentPublishedOpportunityCount).toBe(0);
    expect(metadata.previousPublishedRankingCount).toBe(11);
    expect(metadata.currentPublishedRankingCount).toBe(1);
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("returns degraded when total published ranking count regresses against the previous snapshot", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "yield-rankings") {
        return {
          value: JSON.stringify({
            rankings: Array.from({ length: 10 }, (_, index) => ({ id: `legacy-opportunity-${index}` })),
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
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

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string | null;
      previousPublishedRankingCount: number;
      currentPublishedRankingCount: number;
    };
    expect(metadata.reason).toBe("published-total-coverage-regression");
    expect(metadata.previousPublishedRankingCount).toBe(10);
    expect(metadata.currentPublishedRankingCount).toBe(1);
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("recovers a malformed previous yield-rankings cache when the new payload passes guards", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "yield-rankings") {
        return {
          value: "{not-json",
          updatedAt: nowSec,
        };
      }
      return null;
    });
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

    expect(result.itemCount).toBe(1);
    expect(getYieldRankingsCachePayload(db)).toBeDefined();
  });

  it("returns early when tracked yield coverage regresses below the guard threshold", async () => {
    const db = makeDb();
    const originalYieldCoins = [...ACTIVE_YIELD_BEARING_STABLECOINS];

    for (let i = 0; i < 10; i++) {
      ACTIVE_YIELD_BEARING_STABLECOINS.push({
        id: `yield-extra-${i}`,
        name: `Yield Extra ${i}`,
        symbol: `YE${i}`,
        geckoId: `yield-extra-${i}`,
        flags: {
          pegCurrency: "USD",
          backing: "crypto-backed",
          yieldBearing: true,
          navToken: false,
          governance: "decentralized",
        },
      } as never);
    }

    try {
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
      const metadata = JSON.parse(result.metadata ?? "{}") as {
        reason?: string | null;
        coverage?: number;
        resolvedCount?: number;
        totalCount?: number;
      };

      expect(result.status).toBe("degraded");
      expect(metadata.reason).toBe("coverage-regression");
      expect(metadata.coverage).toBeCloseTo(1 / 11, 6);
      expect(metadata.resolvedCount).toBe(1);
      expect(metadata.totalCount).toBe(11);
      expect(batchExecute).not.toHaveBeenCalled();
    } finally {
      ACTIVE_YIELD_BEARING_STABLECOINS.splice(0, ACTIVE_YIELD_BEARING_STABLECOINS.length, ...originalYieldCoins);
    }
  });

  it("skips yield-rankings cache write when response payload fails schema validation", async () => {
    const db = makeBrokenYieldRankingsDb();
    vi.mocked(getCache).mockResolvedValue(null);
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.spyOn(publicationModule, "validateYieldRankingsPayloadForPublish").mockResolvedValue({
      ok: false,
      validationFailures: 1,
      reason: "schema-validation-failed",
    });
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string | null;
      publishFailure: string | null;
      validationFailures: number;
    };
    expect(metadata.reason).toBe("yield-rankings-preflight-failed");
    expect(metadata.publishFailure).toBe("schema-validation-failed");
    expect(metadata.validationFailures).toBe(1);
    expect(getYieldRankingsCachePayload(db)).toBeUndefined();
  });

  it("preserves published D1 rows when yield-rankings cache persistence fails before data replacement", async () => {
    const db = makeCacheWriteFailureDb(new Error("cache unavailable"));
    mockHealthyRiskFreeRateCache();

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

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string | null;
      publishFailure: string | null;
    };
    expect(metadata.reason).toBe("yield-publication-transaction-failed");
    expect(metadata.publishFailure ?? "").toContain("cache unavailable");
    expect(writeFreshnessSentinel).not.toHaveBeenCalled();
  });

  it("tries price-derived as additional source when DL returns 0% APY for navToken", async () => {
    // sDAI (navToken: true) gets a DL pool with 0% APY.
    // The resolve logic should also try price-derived and pick the non-zero source.
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      {
        match:
          "SELECT price, snapshot_date FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
        matchBinds: ["100"],
        rows: [],
        first: { price: 1.05, snapshot_date: nowSec },
      },
      {
        match: "FROM supply_history",
        matchBinds: ["100", nowSec - 45 * 86400, nowSec - 7 * 86400],
        rows: [],
        first: { price: 1.01, snapshot_date: nowSec - 30 * 86400 },
      },
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

    const priceDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "price-derived");
    expect(priceDerivedRow).toBeDefined();
    // price-derived APY should be > 0 (computeApyFromPrice mock returns 4.0)
    expect(Number(priceDerivedRow?.current_apy)).toBeGreaterThan(0);
    // data_source should be "price-derived"
    expect(priceDerivedRow?.data_source).toBe("price-derived");
    // price-derived should be is_best (higher APY than DL's 0%)
    expect(priceDerivedRow?.is_best).toBe(1);

    const rankingsPayload = getYieldRankingsCachePayload(db) as {
      rankings: Array<{
        id: string;
        provenance?: {
          sourceObservedAt: number;
          sourceAgeSeconds: number;
          comparisonAnchorObservedAt?: number | null;
          comparisonAnchorAgeSeconds?: number | null;
        } | null;
      }>;
    };
    const ranking = rankingsPayload.rankings.find((entry) => entry.id === "100");
    expect(ranking?.provenance?.sourceObservedAt).toBe(nowSec);
    expect(ranking?.provenance?.sourceAgeSeconds).toBe(0);
    expect(ranking?.provenance?.comparisonAnchorObservedAt).toBe(nowSec - 30 * 86400);
    expect(ranking?.provenance?.comparisonAnchorAgeSeconds).toBe(30 * 86400);
  });

  it("uses the oldest available 7-45 day price anchor for young navToken coverage", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      {
        match:
          "SELECT price, snapshot_date FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
        matchBinds: ["100"],
        rows: [],
        first: { price: 1.05, snapshot_date: nowSec },
      },
      {
        match: "FROM supply_history",
        matchBinds: ["100", nowSec - 45 * 86400, nowSec - 7 * 86400],
        rows: [],
        first: { price: 1.01, snapshot_date: nowSec - 10 * 86400 },
      },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([]),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    await syncYieldData(db);

    const priceDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "price-derived");
    expect(priceDerivedRow).toBeDefined();
    expect(Number(priceDerivedRow?.current_apy)).toBeGreaterThan(0);
  });

  it("computes trailing APY from source-specific history instead of mixed coin-level history", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "AND recorded_at <= ? AND exchange_rate IS NOT NULL",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "pool-sdai-native",
            recorded_at: nowSec - 8 * 86400,
            exchange_rate: 1.0,
          },
        ],
      },
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
      {
        match:
          "SELECT price, snapshot_date FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
        matchBinds: ["100"],
        rows: [],
        first: { price: 1.05, snapshot_date: nowSec },
      },
      {
        match: "FROM supply_history",
        matchBinds: ["100", nowSec - 45 * 86400, nowSec - 7 * 86400],
        rows: [],
        first: { price: 1.01, snapshot_date: nowSec - 30 * 86400 },
      },
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

    const priceDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "price-derived");

    // Source-specific history should average [2, 4] => 3.0 instead of mixing in the DL row's 9% sample.
    expect(Number(priceDerivedRow?.apy_30d)).toBeCloseTo(3, 3);
  });

  it("does not carry forward legacy history when the current source family changed", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const configs = yieldConfigModule.RATE_DERIVED_CONFIGS as typeof yieldConfigModule.RATE_DERIVED_CONFIGS;
    configs.push({ stablecoinId: "100", spreadBps: 25, label: "T-bill proxy (net of 0.25% fee)" });

    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "legacy-best",
            recorded_at: nowSec - 2 * 86400,
            is_best: 1,
            apy: 0,
            source_tvl_usd: null,
            data_source: "price-derived",
            yield_source: null,
            yield_type: null,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: nowSec };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    await syncYieldData(db);

    const rateDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "rate-derived");

    // The current row should stand on its own source-specific history rather than averaging with legacy price-derived rows.
    expect(Number(rateDerivedRow?.apy_30d)).toBeCloseTo(3.75, 3);

    configs.length = 0;
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

    const rateDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "rate-derived");
    expect(rateDerivedRow).toBeDefined();
    // APY should be 4.0 - 0.25 = 3.75
    expect(Number(rateDerivedRow?.current_apy)).toBeCloseTo(3.75, 2);
    // data_source should be "rate-derived"
    expect(rateDerivedRow?.data_source).toBe("rate-derived");
    // rate-derived should be is_best (only source)
    expect(rateDerivedRow?.is_best).toBe(1);

    // Clean up
    configs.length = 0;
  });

  it("resolves OUSG rate-derived yield with 50bps spread", async () => {
    const configs = yieldConfigModule.RATE_DERIVED_CONFIGS as typeof yieldConfigModule.RATE_DERIVED_CONFIGS;
    configs.push({ stablecoinId: "100", spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)" });

    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.25", updatedAt: Math.floor(Date.now() / 1000) };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const rateDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "rate-derived");
    expect(rateDerivedRow).toBeDefined();
    // APY should be 4.25 - 0.50 = 3.75
    expect(Number(rateDerivedRow?.current_apy)).toBeCloseTo(3.75, 2);
    expect(rateDerivedRow?.data_source).toBe("rate-derived");

    configs.length = 0;
  });

  it("produces valid APY entry from expanded ON_CHAIN_RATE_CONFIGS", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "onchain:100",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
        ],
      },
      { match: "supply_history", rows: [] },
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

    vi.mocked(getChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    });

    // Mock fetch to handle the convertToAssets RPC call
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("rpc.example/eth")) {
          const body = JSON.parse(String(init?.body)) as {
            params?: Array<{ data?: string } | string>;
          };
          const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;
          if (callData?.startsWith("0x07a2d13a")) {
            // Return exchange rate of ~1.05e18 (5% appreciation)
            return new Response(
              JSON.stringify({
                result: "0x" + BigInt("1050000000000000000").toString(16).padStart(64, "0"),
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

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/eth",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    await syncYieldData(db, undefined, testChainRpcs);

    const onChainRow = findPublishedYieldRow(db, "100", (row) => row.data_source === "onchain");
    expect(onChainRow).toBeDefined();
    expect(Number(onChainRow?.current_apy)).toBeGreaterThan(0);

    const rankingsPayload = getYieldRankingsCachePayload(db) as {
      rankings: Array<{
        id: string;
        provenance?: {
          sourceObservedAt: number;
          sourceAgeSeconds: number;
          comparisonAnchorObservedAt?: number | null;
          comparisonAnchorAgeSeconds?: number | null;
        } | null;
      }>;
    };
    const ranking = rankingsPayload.rankings.find((entry) => entry.id === "100");
    expect(ranking?.provenance?.sourceObservedAt).toBe(nowSec);
    expect(ranking?.provenance?.sourceAgeSeconds).toBe(0);
    expect(ranking?.provenance?.comparisonAnchorObservedAt).toBe(nowSec - 8 * 86400);
    expect(ranking?.provenance?.comparisonAnchorAgeSeconds).toBe(8 * 86400);

    onChainConfigs.length = 0;
  });

  it("marks the run degraded when all deterministic on-chain sources fail", async () => {
    const onChainConfigs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = makeDb();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode?: string | null;
      sourceCoverage?: {
        onChainAttempted?: number;
        onChainAllDeterministicFailed?: boolean;
        onChainFailures?: Record<string, number> | null;
      };
    };

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode ?? "").toContain("onchain-rates:all-deterministic-failed");
    expect(metadata.sourceCoverage?.onChainAttempted).toBe(1);
    expect(metadata.sourceCoverage?.onChainAllDeterministicFailed).toBe(true);
    expect(metadata.sourceCoverage?.onChainFailures).toEqual({ "no-chain-rpcs": 1 });

    onChainConfigs.length = 0;
  });

  it("keeps the run healthy when deterministic on-chain reads fail but every affected coin has non-onchain coverage", async () => {
    const onChainConfigs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = makeDb();
    mockHealthyRiskFreeRateCache();
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
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode?: string | null;
      sourceCoverage?: {
        onChainAllDeterministicFailed?: boolean;
        onChainFailureMaskedByAlternativeCoverage?: boolean;
        onChainAlternativeCoverageMissingIds?: string[];
        onChainFailures?: Record<string, number> | null;
      };
    };

    expect(result.status).toBeUndefined();
    expect(metadata.fallbackMode).toBeNull();
    expect(metadata.sourceCoverage?.onChainAllDeterministicFailed).toBe(true);
    expect(metadata.sourceCoverage?.onChainFailureMaskedByAlternativeCoverage).toBe(true);
    expect(metadata.sourceCoverage?.onChainAlternativeCoverageMissingIds).toEqual([]);
    expect(metadata.sourceCoverage?.onChainFailures).toEqual({ "no-chain-rpcs": 1 });

    onChainConfigs.length = 0;
  });

  it("falls back to the secondary RPC URL before degrading the deterministic lane", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "onchain:100",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: nowSec };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(getChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/primary",
      fallbackRpcUrl: "https://rpc.example/fallback",
      explorerUrl: "https://etherscan.io",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("rpc.example/fallback")) {
          const body = JSON.parse(String(init?.body)) as {
            params?: Array<{ data?: string } | string>;
          };
          const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;
          if (callData?.startsWith("0x07a2d13a")) {
            return new Response(
              JSON.stringify({
                result: "0x" + BigInt("1050000000000000000").toString(16).padStart(64, "0"),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        if (url.includes("rpc.example/primary")) {
          return new Response(
            JSON.stringify({
              error: { message: "upstream unhealthy" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/primary",
          fallbackRpcUrl: "https://rpc.example/fallback",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    const result = await syncYieldData(db, undefined, testChainRpcs);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode?: string | null;
      sourceCoverage?: {
        onChainRatesResolved?: number;
        onChainAllDeterministicFailed?: boolean;
      };
    };

    expect(metadata.fallbackMode ?? "").not.toContain("onchain-rates:all-deterministic-failed");
    expect(metadata.sourceCoverage?.onChainRatesResolved).toBe(1);
    expect(metadata.sourceCoverage?.onChainAllDeterministicFailed).toBe(false);

    onChainConfigs.length = 0;
  });

  it("falls back to the Etherscan proxy when Worker RPC reads all fail", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "onchain:100",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: nowSec };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(getChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/primary",
      fallbackRpcUrl: "https://rpc.example/fallback",
      explorerUrl: "https://etherscan.io",
    });
    mockFetch([]);
    const rawRpcSpy = vi.spyOn(evmRpcModule, "fetchEvmUint256AtBlock").mockResolvedValue(null);
    const etherscanSpy = vi
      .spyOn(evmRpcModule, "fetchEtherscanUint256AtBlock")
      .mockResolvedValue(BigInt("1050000000000000000"));

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/primary",
          fallbackRpcUrl: "https://rpc.example/fallback",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    const result = await syncYieldData(db, undefined, testChainRpcs, undefined, "etherscan-key");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode?: string | null;
      sourceCoverage?: {
        onChainRatesResolved?: number;
        onChainAllDeterministicFailed?: boolean;
        onChainExplorerAttempted?: number;
        onChainExplorerResolved?: number;
        onChainFailures?: Record<string, number> | null;
      };
    };

    expect(metadata.fallbackMode ?? "").not.toContain("onchain-rates:all-deterministic-failed");
    expect(metadata.sourceCoverage?.onChainRatesResolved).toBe(1);
    expect(metadata.sourceCoverage?.onChainAllDeterministicFailed).toBe(false);
    expect(metadata.sourceCoverage?.onChainExplorerAttempted).toBe(1);
    expect(metadata.sourceCoverage?.onChainExplorerResolved).toBe(1);
    expect(metadata.sourceCoverage?.onChainFailures).toBeNull();
    const deterministicRawRpcCalls = rawRpcSpy.mock.calls.filter(
      ([, contract, data]) =>
        contract === "0x83F20F44975D03b1b09e64809B757c47f942BEeA" &&
        typeof data === "string" &&
        data.startsWith("0x07a2d13a"),
    );
    expect(deterministicRawRpcCalls).toHaveLength(2);
    expect(etherscanSpy).toHaveBeenCalledWith(
      1,
      "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.objectContaining({ apiKey: "etherscan-key" }),
    );

    onChainConfigs.length = 0;
  });

  it("records explorer fallback failures when deterministic RPC and explorer reads both return empty", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "onchain:100",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: nowSec };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(getChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/primary",
      fallbackRpcUrl: "https://rpc.example/fallback",
      explorerUrl: "https://etherscan.io",
    });
    mockFetch([]);
    vi.spyOn(evmRpcModule, "fetchEvmUint256AtBlock").mockResolvedValue(null);
    vi.spyOn(evmRpcModule, "fetchEtherscanUint256AtBlock").mockResolvedValue(null);

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/primary",
          fallbackRpcUrl: "https://rpc.example/fallback",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    const result = await syncYieldData(db, undefined, testChainRpcs, undefined, "etherscan-key");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode?: string | null;
      sourceCoverage?: {
        onChainAttempted?: number;
        onChainAllDeterministicFailed?: boolean;
        onChainExplorerAttempted?: number;
        onChainExplorerResolved?: number;
        onChainFailures?: Record<string, number> | null;
      };
    };

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode ?? "").toContain("onchain-rates:all-deterministic-failed");
    expect(metadata.sourceCoverage?.onChainAttempted).toBe(1);
    expect(metadata.sourceCoverage?.onChainAllDeterministicFailed).toBe(true);
    expect(metadata.sourceCoverage?.onChainExplorerAttempted).toBe(1);
    expect(metadata.sourceCoverage?.onChainExplorerResolved).toBe(0);
    expect(metadata.sourceCoverage?.onChainFailures).toEqual({ "rpc-empty|etherscan-empty": 1 });

    onChainConfigs.length = 0;
  });

  it("reuses pre-migration deterministic history after switching to onchain source keys", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "pool-sdai-native",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 9,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: nowSec };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(getChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("rpc.example/eth")) {
          const body = JSON.parse(String(init?.body)) as {
            params?: Array<{ data?: string } | string>;
          };
          const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;
          if (callData?.startsWith("0x07a2d13a")) {
            return new Response(
              JSON.stringify({
                result: "0x" + BigInt("1050000000000000000").toString(16).padStart(64, "0"),
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

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/eth",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    const result = await syncYieldData(db, undefined, testChainRpcs);

    const onChainRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "onchain:100");
    expect(onChainRow).toBeDefined();
    expect(Number(onChainRow?.apy_7d)).toBeCloseTo(5, 6);
    expect(Number(onChainRow?.apy_30d)).toBeCloseTo(7, 6);
    expect(onChainRow?.exchange_rate_prev).toBe(1.0);

    const metadata = JSON.parse(result.metadata ?? "{}") as { sourceSwitches?: number };
    expect(metadata.sourceSwitches).toBe(0);
  });

  it("reuses legacy B.Protocol history after normalizing the LUSD deterministic source key", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "lusd-liquity",
            source_key: "bprotocol-lqty-only",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 4.5,
            source_tvl_usd: 1_250_000,
            data_source: "onchain",
            yield_source: "B.Protocol Stability Pool (LQTY only)",
            yield_type: "lending-vault",
            exchange_rate: null,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: nowSec };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(getChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;

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

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/eth",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    const result = await syncYieldData(db, undefined, testChainRpcs);

    const onChainRow = findPublishedYieldRow(db, "lusd-liquity", (row) => row.source_key === "onchain:lusd-liquity");
    expect(onChainRow).toBeDefined();
    expect(onChainRow?.is_best).toBe(1);

    const metadata = JSON.parse(result.metadata ?? "{}") as { sourceSwitches?: number };
    expect(metadata.sourceSwitches).toBe(0);
  });

  it("retains both on-chain and curated rows when the native pool overlaps with ON_CHAIN_RATE_CONFIGS", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    const poolMap = yieldConfigModule.YIELD_POOL_MAP as Record<string, string>;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });
    poolMap["100"] = "pool-sdai-native";

    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "onchain:100",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
          {
            stablecoin_id: "100",
            source_key: "pool-sdai-native",
            recorded_at: nowSec - 7 * 86400 + 3600,
            is_best: 1,
            apy: 5.2,
            source_tvl_usd: 1_000_000_000,
            data_source: "defillama",
            yield_source: "DSR",
            yield_type: "nav-appreciation",
            exchange_rate: null,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

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
              apy: 5.2,
              apyBase: 5.2,
              apyReward: null,
              apyMean30d: 5.1,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: nowSec - 60,
        };
      }
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: nowSec };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(getChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("rpc.example/eth")) {
          const body = JSON.parse(String(init?.body)) as {
            params?: Array<{ data?: string } | string>;
          };
          const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;
          if (callData?.startsWith("0x07a2d13a")) {
            return new Response(
              JSON.stringify({
                result: "0x" + BigInt("1050000000000000000").toString(16).padStart(64, "0"),
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

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/eth",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    await syncYieldData(db, undefined, testChainRpcs);

    const onChainRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "onchain:100");
    const curatedRow = findPublishedYieldRow(
      db,
      "100",
      (row) => row.source_key === "pool-sdai-native" && row.data_source === "defillama",
    );
    expect(onChainRow).toBeDefined();
    expect(curatedRow).toBeDefined();
    expect(Number(onChainRow?.current_apy)).toBeGreaterThan(0);

    delete poolMap["100"];
    onChainConfigs.length = 0;
  });

  it("labels yield-bearing auto-discovered rows as lending opportunities", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-placeholder",
              chain: "Ethereum",
              project: "aave-v3",
              symbol: "USDC",
              tvlUsd: 5_000_000,
              apy: 3.25,
              apyBase: 3.25,
              apyReward: null,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: nowSec - 60,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(yieldHelpersModule.findBestLendingPool).mockImplementation((symbol) =>
      symbol === "sDAI"
        ? {
            pool: "pool-sdai-aave",
            apy: 3.25,
            apyBase: 3.25,
            apyReward: null,
            tvlUsd: 5_000_000,
            project: "aave-v3",
          }
        : null,
    );
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(1);
    const autoRow = findPublishedYieldRow(db, "100", (row) => row.data_source === "defillama-auto");
    expect(autoRow?.yield_source).toBe("Aave V3");
    expect(autoRow?.yield_type).toBe("lending-opportunity");
  });

  it("passes a supply-relative TVL floor into dynamic lending discovery", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "stablecoins") {
        return {
          value: JSON.stringify({
            peggedAssets: [
              {
                id: "usdc-circle",
                symbol: "USDC",
                name: "USD Coin",
                price: 1,
                circulating: { peggedUSD: 10_000_000_000 },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-placeholder",
              chain: "Ethereum",
              project: "aave-v3",
              symbol: "USDC",
              tvlUsd: 5_000_000,
              apy: 3.25,
              apyBase: 3.25,
              apyReward: null,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: nowSec - 60,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(yieldHelpersModule.findBestLendingPool).mockReturnValue(null);
    mockFetch([]);

    await syncYieldData(db);

    const usdcDiscoveryCall = vi
      .mocked(yieldHelpersModule.findBestLendingPool)
      .mock.calls.find((call) => call[0] === "USDC");
    expect(usdcDiscoveryCall?.[2]).toEqual(expect.any(Set));
    expect(usdcDiscoveryCall?.[3]).toMatchObject({
      minApy: 0.5,
      minTvlUsd: 10_000_000,
    });
  });

  it("marks the run degraded when a retained benchmark is in fallback mode, even if recent", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([]),
          updatedAt: nowSec - 6 * 3600,
        };
      }
      if (key === "risk_free_rate") {
        return {
          value: JSON.stringify({
            rate: 3.71,
            recordDate: "2025-06-13",
            fetchedAt: nowSec - 6 * 3600,
            source: "fred-dgs3mo",
            isFallback: true,
            fallbackMode: "fred-api-error-retained",
          }),
          updatedAt: nowSec - 6 * 3600,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string | null;
    };

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toContain("risk-free-rate:fred-api-error-retained");

    const rankingsPayload = getYieldRankingsCachePayload(db) as {
      provenance: { benchmark: { fallbackMode: string | null; isFallback: boolean } };
    };
    expect(rankingsPayload.provenance.benchmark.fallbackMode).toBe("fred-api-error-retained");
    expect(rankingsPayload.provenance.benchmark.isFallback).toBe(true);
  });

  it("marks yield sync degraded when the retained benchmark is older than two days", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([]),
          updatedAt: nowSec - 49 * 3600,
        };
      }
      if (key === "risk_free_rate") {
        return {
          value: JSON.stringify({
            rate: 3.71,
            recordDate: "2025-06-10",
            fetchedAt: nowSec - 49 * 3600,
            source: "fred-dgs3mo",
            isFallback: true,
            fallbackMode: "fred-api-error-retained",
          }),
          updatedAt: nowSec - 49 * 3600,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string | null;
    };

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toContain("risk-free-rate:fred-api-error-retained");
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

    expect(getYieldRankingsCachePayload(db)).toBeDefined();
    expect(vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "report_card_cache")).toBe(false);
  });

  it("skips destructive yield row cleanup on degraded runs", async () => {
    const db = makeYieldOrphanDb(["orphan-coin"]);
    const nowSec = Math.floor(Date.now() / 1000);

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
          updatedAt: nowSec,
        };
      }
      if (key === "risk_free_rate") {
        return {
          value: JSON.stringify({
            rate: 4.0,
            source: "fred",
            fetchedAt: nowSec - 50 * 3600,
            recordDate: "2026-03-20",
            isFallback: true,
            fallbackMode: "fred-api-error-retained",
          }),
          updatedAt: nowSec - 50 * 3600,
        };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.status).toBe("degraded");
    const staleDeleteCall = db
      .getHistory()
      .find((entry) => entry.sql.includes("DELETE FROM yield_data") && entry.sql.includes("updated_at <"));
    const orphanDeleteCall = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("DELETE FROM yield_data") &&
          entry.sql.includes("stablecoin_id IN") &&
          !entry.sql.includes("updated_at <"),
      );

    expect(staleDeleteCall).toBeUndefined();
    expect(orphanDeleteCall).toBeUndefined();
  });
});
