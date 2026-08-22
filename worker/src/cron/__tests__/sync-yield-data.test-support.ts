import { vi } from "vitest";
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
  getAlchemyAuthHeaders: vi.fn(() => undefined),
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
import * as safetyScoreActiveSourceModule from "../../lib/safety-score-active-source";
import * as safetyScoresModule from "../../lib/safety-scores";
import * as yieldConfigModule from "../yield-config";
import * as yieldHelpersModule from "../yield-helpers";
import * as publicationModule from "../yield-sync/publication";
import * as evmRpcModule from "../../lib/evm-rpc";
import { YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY } from "../../lib/yield-history-cleanup";

const mutableActiveStablecoins = ACTIVE_STABLECOINS as typeof ACTIVE_STABLECOINS extends readonly (infer T)[]
  ? T[]
  : never;
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
  safety_score: number | null;
  safety_grade: string;
  pharos_yield_score: number | null;
  exchange_rate_prev: number | null;
  is_best: number;
};

type YieldHistoryTestRow = {
  stablecoin_id: string;
  source_key: string;
  pys_at_publish: number | null;
  safety_at_publish: number | null;
  pys_inputs_at_publish: string | null;
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

function findPublishedYieldHistoryRow(
  db: MockHistoryDb,
  stablecoinId: string,
  predicate: (row: YieldHistoryTestRow) => boolean,
): YieldHistoryTestRow | undefined {
  const entry = db.getHistory().find((item) => item.sql.includes("INSERT OR IGNORE INTO yield_history"));
  const rows = entry ? (JSON.parse(String(entry.binds[0] ?? "[]")) as YieldHistoryTestRow[]) : [];
  return rows.find((row) => row.stablecoin_id === stablecoinId && predicate(row));
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
function resetSyncYieldDataTest() {
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
  vi.mocked(getCaches)
    .mockReset()
    .mockImplementation(async (db, keys) => {
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
    source: "safety-score-v9-publication",
    safetyScoreIdentity: {
      model: "v9",
      schemaVersion: 1,
      methodologyVersion: "9.0",
      policyId: "safety-score-v9",
      policyDigest: "a".repeat(64),
      evaluationBuildDigest: "b".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
      publicationGenerationId: "report-cards:v9:test",
    },
    publicationGenerationId: "report-cards:v9:test",
    methodologyVersion: "9.0",
    publishedAt: Math.floor(Date.now() / 1000),
    scores: new Map([
      ["100", { score: 80, grade: "B+" }],
      ["usdc-circle", { score: 78, grade: "B+" }],
      ["u-united-stables", { score: 55, grade: "C" }],
      ["lusd-liquity", { score: 86, grade: "A-" }],
    ]),
  } as never);
  // Identity-only publish-time guard: mirror whatever published snapshot the
  // test has staged so per-test safety identities keep driving the guard.
  vi.spyOn(safetyScoreActiveSourceModule, "loadActiveSafetyScoreIdentity").mockImplementation(
    async (db) => {
      const snapshot = await safetyScoresModule.computeSafetyScoresSnapshot(db);
      return snapshot.kind === "ok" && snapshot.safetyScoreIdentity !== null
        ? { kind: "v9", safetyScoreIdentity: snapshot.safetyScoreIdentity }
        : { kind: "error", safetyScoreIdentity: null };
    },
  );
}

function cleanupSyncYieldDataTest() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

const fixtureMockD1 = mockD1;
const fixtureSyncYieldData = syncYieldData;
const fixtureBatchExecute = batchExecute;
const fixtureGetCache = getCache;
const fixtureGetCaches = getCaches;
const fixtureSetCacheIfNewer = setCacheIfNewer;
const fixtureWriteFreshnessSentinel = writeFreshnessSentinel;
const fixtureShouldAttemptFetch = shouldAttemptFetch;
const fixtureRecordOutcome = recordOutcome;
const fixtureGetChainRpc = getChainRpc;
const fixtureMockFetch = mockFetch;
const fixtureACTIVE_STABLECOINS = ACTIVE_STABLECOINS;
const fixtureACTIVE_YIELD_BEARING_STABLECOINS = ACTIVE_YIELD_BEARING_STABLECOINS;
const fixtureSafetyScoreActiveSourceModule = safetyScoreActiveSourceModule;
const fixtureSafetyScoresModule = safetyScoresModule;
const fixtureYieldConfigModule = yieldConfigModule;
const fixtureYieldHelpersModule = yieldHelpersModule;
const fixturePublicationModule = publicationModule;
const fixtureEvmRpcModule = evmRpcModule;
const fixtureYIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY = YIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY;

export {
  mutableActiveStablecoins,
  mutableTrackedMetaById,
  makeDb,
  makeStablecoinsCacheValue,
  makeCacheWriteFailureDb,
  getPublishedYieldRows,
  findPublishedYieldRow,
  findPublishedYieldHistoryRow,
  getYieldRankingsCachePayload,
  makeYieldOrphanDb,
  makeBrokenYieldRankingsDb,
  mockHealthyRiskFreeRateCache,
  resetSyncYieldDataTest,
  cleanupSyncYieldDataTest,
  type ChainRpcConfig,
  type CronProgressUpdate,
  type MockHistoryDb,
  type YieldDataTestRow,
  type YieldHistoryTestRow,
  fixtureMockD1,
  fixtureSyncYieldData,
  fixtureBatchExecute,
  fixtureGetCache,
  fixtureGetCaches,
  fixtureSetCacheIfNewer,
  fixtureWriteFreshnessSentinel,
  fixtureShouldAttemptFetch,
  fixtureRecordOutcome,
  fixtureGetChainRpc,
  fixtureMockFetch,
  fixtureACTIVE_STABLECOINS,
  fixtureACTIVE_YIELD_BEARING_STABLECOINS,
  fixtureSafetyScoreActiveSourceModule,
  fixtureSafetyScoresModule,
  fixtureYieldConfigModule,
  fixtureYieldHelpersModule,
  fixturePublicationModule,
  fixtureEvmRpcModule,
  fixtureYIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
};
