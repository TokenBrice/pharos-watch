import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { D1CapacityAssessment } from "@shared/types/status";
import {
  D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY,
  getD1UsageSummary,
  refreshD1TableGrowthSnapshot,
} from "../d1-usage";
import { refreshD1CapacityMonitoring } from "../d1-capacity-monitor";

const capacityMocks = vi.hoisted(() => ({ getD1CapacityAssessmentFromCloudflare: vi.fn() }));

// Partial: the summary/growth cases above still exercise the real ../d1-usage.
vi.mock("../d1-usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../d1-usage")>()),
  getD1CapacityAssessmentFromCloudflare: capacityMocks.getD1CapacityAssessmentFromCloudflare,
}));

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
        hourlyMinMax24h: {
          windowSeconds: 86_400,
          sampleCount: 1,
          minDatabaseSizeBytes: 1_589_248_000,
          maxDatabaseSizeBytes: 1_589_248_000,
          swingBytes: 0,
        },
      },
      quota: {
        rowsRead: {
          observed24h: 1_633_139_670,
          projectedMonthly: 48_994_190_100,
          includedMonthlyAllowance: 25_000_000_000,
          utilizationPercent: 195.98,
          thresholdState: "warning",
          crossedThresholdPercent: 95,
          nextThresholdPercent: null,
        },
        rowsWritten: {
          observed24h: 1_555_568,
          projectedMonthly: 46_667_040,
          includedMonthlyAllowance: 50_000_000,
          utilizationPercent: 93.33,
          thresholdState: "watch",
          crossedThresholdPercent: 80,
          nextThresholdPercent: 95,
        },
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
      quota: {
        rowsRead: {
          observed24h: 0,
          projectedMonthly: 0,
          includedMonthlyAllowance: 25_000_000_000,
          utilizationPercent: 0,
          thresholdState: "normal",
          crossedThresholdPercent: null,
          nextThresholdPercent: 80,
        },
        rowsWritten: {
          observed24h: 0,
          projectedMonthly: 0,
          includedMonthlyAllowance: 50_000_000,
          utilizationPercent: 0,
          thresholdState: "normal",
          crossedThresholdPercent: null,
          nextThresholdPercent: 80,
        },
      },
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

  it("keeps a present-but-null analytics metric unavailable instead of a zero-volume claim", async () => {
    mockFetch([
      mockSuccessfulDatabaseInfo(),
      mockSuccessfulAnalytics([
        {
          sum: {
            readQueries: null,
            writeQueries: null,
            rowsRead: null,
            rowsWritten: null,
          },
        },
      ]),
    ]);

    await expect(getD1UsageSummary(CONFIG, NOW)).resolves.toMatchObject({
      readQueries24h: null,
      writeQueries24h: null,
      rowsRead24h: null,
      rowsWritten24h: null,
      quota: {
        rowsRead: {
          observed24h: null,
          projectedMonthly: null,
          utilizationPercent: null,
          thresholdState: "unavailable",
          crossedThresholdPercent: null,
          nextThresholdPercent: null,
        },
        rowsWritten: {
          observed24h: null,
          projectedMonthly: null,
          utilizationPercent: null,
          thresholdState: "unavailable",
          crossedThresholdPercent: null,
          nextThresholdPercent: null,
        },
      },
    });
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
  it.each([
    ["keeps", 50 * 3_600, true],
    ["drops", 50 * 3_600 + 1, false],
  ] as const)("%s a cached table-growth snapshot at the 50-hour age gate", async (_label, ageSec, expected) => {
    mockFetch([
      mockSuccessfulDatabaseInfo({ file_size: null }),
      mockSuccessfulAnalytics([]),
    ]);
    const snapshot = {
      checkedAt: NOW - ageSec,
      utcDay: Math.floor((NOW - ageSec) / 86_400) * 86_400,
      previousCheckedAt: null,
      tables: [],
      topGrowers: [],
      failedTables: [],
    };
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: [D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY],
      rows: [{
        key: D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY,
        value: JSON.stringify({ version: 1, snapshot }),
        updated_at: snapshot.checkedAt,
      }],
    }]);

    const summary = await getD1UsageSummary(CONFIG, NOW, db);

    expect(summary.tableGrowth).toEqual(expected ? snapshot : null);
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
    ]);

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
      failedTables: [],
    });
    expect(db.getHistory().filter((entry) => entry.sql.includes("FROM \""))).toHaveLength(2);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("uses the cached UTC-day snapshot to avoid rerunning measurement", async () => {
    const cachedSnapshot = {
      version: 1,
      snapshot: {
        checkedAt: NOW,
        utcDay: Math.floor(NOW / 86_400) * 86_400,
        previousCheckedAt: NOW - 86_400,
        tables: [],
        topGrowers: [],
        failedTables: [],
      },
    };
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY],
        rows: [{
          key: D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY,
          value: JSON.stringify(cachedSnapshot),
          updated_at: NOW,
        }],
      },
    ]);

    await expect(refreshD1TableGrowthSnapshot(db, NOW + 3_600)).resolves.toEqual(cachedSnapshot.snapshot);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM sqlite_master"))).toBe(false);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("rejects malformed cached table-growth rows instead of returning cast data", async () => {
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
          value: JSON.stringify({
            version: 1,
            snapshot: {
              checkedAt: NOW,
              utcDay: Math.floor(NOW / 86_400) * 86_400,
              previousCheckedAt: null,
              tables: [{
                tableName: "supply_history",
                rowCount: "poisoned",
                previousRowCount: null,
                rowCountDelta: null,
                oldestTimestamp: null,
                newestTimestamp: null,
              }],
              topGrowers: [],
            },
          }),
          updated_at: NOW,
        }],
      },
      {
        match: "FROM sqlite_master",
        rows: [],
      },
    ]);

    await expect(refreshD1TableGrowthSnapshot(db, NOW)).resolves.toMatchObject({
      checkedAt: NOW,
      tables: [],
      topGrowers: [],
      failedTables: [],
    });
  });

  it.each([undefined, "invalid", "0", -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "marks malformed census counts as failed without losing valid zero (%s)",
    async (rowCount) => {
      const db = mockD1([
        { match: "INSERT INTO cache (key, value, updated_at)", rows: [], runMeta: { changes: 1 } },
        { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
        { match: "FROM sqlite_master", rows: [{ name: "cron_runs" }, { name: "supply_history" }, { name: "cache" }] },
        { match: 'FROM "cron_runs"', rows: [], first: rowCount === undefined ? null : { row_count: rowCount } },
        { match: 'FROM "supply_history"', rows: [{ row_count: 0 }] },
        { match: 'FROM "cache"', rows: [{ row_count: 3 }] },
      ]);
      const snapshot = await refreshD1TableGrowthSnapshot(db, NOW);
      expect(snapshot?.failedTables).toEqual(["cron_runs"]);
      expect(snapshot?.tables).toEqual([
        { tableName: "supply_history", rowCount: 0, previousRowCount: null, rowCountDelta: null, oldestTimestamp: null, newestTimestamp: null },
        { tableName: "cache", rowCount: 3, previousRowCount: null, rowCountDelta: null, oldestTimestamp: null, newestTimestamp: null },
      ]);
      expect(() => db.assertAllMatchesUsed()).not.toThrow();
    },
  );

});

