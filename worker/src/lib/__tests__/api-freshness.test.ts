import { describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { freshnessDb } from "./api-freshness.test-support";
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
  it("ignores newer non-best yield sources when measuring fallback freshness", async () => {
    const now = 1_800_000_000;
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare(`INSERT INTO yield_data
        (stablecoin_id, source_key, symbol, current_apy, apy_7d, apy_30d,
         yield_source, yield_type, data_source, is_best, updated_at)
        VALUES ('usdc-circle', ?, 'USDC', 4, 4, 4, 'lending', 'lending', 'defillama', ?, ?)`);
      insert.run("best", 1, now - 600);
      insert.run("alternative", 0, now - 10);

      const { caches } = await buildCacheStatuses(db, now);
      expect(caches["yield-data"]).toMatchObject({
        ageSeconds: 600,
        freshnessSource: "table-fallback",
      });

      sqlite.exec("UPDATE yield_data SET is_best = 0");
      const withoutBest = await buildCacheStatuses(db, now);
      expect(withoutBest.caches["yield-data"].ageSeconds).toBeNull();
    } finally {
      sqlite.close();
    }
  });

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
      producerJob: "sync-dex-liquidity",
      producerIntervalSec: 3600,
      endpointMaxAge: 14400,
      availabilityMaxAge: 43200,
    });
    expect(caches["yield-data"]).toMatchObject({
      ageSeconds: 180,
      freshnessSource: "freshness-sentinel",
      producerJob: "sync-yield-data",
      producerIntervalSec: 3600,
      endpointMaxAge: 3600,
      availabilityMaxAge: 3600,
    });
    expect(caches.dews).toMatchObject({
      ageSeconds: 240,
      freshnessSource: "freshness-sentinel",
      producerJob: "compute-dews",
      producerIntervalSec: 1800,
      endpointMaxAge: 1800,
      availabilityMaxAge: 1800,
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

  it("degrades yield-data past 2x its hourly budget while other caches stay fresh", async () => {
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
          // ~2.06x the hourly budget: two missed publishes -> public-unhealthy.
          sentinelRow("yield-data", now - 7_400),
          sentinelRow("dews", now - 240),
        ],
      },
      { match: "GROUP BY job", rows: [] },
    ]);

    const { caches, statusFloor } = await buildCacheStatuses(db, now);

    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 7_400, healthy: false });
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

  it("reports a table-query failure when cron timestamps rescue a missing sentinel", async () => {
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
          // No freshness:dex-liquidity sentinel row at all: the fallback path
          // must surface the table failure, not a sentinel validation reason.
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
      warning: "dex-liquidity: freshness table query failed; using cron fallback",
    });
    expect(diagnostics).toContainEqual({
      key: "dex-liquidity",
      freshnessSource: "cron-fallback",
      warning: "dex-liquidity: freshness table query failed; using cron fallback",
      failureSource: "table-freshness",
    });
    expect(warnings).toContain("dex-liquidity: freshness table query failed; using cron fallback");
  });

  it("escalates the global floor to stale when yield-data blows past its override ceiling", async () => {
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
          // ~5.5x the hourly budget: past the yield-data override stale
          // ceiling (4x), so the per-cache override escalates the floor.
          sentinelRow("yield-data", now - 20_000),
          sentinelRow("dews", now - 240),
        ],
      },
      { match: "GROUP BY job", rows: [] },
    ]);

    const { caches, statusFloor } = await buildCacheStatuses(db, now);

    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 20_000, healthy: false });
    expect(statusFloor).toBe("stale");
  });
});

