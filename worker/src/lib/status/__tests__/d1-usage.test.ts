import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../../test-helpers/__shared/mock-fetch";
import { getD1UsageSummary } from "../d1-usage";

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
        nextThresholdAt: null,
        exhaustionAt: null,
        daysUntilExhaustion: null,
      },
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