describe("refreshD1TableGrowthSnapshot census resilience", () => {
  const fixtures = createLatestSchemaFixtureTracker();
  afterEach(() => fixtures.closeAll());

  const DAY_SEC = 86_400;

  function cachedSnapshot(checkedAt: number, rowCount: number) {
    const utcDay = Math.floor(checkedAt / DAY_SEC) * DAY_SEC;
    return JSON.stringify({
      version: 1,
      snapshot: {
        checkedAt,
        utcDay,
        previousCheckedAt: null,
        tables: [{
          tableName: "supply_history",
          rowCount,
          previousRowCount: null,
          rowCountDelta: null,
          oldestTimestamp: null,
          newestTimestamp: null,
        }],
        topGrowers: [],
      },
    });
  }


  it("isolates a table measurement failure in the published snapshot", async () => {
    const observedAt = 1_800_000_000;
    const { db } = fixtures.open();
    let failMeasurement = true;
    const flakyDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes('FROM "supply_history"')) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== "first") {
                return Reflect.get(statementTarget, statementProperty, statementReceiver);
              }
              return async () => {
                if (failMeasurement) {
                  failMeasurement = false;
                  throw new Error("measurement failed");
                }
                return statementTarget.first();
              };
            },
          });
        };
      },
    }) as D1Database;

    const snapshot = await refreshD1TableGrowthSnapshot(flakyDb, observedAt);

    expect(snapshot?.checkedAt).toBe(observedAt);
    expect(snapshot?.failedTables).toEqual(["supply_history"]);
    expect(snapshot?.tables.some((row) => row.tableName === "supply_history")).toBe(false);
  });

  it("nulls deltas and excludes growers when the baseline is three days old", async () => {
    const observedAt = 1_800_000_000;
    const previousCheckedAt = observedAt - 3 * DAY_SEC;
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY,
      cachedSnapshot(previousCheckedAt, 1),
      previousCheckedAt,
    );

    const snapshot = await refreshD1TableGrowthSnapshot(db, observedAt);
    const supplyHistory = snapshot?.tables.find((row) => row.tableName === "supply_history");

    expect(supplyHistory?.previousRowCount).toBe(1);
    expect(supplyHistory?.rowCountDelta).toBeNull();
    expect(snapshot?.topGrowers.some((row) => row.tableName === "supply_history")).toBe(false);
  });

  it.each([null, undefined, "invalid", "0", -1, 0.5, NaN, Infinity])(
    "rejects invalid row counts in a mixed SQLite census (%s)",
    async (rowCount) => {
      const { db } = fixtures.open();
      const invalidDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "prepare") return Reflect.get(target, property, receiver);
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('FROM "supply_history"')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty, statementReceiver) {
                if (statementProperty !== "first") return Reflect.get(statementTarget, statementProperty, statementReceiver);
                return async () => rowCount === undefined ? null : { row_count: rowCount };
              },
            });
          };
        },
      }) as D1Database;
      const snapshot = await refreshD1TableGrowthSnapshot(invalidDb, 1_800_000_000);
      expect(snapshot?.failedTables).toEqual(["supply_history"]);
      expect(snapshot?.tables.some((row) => row.tableName === "supply_history")).toBe(false);
      expect(snapshot?.tables.find((row) => row.tableName === "cron_runs")?.rowCount).toBe(0);
    },
  );

  it("preserves observed zero, negative deltas and nullable timestamps", async () => {
    const observedAt = 1_800_000_000;
    const { db, sqlite } = fixtures.open();
    const previousCheckedAt = observedAt - DAY_SEC;
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY, cachedSnapshot(previousCheckedAt, 3), previousCheckedAt,
    );
    const snapshot = await refreshD1TableGrowthSnapshot(db, observedAt);
    expect(snapshot?.tables.find((row) => row.tableName === "supply_history")).toMatchObject({
      rowCount: 0, previousRowCount: 3, rowCountDelta: -3, oldestTimestamp: null, newestTimestamp: null,
    });
    expect(snapshot?.failedTables).toEqual([]);
    expect(snapshot?.topGrowers).toEqual([]);
  });
});

