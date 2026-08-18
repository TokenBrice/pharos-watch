import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  buildFreshnessMeta,
  buildCacheStatuses,
  getLatestSuccessfulCronTimestamp,
  getLatestSuccessfulCronTimestampResult,
} from "../api-freshness";
import { addFreshnessHeaders } from "../api-freshness-headers";
import {
  API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC,
  measureFreshnessAge,
} from "../api-freshness-age";

describe("public freshness clock skew", () => {
  it("clamps public age and degrades timestamps beyond the explicit future-skew allowance", () => {
    const nowSec = 1_800_000_000;
    const updatedAt = nowSec + API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC + 1;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    try {
      expect(measureFreshnessAge(nowSec, updatedAt, API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC)).toEqual({
        ageSeconds: 0,
        futureSkewSeconds: API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC + 1,
      });
      expect(buildFreshnessMeta(updatedAt, 60)).toEqual({
        updatedAt,
        ageSeconds: 0,
        status: "degraded",
      });
      expect(addFreshnessHeaders({ "Cache-Control": "public, max-age=60" }, updatedAt, 60)).toEqual({
        "Cache-Control": "no-store",
        "X-Data-Age": "0",
        Warning: `199 - "Response timestamp is ${API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC + 1}s in the future"`,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("tolerates bounded producer clock skew while keeping the public age nonnegative", () => {
    const nowSec = 1_800_000_000;
    const updatedAt = nowSec + API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    try {
      expect(buildFreshnessMeta(updatedAt, 60)).toMatchObject({ ageSeconds: 0, status: "fresh" });
      expect(addFreshnessHeaders({}, updatedAt, 60)).toEqual({ "X-Data-Age": "0" });
    } finally {
      nowSpy.mockRestore();
    }
  });
});

function cacheRow(key: string, updatedAt: number, value: unknown = {}): { key: string; updated_at: number; value: string } {
  return {
    key,
    updated_at: updatedAt,
    value: JSON.stringify(value),
  };
}

function sentinelRow(
  key: "dex-liquidity" | "yield-data" | "dews",
  updatedAt: number,
  overrides: Record<string, unknown> = {},
): { key: string; updated_at: number; value: string } {
  const sourceByKey = {
    "dex-liquidity": "sync-dex-liquidity",
    "yield-data": "sync-yield-data",
    dews: "compute-dews",
  };
  return cacheRow(`freshness:${key}`, updatedAt, {
    updatedAt,
    source: sourceByKey[key],
    publishStatus: "ok",
    ...overrides,
  });
}

function dewsPublicationPointerRow(updatedAt: number) {
  return cacheRow("dews:published-generation", updatedAt, {
    updatedAt,
    source: "compute-dews",
    publishStatus: "published",
    coverageVersion: 2,
    expectedRowCount: 2,
    stablecoinIdsDigest: "a".repeat(64),
  });
}

describe("getLatestSuccessfulCronTimestampResult", () => {
  it("returns ok when a successful cron run exists", async () => {
    const db = mockD1([
      {
        match: "MAX(started_at) as started_at FROM cron_runs",
        rows: [],
        first: { started_at: 1_700_000_000 },
      },
    ]);

    await expect(getLatestSuccessfulCronTimestampResult(db, "sync-yield-data")).resolves.toEqual({
      timestamp: 1_700_000_000,
      status: "ok",
    });
  });

  it("returns missing when no successful cron run exists", async () => {
    const db = mockD1([
      {
        match: "MAX(started_at) as started_at FROM cron_runs",
        rows: [],
        first: { started_at: null },
      },
    ]);

    await expect(getLatestSuccessfulCronTimestampResult(db, "sync-yield-data")).resolves.toEqual({
      timestamp: null,
      status: "missing",
    });
  });

  it("returns lookup_failed when the cron query throws", async () => {
    const db = mockD1([
      {
        match: "MAX(started_at) as started_at FROM cron_runs",
        rows: [],
        throwError: new Error("boom"),
      },
    ]);

    await expect(getLatestSuccessfulCronTimestampResult(db, "sync-yield-data")).resolves.toEqual({
      timestamp: null,
      status: "lookup_failed",
    });
  });
});

describe("getLatestSuccessfulCronTimestamp", () => {
  it("falls back when the lookup result is missing", async () => {
    const db = mockD1([
      {
        match: "MAX(started_at) as started_at FROM cron_runs",
        rows: [],
        first: { started_at: null },
      },
    ]);

    await expect(getLatestSuccessfulCronTimestamp(db, "sync-yield-data", 123)).resolves.toBe(123);
  });
});

describe("buildCacheStatuses sentinel validation", () => {
  it("uses valid freshness sentinels without hot-table fallback queries", async () => {
    const now = 1_800_000_000;
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          cacheRow("stablecoins", now - 60),
          cacheRow("stablecoin-charts", now - 60),
          cacheRow("usds-status", now - 60),
          cacheRow("fx-rates", now - 60, { peggedEUR: 1.08 }),
          cacheRow("bluechip-ratings", now - 60),
          sentinelRow("dex-liquidity", now - 120),
          sentinelRow("yield-data", now - 180),
          sentinelRow("dews", now - 240),
        ],
      },
      { match: "GROUP BY job", rows: [] },
    ]);

    const { caches, diagnostics, warnings } = await buildCacheStatuses(db, now);

    expect(caches["dex-liquidity"]).toMatchObject({
      ageSeconds: 120,
      freshnessSource: "freshness-sentinel",
    });
    expect(caches["yield-data"]).toMatchObject({
      ageSeconds: 180,
      freshnessSource: "freshness-sentinel",
    });
    expect(caches.dews).toMatchObject({
      ageSeconds: 240,
      freshnessSource: "freshness-sentinel",
    });
    expect(diagnostics).toEqual([]);
    expect(warnings).toEqual([]);
    const history = db.getHistory().map((entry) => entry.sql);
    expect(history.some((sql) => sql.includes("FROM dex_liquidity"))).toBe(false);
    expect(history.some((sql) => sql.includes("FROM yield_data"))).toBe(false);
    expect(history.some((sql) => sql.includes("FROM stress_signals"))).toBe(false);
  });

  it("falls back to table freshness when a sentinel has the wrong producer source", async () => {
    const now = 1_800_000_000;
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          cacheRow("stablecoins", now - 60),
          cacheRow("stablecoin-charts", now - 60),
          cacheRow("usds-status", now - 60),
          cacheRow("fx-rates", now - 60, { peggedEUR: 1.08 }),
          cacheRow("bluechip-ratings", now - 60),
          sentinelRow("dex-liquidity", now - 120, { source: "sync-yield-data" }),
          sentinelRow("yield-data", now - 180),
          sentinelRow("dews", now - 240),
        ],
      },
      { match: "GROUP BY job", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 45 } },
    ]);

    const { caches, diagnostics, warnings } = await buildCacheStatuses(db, now);

    expect(caches["dex-liquidity"]).toMatchObject({
      ageSeconds: 45,
      freshnessSource: "table-fallback",
      sentinelValidationReason: "wrong-source",
      warning: "dex-liquidity: freshness sentinel invalid (wrong-source); using table-fallback",
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        key: "dex-liquidity",
        freshnessSource: "table-fallback",
        sentinelValidationReason: "wrong-source",
      }),
    ]);
    expect(warnings).toContain("dex-liquidity: freshness sentinel invalid (wrong-source); using table-fallback");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM dex_liquidity"))).toBe(true);
  });

  it("falls back to cron freshness when a malformed sentinel and table freshness both fail", async () => {
    const now = 1_800_000_000;
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          cacheRow("stablecoins", now - 60),
          cacheRow("stablecoin-charts", now - 60),
          cacheRow("usds-status", now - 60),
          cacheRow("fx-rates", now - 60, { peggedEUR: 1.08 }),
          cacheRow("bluechip-ratings", now - 60),
          { key: "freshness:dex-liquidity", updated_at: now - 120, value: "{bad-json" },
          sentinelRow("yield-data", now - 180),
          sentinelRow("dews", now - 240),
        ],
      },
      { match: "GROUP BY job", rows: [{ job: "sync-dex-liquidity", started_at: now - 300 }] },
      { match: "dex_liquidity", rows: [], throwError: new Error("table unavailable") },
    ]);

    const { caches, diagnostics, warnings } = await buildCacheStatuses(db, now);

    expect(caches["dex-liquidity"]).toMatchObject({
      ageSeconds: 300,
      freshnessSource: "cron-fallback",
      sentinelValidationReason: "malformed-json",
      warning: "dex-liquidity: freshness sentinel invalid (malformed-json); using cron-fallback",
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        key: "dex-liquidity",
        freshnessSource: "cron-fallback",
        failureSource: "table-freshness",
        sentinelValidationReason: "malformed-json",
      }),
    ]);
    expect(warnings).toContain("dex-liquidity: freshness sentinel invalid (malformed-json); using cron-fallback");
  });

  it("uses the DEWS publication pointer instead of partial stress-signal rows", async () => {
    const now = 1_800_000_000;
    const publishedAt = now - 420;
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          cacheRow("stablecoins", now - 60),
          cacheRow("stablecoin-charts", now - 60),
          cacheRow("usds-status", now - 60),
          cacheRow("fx-rates", now - 60, { peggedEUR: 1.08 }),
          cacheRow("bluechip-ratings", now - 60),
          sentinelRow("dex-liquidity", now - 120),
          sentinelRow("yield-data", now - 180),
          sentinelRow("dews", now - 240, { source: "wrong-producer" }),
        ],
      },
      { match: "GROUP BY job", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [dewsPublicationPointerRow(publishedAt)],
      },
    ]);

    const { caches, diagnostics, warnings } = await buildCacheStatuses(db, now);

    expect(caches.dews).toMatchObject({
      ageSeconds: 420,
      freshnessSource: "table-fallback",
      sentinelValidationReason: "wrong-source",
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      key: "dews",
      freshnessSource: "table-fallback",
    }));
    expect(warnings).toContain("dews: freshness sentinel invalid (wrong-source); using table-fallback");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
  });

  it("keeps yield-data healthy through one missed hourly publish (<= 2x availability budget)", async () => {
    const now = 1_800_000_000;
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          cacheRow("stablecoins", now - 60),
          cacheRow("stablecoin-charts", now - 60),
          cacheRow("usds-status", now - 60),
          cacheRow("fx-rates", now - 60, { peggedEUR: 1.08 }),
          cacheRow("bluechip-ratings", now - 60),
          sentinelRow("dex-liquidity", now - 120),
          // 1800s = 1x the half-hourly budget: one missed publish stays healthy.
          sentinelRow("yield-data", now - 1_800),
          sentinelRow("dews", now - 240),
        ],
      },
      { match: "GROUP BY job", rows: [] },
    ]);

    const { caches, statusFloor } = await buildCacheStatuses(db, now);

    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 1_800, healthy: true });
    expect(statusFloor).toBe("healthy");
  });

  it("degrades yield-data past 2x its half-hourly budget while other caches stay fresh", async () => {
    const now = 1_800_000_000;
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          cacheRow("stablecoins", now - 60),
          cacheRow("stablecoin-charts", now - 60),
          cacheRow("usds-status", now - 60),
          cacheRow("fx-rates", now - 60, { peggedEUR: 1.08 }),
          cacheRow("bluechip-ratings", now - 60),
          sentinelRow("dex-liquidity", now - 120),
          // ~2.06x the half-hourly budget: two missed publishes -> public-unhealthy.
          sentinelRow("yield-data", now - 3_700),
          sentinelRow("dews", now - 240),
        ],
      },
      { match: "GROUP BY job", rows: [] },
    ]);

    const { caches, statusFloor } = await buildCacheStatuses(db, now);

    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 3_700, healthy: false });
    expect(statusFloor).toBe("degraded");
  });

  it("fails closed when DEWS publication evidence is missing even if cron history is fresh", async () => {
    const now = 1_800_000_000;
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          cacheRow("stablecoins", now - 60),
          cacheRow("stablecoin-charts", now - 60),
          cacheRow("usds-status", now - 60),
          cacheRow("fx-rates", now - 60, { peggedEUR: 1.08 }),
          cacheRow("bluechip-ratings", now - 60),
          sentinelRow("dex-liquidity", now - 120),
          sentinelRow("yield-data", now - 180),
          { key: "freshness:dews", updated_at: now - 240, value: "{bad-json" },
        ],
      },
      { match: "GROUP BY job", rows: [{ job: "compute-dews", started_at: now - 30 }] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [],
        first: null,
      },
    ]);

    const { caches, failures, statusFloor } = await buildCacheStatuses(db, now);

    expect(caches.dews?.ageSeconds).toBeNull();
    expect(caches.dews?.freshnessSource).toBeUndefined();
    expect(failures).toContainEqual(expect.objectContaining({
      key: "dews",
      source: "table-freshness",
      message: expect.stringContaining("no-pointer"),
    }));
    expect(statusFloor).toBe("stale");
  });
});