describe("buildCacheStatuses", () => {
  it("ignores an unknown provider instead of evaluating its freshness", async () => {
    const nowSec = 1_800_000_000;
    const unknownProviderKey = "unknown-provider";
    const db = freshnessDb({
      cacheRows: [
        cacheRow("stablecoins", nowSec - 60),
        cacheRow("stablecoin-charts", nowSec - 60),
        cacheRow("usds-status", nowSec - 60),
        cacheRow("fx-rates", nowSec - 60, { peggedEUR: 1.08 }),
        cacheRow("bluechip-ratings", nowSec - 60),
        sentinelRow("dex-liquidity", nowSec - 60),
        sentinelRow("yield-data", nowSec - 60),
        sentinelRow("dews", nowSec - 60),
        cacheRow(unknownProviderKey, nowSec - 86_400),
      ],
    });

    const { caches, statusFloor } = await buildCacheStatuses(db, nowSec);

    expect(caches).not.toHaveProperty(unknownProviderKey);
    expect(statusFloor).toBe("healthy");
  });

  it("uses table timestamps for table-backed datasets and the publication pointer for DEWS", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = freshnessDb({ tableAge: 120, pointer: dewsPublicationPointerRow(nowSec - 120) });

    const { caches } = await buildCacheStatuses(db, nowSec);
    const seenSql = db.getHistory().map((entry) => entry.sql);
    expect(caches["dex-liquidity"]).toMatchObject({ ageSeconds: 120, freshnessSource: "table-fallback" });
    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 120, freshnessSource: "table-fallback" });
    expect(caches.dews?.ageSeconds).toBe(120);
    expect(seenSql.some((sql) => sql.includes("FROM stress_signals"))).toBe(false);
  });


  it("clamps negative table ages to zero without accepting a future DEWS table row", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = freshnessDb({ tableAge: -30 });

    const { caches } = await buildCacheStatuses(db, nowSec);
    expect(caches["dex-liquidity"]?.ageSeconds).toBe(0);
    expect(caches["yield-data"]?.ageSeconds).toBe(0);
    expect(caches.dews?.ageSeconds).toBeNull();
  });

  it("reports missing DEWS publication evidence instead of throwing", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = freshnessDb({ tableAge: 60 });

    const { caches, failures } = await buildCacheStatuses(db, nowSec);
    expect(caches.dews?.ageSeconds).toBeNull();
    expect(failures).toEqual([
      {
        key: "dews",
        source: "table-freshness",
        message: "DEWS published generation unavailable (no-pointer): publication pointer is missing",
      },
    ]);
  });

  it("does not let producer cron timestamps replace missing DEWS publication evidence", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = freshnessDb({ cronRows: [{ job: "compute-dews", started_at: nowSec - 300 }] });

    const { caches, diagnostics, failures, warnings } = await buildCacheStatuses(db, nowSec);
    expect(caches.dews?.ageSeconds).toBeNull();
    expect(caches.dews?.warning).toBeUndefined();
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ key: "dews" }));
    expect(failures).toEqual([
      {
        key: "dews",
        source: "table-freshness",
        message: "DEWS published generation unavailable (no-pointer): publication pointer is missing",
      },
    ]);
    expect(warnings).not.toContain("dews: freshness table query failed; using cron fallback");
  });

  it("uses table fallback warnings when the cache lookup fails", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const db = freshnessDb({ tableAge: 45, cacheError: new Error("cache lookup failed") });

      const { caches, diagnostics, failures, warnings } = await buildCacheStatuses(db, nowSec);

      expect(caches["dex-liquidity"]?.ageSeconds).toBe(45);
      expect(caches["dex-liquidity"]?.warning).toBe(
        "dex-liquidity: freshness sentinel lookup failed; using table fallback",
      );
      expect(diagnostics).toContainEqual({
        key: "dex-liquidity",
        freshnessSource: "table-fallback",
        warning: "dex-liquidity: freshness sentinel lookup failed; using table fallback",
        failureSource: "cache-table",
      });
      expect(failures).toContainEqual({
        key: "__cache__",
        source: "cache-table",
        message: "cache lookup failed",
      });
      expect(warnings).toContain("dex-liquidity: freshness sentinel lookup failed; using table fallback");
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("[api-freshness] dex-liquidity: freshness sentinel lookup failed; using table fallback"),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("uses cron fallback warnings when cache lookup fails and table freshness is unavailable", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const db = freshnessDb({
        cacheError: new Error("cache lookup failed"),
        cronRows: [
          { job: "sync-dex-liquidity", started_at: nowSec - 90 },
          { job: "sync-yield-data", started_at: nowSec - 120 },
          { job: "compute-dews", started_at: nowSec - 150 },
        ],
      });

      const { caches, diagnostics, failures, warnings } = await buildCacheStatuses(db, nowSec);

      expect(caches["dex-liquidity"]?.ageSeconds).toBe(90);
      expect(caches["dex-liquidity"]?.warning).toBe(
        "dex-liquidity: freshness sentinel lookup failed; using cron fallback",
      );
      expect(diagnostics).toContainEqual({
        key: "dex-liquidity",
        freshnessSource: "cron-fallback",
        warning: "dex-liquidity: freshness sentinel lookup failed; using cron fallback",
        failureSource: "cache-table",
      });
      expect(failures).toContainEqual({
        key: "__cache__",
        source: "cache-table",
        message: "cache lookup failed",
      });
      expect(warnings).toContain("dex-liquidity: freshness sentinel lookup failed; using cron fallback");
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("[api-freshness] dex-liquidity: freshness sentinel lookup failed; using cron fallback"),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("records cron fallback failures when both table and producer fallback lookups are unavailable", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = freshnessDb({ cronError: new Error("cron lookup failed") });

      const { failures } = await buildCacheStatuses(db, nowSec);

      expect(failures).toContainEqual({
        key: "dex-liquidity",
        source: "cron-fallback",
        message: "cron lookup failed",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[api-freshness] Failed to read producer cron fallbacks"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("uses fx-rates-meta usableSyncAt for cache freshness and keeps cadence-aware source warnings separate", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = freshnessDb({
      tableAge: 60,
      pointer: dewsPublicationPointerRow(nowSec - 60),
      cacheRows: [
        cacheRow("stablecoins", nowSec - 60),
        cacheRow("stablecoin-charts", nowSec - 60),
        cacheRow("usds-status", nowSec - 60),
        cacheRow("fx-rates", nowSec - 60, { peggedEUR: 1.08 }),
        cacheRow("fx-rates-meta", nowSec - 30, {
          usableSyncAt: nowSec - 180,
          mode: "cached-fallback",
          sourceUpdatedAtByPeg: { peggedEUR: nowSec - 8 * 3600 },
          sourceModeByPeg: { peggedEUR: "cached" },
          sourceCadenceByPeg: { peggedEUR: "intraday" },
          consecutiveFallbackRuns: 4,
        }),
        cacheRow("bluechip-ratings", nowSec - 60),
      ],
    });

    const { caches, statusFloor, warnings } = await buildCacheStatuses(db, nowSec);

    expect(caches["fx-rates"]?.ageSeconds).toBe(180);
    expect(caches["fx-rates"]?.mode).toBe("cached-fallback");
    expect(caches["fx-rates"]?.sourceStatus).toBe("degraded");
    expect(caches["fx-rates"]?.consecutiveFallbackRuns).toBe(4);
    expect(statusFloor).toBe("degraded");
    expect(warnings[0]).toContain("cached fallback FX rates");
  });
});