function assessment(overrides: Partial<D1CapacityAssessment> = {}): D1CapacityAssessment {
  return {
    observedAt: 1_783_661_028,
    databaseSizeBytes: 4_000_000_000,
    maximumSizeBytes: 10_000_000_000,
    utilizationRatio: 0.4,
    utilizationPercent: 40,
    thresholdState: "normal",
    crossedThresholdPercent: null,
    nextThresholdPercent: 60,
    sampleCount: 72,
    forecastBasis: "linear-30d",
    forecastSpanHours: 71,
    growthBytesPerDay: 100_000_000,
    nextThresholdAt: 1_800_941_028,
    exhaustionAt: 1_835_501_028,
    daysUntilExhaustion: 600,
    ...overrides,
  };
}

describe("refreshD1CapacityMonitoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps capacity telemetry available without an alert side effect", async () => {
    const expected = assessment();
    capacityMocks.getD1CapacityAssessmentFromCloudflare.mockResolvedValue(expected);

    await expect(refreshD1CapacityMonitoring({} as D1Database, {} as never, 1_783_661_028)).resolves.toEqual({
      assessment: expected,
      error: null,
    });
  });

  it("returns capacity-observation failure telemetry without alert reporting", async () => {
    capacityMocks.getD1CapacityAssessmentFromCloudflare.mockRejectedValue(new Error("control plane unavailable"));

    await expect(refreshD1CapacityMonitoring({} as D1Database, {} as never, 1_783_661_028)).resolves.toEqual({
      assessment: null,
      error: "control plane unavailable",
    });
  });
});
