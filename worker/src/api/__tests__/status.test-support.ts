import { vi } from "vitest";
import {
  mockD1,
  type MockD1Database,
  type MockTableConfig,
} from "@shared/test-utils/mock-d1";
import { makeApiRequest, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import * as dependencyHealthModule from "../../lib/dependency-health";
import { makeDataQuality, makeReserveComposition, makeStatusSummary } from "@shared/types/__tests__/status.test-support";

stubCryptoForAuth();

const { handleStatus } = await import("../status");
const { STATUS_RAW_SNAPSHOT_CACHE_KEY, STATUS_RAW_SNAPSHOT_MAX_AGE_SEC } =
  await import("../../lib/status/raw-snapshot");

/** Build a mock cache row with a recent updated_at */
function makeCacheRow(key: string, ageSec = 300) {
  return {
    key,
    updated_at: Math.floor(Date.now() / 1000) - ageSec,
    value: JSON.stringify(key === "fx-rates" ? { peggedEUR: 1.08 } : []),
  };
}

/** Build a mock cron_runs row */
function makeCronRow(job: string, status = "ok", ageSec = 300) {
  return {
    job,
    started_at: Math.floor(Date.now() / 1000) - ageSec,
    duration_ms: 1500,
    status,
    error: null,
    item_count: 100,
    metadata: null,
  };
}

function makeDewsPublicationPointerRow(now: number, ageSec = 300) {
  const updatedAt = now - ageSec;
  return {
    key: "dews:published-generation",
    updated_at: updatedAt,
    value: JSON.stringify({
      updatedAt,
      source: "compute-dews",
      publishStatus: "published",
      coverageVersion: 2,
      expectedRowCount: 1,
      stablecoinIdsDigest: "a".repeat(64),
    }),
  };
}

function makeRawStatusForSnapshot(now: number, overrides: Record<string, unknown> = {}) {
  return {
    dbHealthy: true,
    availabilityStatus: "healthy",
    dataQualityStatus: "healthy",
    rawOverallStatus: "healthy",
    confidence: 0.95,
    causes: {
      availability: [],
      dataQuality: [],
      overall: [],
    },
    caches: {},
    crons: {
      "sync-stablecoins": {
        lastRun: {
          startedAt: now - 60,
          durationMs: 1500,
          status: "ok",
          itemCount: 100,
        },
        recentRuns: [{
          startedAt: now - 60,
          durationMs: 1500,
          status: "ok",
          itemCount: 100,
        }],
        expectedIntervalSec: 900,
        healthy: true,
      },
    },
    budgetOnlySurfaces: [],
    dataQuality: makeDataQuality({
      totalStablecoins: 1,
      onchainSupplyLatestAt: now - 60,
      onchainSupplyTrackedCoins: 1,
    }),
    telegramBot: null,
    sectionErrors: {},
    datasetFreshness: {
      stablecoins: now - 60,
      blacklist: now - 60,
      mintBurn: now - 60,
      supply: now - 60,
      safetyGrades: now - 60,
      yield: now - 60,
      depegs: now - 60,
      dews: now - 60,
      digest: now - 60,
    },
    summary: makeStatusSummary(),
    reserveComposition: makeReserveComposition(),
    freshnessDiagnostics: [],
    ...overrides,
  };
}

function makeRawStatusSnapshotRow(now: number, ageSec: number, overrides: Record<string, unknown> = {}) {
  const updatedAt = now - ageSec;
  return {
    key: STATUS_RAW_SNAPSHOT_CACHE_KEY,
    updated_at: updatedAt,
    value: JSON.stringify({
      version: 1,
      producedAt: updatedAt,
      raw: makeRawStatusForSnapshot(updatedAt, overrides),
    }),
  };
}

function makeMinimalLiveStatusRows(now: number, stateRow: Record<string, unknown> | null = null) {
  const stablecoinsCache = JSON.stringify({
    peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1, circulating: { peggedUSD: 100_000_000 } }],
  });
  return [
    { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins"), makeCacheRow("stablecoin-charts")] },
    { match: "dex_liquidity", rows: [], first: { age: 300 } },
    { match: "yield_data", rows: [], first: { age: 300 } },
    { match: "stress_signals", rows: [], first: { age: 300 } },
    { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
    { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
    { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
    { match: "depeg_events", rows: [], first: { cnt: 0 } },
    { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
    { match: "onchain_supply WHERE updated_at >", rows: [] },
    { match: "FROM status_state", rows: [], first: stateRow },
  ];
}

type StatusD1Section =
  | "sentinel"
  | "live"
  | "publication"
  | "derived"
  | "reserves"
  | "statusState"
  | "cronState"
  | "telegram";

type StatusD1ScenarioOptions = {
  sections?: StatusD1Section[];
  overrides?: MockTableConfig[];
  optionalOverrides?: MockTableConfig[];
  sectionOverrides?: Partial<Record<StatusD1Section, MockTableConfig[]>>;
};

const pendingStrictD1Assertions = new Set<MockD1Database>();

const STATUS_D1_SECTIONS: Record<StatusD1Section, MockTableConfig[]> = {
  sentinel: [{ match: "SELECT 1", rows: [], first: { value: 1 } }],
  live: [],
  publication: [
    { match: "FROM worker_producer_heads", rows: [] },
  ],
  derived: [
    { match: "pharos:status-derived:mint-burn-24h", rows: [] },
    { match: "pharos:status-derived:mint-burn-first-hour-seek", rows: [] },
    { match: "SELECT key, LENGTH(value) as bytes FROM cache", rows: [] },
    { match: "blacklist-gap-metrics-cache-read", rows: [], first: null },
    { match: "blacklist-gap-aggregate", rows: [], first: null },
  ],
  reserves: [
    { match: "FROM reserve_sync_state", rows: [] },
    { match: "FROM reserve_composition", rows: [] },
    { match: "JOIN reserve_sync_state", rows: [] },
  ],
  statusState: [
    { match: "FROM status_state", rows: [], first: null },
    { match: "FROM status_probe_runs", rows: [], first: null },
    { match: "FROM status_discrepancy_state", rows: [], first: null },
    { match: "FROM status_transitions WHERE scope", rows: [], first: null },
  ],
  cronState: [
    { match: "FROM cron_leases", rows: [] },
    { match: "FROM cron_run_progress", rows: [] },
    { match: "FROM cron_slot_executions", rows: [] },
  ],
  telegram: [
    { match: "FROM telegram_preset_subscriptions", rows: [] },
    { match: "FROM telegram_watcher_lifecycle_daily", rows: [], first: null },
    { match: "FROM telegram_alert_source_events", rows: [], first: null },
    { match: "FROM telegram_alert_job_targets", rows: [], first: null },
    { match: "FROM telegram_alert_jobs", rows: [], first: null },
    { match: "FROM telegram_alert_job_target_items", rows: [], first: null },
    { match: "FROM telegram_alert_dead_letters", rows: [], first: null },
    { match: "FROM telegram_usage_daily", rows: [], first: null },
  ],
};

function sameQuery(left: MockTableConfig, right: MockTableConfig) {
  return left.match === right.match
    && JSON.stringify(left.matchBinds ?? null) === JSON.stringify(right.matchBinds ?? null);
}

function buildStatusD1Scenario({
  sections = ["sentinel", "publication", "derived", "reserves", "statusState", "cronState"],
  overrides = [],
  optionalOverrides = [],
  sectionOverrides = {},
}: StatusD1ScenarioOptions = {}): MockD1Database {
  const now = Math.floor(Date.now() / 1000);
  const sectionDefaults = sections.flatMap<MockTableConfig>((section) =>
    sectionOverrides[section] ?? (section === "live" ? makeMinimalLiveStatusRows(now) : STATUS_D1_SECTIONS[section]),
  );
  const defaults = sectionDefaults.filter(
    (entry, index) => !sectionDefaults.slice(0, index).some((earlier) => sameQuery(entry, earlier)),
  ).map((entry) => ({ ...entry, allowUnused: true }));
  const uniqueOverrides = overrides.filter(
    (entry, index) => !overrides.slice(0, index).some((earlier) => sameQuery(entry, earlier)),
  );
  const tables = [
    ...uniqueOverrides,
    ...optionalOverrides.map((entry) => ({ ...entry, allowUnused: true })),
    ...defaults.filter((entry) => !uniqueOverrides.some((override) => sameQuery(entry, override))),
  ];
  const db = fixtureMockD1(tables, {}, sections.includes("publication"));
  pendingStrictD1Assertions.add(db);
  return db;
}

function cleanupStatusTest() {
  try {
    for (const db of pendingStrictD1Assertions) db.assertAllMatchesUsed();
  } finally {
    pendingStrictD1Assertions.clear();
    vi.restoreAllMocks();
  }
}

function fixtureMockD1(
  tables: Parameters<typeof mockD1>[0] = [],
  options: Parameters<typeof mockD1>[1] = {},
  includeStatusDefaults = true,
): ReturnType<typeof mockD1> {
  const activeIds = ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id);
  const stablecoinCoverageQueryMatch = `metadata LIKE '%\"activePublicationCoverage\"%'`;
  const hasPublicationFixture = tables.some((table) =>
    table.match.includes(stablecoinCoverageQueryMatch),
  );
  const publicationFixture = {
    match: stablecoinCoverageQueryMatch,
    rows: [],
    first: {
      started_at: Math.floor(Date.now() / 1000) - 30,
      metadata: JSON.stringify({
        activePublicationCoverage: {
          complete: true,
          expectedActiveCount: ACTIVE_STABLECOINS.length,
          presentActiveCount: ACTIVE_STABLECOINS.length,
          waivedActiveCount: 0,
          missingActiveIds: [],
          waivedActiveIds: [],
          expiredWaiverIds: [],
        },
        activePriceCoverage: {
          complete: true,
          expectedActiveCount: activeIds.length,
          presentActiveCount: activeIds.length,
          pricedActiveCount: activeIds.length,
          pricedActiveIds: activeIds,
          missingPriceCount: 0,
          missingActiveIds: [],
          missingActiveAssets: [],
          missingActiveState: [],
          affectedMarketCapUsd: 0,
          alertEligibleCount: 0,
          alertEligibleIds: [],
          maxConsecutiveMissingGenerations: 0,
        },
      }),
    },
  };
  const hasDewsPointerFixture = tables.some((table) => table.matchBinds?.includes("dews:published-generation"));
  const dewsPointer = makeDewsPublicationPointerRow(Math.floor(Date.now() / 1000));
  const dewsPointerFixture = {
    match: "FROM cache WHERE key = ?",
    matchBinds: ["dews:published-generation"],
    rows: [dewsPointer],
    first: dewsPointer,
  };
  return mockD1(
    [
      ...(!includeStatusDefaults || hasPublicationFixture ? [] : [{ ...publicationFixture, allowUnused: true }]),
      ...(!includeStatusDefaults || hasDewsPointerFixture ? [] : [{ ...dewsPointerFixture, allowUnused: true }]),
      ...tables,
    ],
    options,
  );
}
const fixtureMakeApiRequest = makeApiRequest;
const fixtureMockFetch = mockFetch;
const fixtureCRON_INTERVALS = CRON_INTERVALS;
const fixtureACTIVE_STABLECOINS = ACTIVE_STABLECOINS;
const fixtureDependencyHealthModule = dependencyHealthModule;

export {
  handleStatus,
  STATUS_RAW_SNAPSHOT_CACHE_KEY,
  STATUS_RAW_SNAPSHOT_MAX_AGE_SEC,
  makeCacheRow,
  makeCronRow,
  makeRawStatusForSnapshot,
  makeRawStatusSnapshotRow,
  makeMinimalLiveStatusRows,
  buildStatusD1Scenario,
  cleanupStatusTest,
  fixtureMockD1,
  fixtureMakeApiRequest,
  fixtureMockFetch,
  fixtureCRON_INTERVALS,
  fixtureACTIVE_STABLECOINS,
  fixtureDependencyHealthModule,
};
