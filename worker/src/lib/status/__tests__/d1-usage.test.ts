import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../../test-helpers/__shared/mock-fetch";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import {
  D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY,
  getD1UsageSummary,
  refreshD1TableGrowthSnapshot,
} from "../d1-usage";

const CONFIG = {
  accountId: "acct-123",
  apiToken: "cf-token",
  databaseId: "db-123",
};

const NOW = 1_712_600_000;

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSuccessfulDatabaseInfo(result: Record<string, unknown> = {}) {
  return {
    match: "/d1/database/db-123",
    body: {
      success: true,
      result: {
        uuid: "db-123",
        name: "stablecoin-db",
        file_size: 1_589_248_000,
        num_tables: 56,
        region: "EEUR",
        read_replication: {
          mode: "disabled",
        },
        ...result,
      },
    },
  };
}

function mockSuccessfulAnalytics(groups: Array<Record<string, unknown>> = []) {
  return {
    match: "/graphql",
    body: {
      data: {
        viewer: {
          accounts: [{
            d1AnalyticsAdaptiveGroups: groups,
          }],
        },
      },
    },
  };
}

describe("getD1UsageSummary", () => {
  it("preserves the public summary shape for valid REST and GraphQL payloads", async () => {
    mockFetch([
      mockSuccessfulDatabaseInfo(),
      mockSuccessfulAnalytics([
        {
          sum: {
            readQueries: 900_000,
            writeQueries: 700_000,
            rowsRead: 1_600_000_000,
            rowsWritten: 1_500_000,
          },
        },
        {
          sum: {
            readQueries: 42_012,
            writeQueries: 9_241,
            rowsRead: 33_139_670,
            rowsWritten: 55_568,
          },
        },
      ]),
    ]);

    await expect(getD1UsageSummary(CONFIG, NOW)).resolves.toEqual({
      checkedAt: NOW,
      windowStart: NOW - 86_400,
      windowEnd: NOW,
      databaseId: "db-123",
      databaseName: "stablecoin-db",
      databaseSizeBytes: 1_589_248_000,
      numTables: 56,
      region: "EEUR",
      readReplicationMode: "disabled",
      readQueries24h: 942_012,
      writeQueries24h: 709_241,
      rowsRead24h: 1_633_139_670,
      rowsWritten24h: 1_555_568,
      capacity: {
        observedAt: NOW,
        databaseSizeBytes: 1_589_248_000,
        maximumSizeBytes: 10_000_000_000,
        utilizationRatio: 0.158925,
        utilizationPercent: 15.89,
        thresholdState: "normal",
        crossedThresholdPercent: null,
        nextThresholdPercent: 60,
        sampleCount: 1,
        forecastBasis: "insufficient-history",
        forecastSpanHours: 0,
        growthBytesPerDay: null,
        growthWindows: [
          {
            window: "24h",
            windowSeconds: 86_400,
            sampleCount: 1,
            spanHours: 0,
            valid: false,
            growthBytesPerDay: null,
          },
          {
            window: "72h",
            windowSeconds: 259_200,
            sampleCount: 1,
            spanHours: 0,
            valid: false,
            growthBytesPerDay: null,
          },
          {
            window: "7d",
            windowSeconds: 604_800,
            sampleCount: 1,
            spanHours: 0,
            valid: false,
            growthBytesPerDay: null,
          },
          {
            window: "30d",
            windowSeconds: 2_592_000,
            sampleCount: 1,
            spanHours: 0,
            valid: false,
            growthBytesPerDay: null,
          },
        ],
        conservativeWindow: null,
        nextThresholdAt: null,
        exhaustionAt: null,
        daysUntilExhaustion: null,
      },
      tableGrowth: null,
    });
  });

  it("handles REST success with missing optional database fields intentionally", async () => {
    mockFetch([
      {
        match: "/d1/database/db-123",
        body: {
          success: true,
          result: {},
        },
      },
      mockSuccessfulAnalytics([]),
    ]);

    await expect(getD1UsageSummary(CONFIG, NOW)).resolves.toMatchObject({
      databaseId: "db-123",
      databaseName: null,
      databaseSizeBytes: null,
      numTables: null,
      region: null,
      readReplicationMode: null,
      readQueries24h: 0,
      writeQueries24h: 0,
      rowsRead24h: 0,
      rowsWritten24h: 0,
      capacity: null,
      tableGrowth: null,
    });
  });

  it("fails clearly when GraphQL returns errors", async () => {
    mockFetch([
      mockSuccessfulDatabaseInfo(),
      {
        match: "/graphql",
        body: {
          errors: [{ message: "D1 analytics quota exceeded" }],
          data: {
            viewer: {
              accounts: [{
                d1AnalyticsAdaptiveGroups: [],
              }],
            },
          },
        },
      },
    ]);

    await expect(getD1UsageSummary(CONFIG, NOW)).rejects.toThrow("D1 analytics quota exceeded");
  });

  it("fails clearly when REST reports an unsuccessful envelope", async () => {
    mockFetch([
      {
        match: "/d1/database/db-123",
        body: {
          success: false,
          errors: [{ message: "database token rejected" }],
        },
      },
      mockSuccessfulAnalytics([]),
    ]);

    await expect(getD1UsageSummary(CONFIG, NOW)).rejects.toThrow("database token rejected");
  });

  it("fails clearly when GraphQL analytics nodes are missing", async () => {
    mockFetch([
      mockSuccessfulDatabaseInfo(),
      {
        match: "/graphql",
        body: {
          data: {
            viewer: {
              accounts: [{}],
            },
          },
        },
      },
    ]);

    await expect(getD1UsageSummary(CONFIG, NOW)).rejects.toThrow(
      "Cloudflare D1 analytics response was missing d1AnalyticsAdaptiveGroups",
    );
  });

  it("fails clearly when GraphQL analytics metrics are malformed", async () => {
    mockFetch([
      mockSuccessfulDatabaseInfo(),
      mockSuccessfulAnalytics([
        {
          sum: {
            readQueries: "not-a-number",
          },
        },
      ]),
    ]);

    await expect(getD1UsageSummary(CONFIG, NOW)).rejects.toThrow(
      "Cloudflare D1 analytics sum.readQueries must be a finite number when present",
    );
  });

  it("fails clearly when Cloudflare returns invalid JSON", async () => {
    mockFetch([
      {
        match: "/d1/database/db-123",
        body: "not-json",
      },
      mockSuccessfulAnalytics([]),
    ]);

    await expect(getD1UsageSummary(CONFIG, NOW)).rejects.toThrow(
      "Cloudflare D1 database info fetch failed: invalid JSON response",
    );
  });
});

describe("refreshD1TableGrowthSnapshot", () => {
  it("records bounded per-table rows, deltas, timestamps, and top growers", async () => {
    const previousSnapshot = {
      version: 1,
      snapshot: {
        checkedAt: NOW - 86_400,
        utcDay: NOW - 86_400,
        previousCheckedAt: null,
        tables: [
          {
            tableName: "cron_runs",
            rowCount: 10,
            previousRowCount: null,
            rowCountDelta: null,
            oldestTimestamp: NOW - 20_000,
            newestTimestamp: NOW - 10_000,
          },
          {
            tableName: "supply_history",
            rowCount: 100,
            previousRowCount: null,
            rowCountDelta: null,
            oldestTimestamp: NOW - 30_000,
            newestTimestamp: NOW - 10_000,
          },
        ],
        topGrowers: [],
      },
    };
    const db = mockD1([
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY],
        rows: [{
          key: D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY,
          value: JSON.stringify(previousSnapshot),
          updated_at: NOW - 86_400,
        }],
      },
      {
        match: "FROM sqlite_master",
        rows: [{ name: "cron_runs" }, { name: "supply_history" }],
      },
      {
        match: 'FROM "cron_runs"',
        rows: [{ row_count: 15, oldest_timestamp: NOW - 21_000, newest_timestamp: NOW - 1_000 }],
      },
      {
        match: 'FROM "supply_history"',
        rows: [{ row_count: 120, oldest_timestamp: NOW - 31_000, newest_timestamp: NOW - 500 }],
      },
    ], { requireMatch: true });

    await expect(refreshD1TableGrowthSnapshot(db, NOW)).resolves.toEqual({
      checkedAt: NOW,
      utcDay: Math.floor(NOW / 86_400) * 86_400,
      previousCheckedAt: NOW - 86_400,
      tables: [
        {
          tableName: "cron_runs",
          rowCount: 15,
          previousRowCount: 10,
          rowCountDelta: 5,
          oldestTimestamp: NOW - 21_000,
          newestTimestamp: NOW - 1_000,
        },
        {
          tableName: "supply_history",
          rowCount: 120,
          previousRowCount: 100,
          rowCountDelta: 20,
          oldestTimestamp: NOW - 31_000,
          newestTimestamp: NOW - 500,
        },
      ],
      topGrowers: [
        { tableName: "supply_history", rowCount: 120, rowCountDelta: 20 },
        { tableName: "cron_runs", rowCount: 15, rowCountDelta: 5 },
      ],
    });
    expect(db.getHistory().filter((entry) => entry.sql.includes("FROM \""))).toHaveLength(2);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("uses the UTC-day marker to avoid rerunning the snapshot", async () => {
    const cachedSnapshot = {
      version: 1,
      snapshot: {
        checkedAt: NOW,
        utcDay: Math.floor(NOW / 86_400) * 86_400,
        previousCheckedAt: NOW - 86_400,
        tables: [],
        topGrowers: [],
      },
    };
    const db = mockD1([
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY],
        rows: [{
          key: D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY,
          value: JSON.stringify(cachedSnapshot),
          updated_at: NOW,
        }],
      },
    ], { requireMatch: true });

    await expect(refreshD1TableGrowthSnapshot(db, NOW + 3_600)).resolves.toEqual(cachedSnapshot.snapshot);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM sqlite_master"))).toBe(false);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });
});
