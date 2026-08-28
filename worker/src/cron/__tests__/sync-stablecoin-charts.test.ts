import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 as createMockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

import { syncStablecoinCharts } from "../sync-stablecoin-charts";
import { STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS } from "../../lib/stablecoin-charts-reconciliation";

const DEFAULT_CHART_D1_TABLES: MockTableConfig[] = [
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  { match: "INSERT OR IGNORE INTO cache", rows: [], runMeta: { changes: 1 } },
  { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
  {
    match: "UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
    rows: [],
    runMeta: { changes: 1 },
  },
  { match: "FROM supply_history", rows: [] },
];

function mockD1(tables: MockTableConfig[] = []): MockD1Database {
  return createMockD1([...tables, ...DEFAULT_CHART_D1_TABLES]);
}

function makeRawChartPoints(
  count: number,
  nowSec: number,
): Array<{
  date: number;
  totalCirculating: Record<string, number>;
  totalCirculatingUSD: Record<string, number>;
}> {
  return Array.from({ length: count }, (_, i) => {
    const date = nowSec - (count - i) * 86_400;
    const circ = 1_000_000 + i * 1_000;
    return {
      date,
      totalCirculating: { peggedUSD: circ },
      totalCirculatingUSD: { peggedUSD: circ },
    };
  });
}

function makeRawChartPointsWithStringDates(
  count: number,
  nowSec: number,
): Array<{
  date: string;
  totalCirculating: Record<string, number>;
  totalCirculatingUSD: Record<string, number>;
}> {
  return makeRawChartPoints(count, nowSec).map((point) => ({
    ...point,
    date: String(point.date),
  }));
}

function getCacheInsert(db: MockD1Database): { sql: string; binds: unknown[] } | undefined {
  return db
    .getHistory()
    .find((entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "stablecoin-charts");
}

function getCadenceCompletion(db: MockD1Database): { sql: string; binds: unknown[] } | undefined {
  return db
    .getHistory()
    .find(
      (entry) =>
        entry.sql.includes("UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
        && entry.binds[2] === "stablecoin-charts:cadence"
        && String(entry.binds[0]).includes('\"state\":\"completed\"'),
    );
}

describe("syncStablecoinCharts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes transformed chart payload to cache on happy path", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockFetch([
      {
        match: "stablecoincharts/all",
        body: makeRawChartPoints(120, nowSec),
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedUSD: 1 }),
          updated_at: nowSec,
        },
      },
    ]);

    const result = await syncStablecoinCharts(db);

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBeGreaterThan(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      rawPoints: number;
      downsampledPoints: number;
      cacheWriteMode: string;
      casSkipped: boolean;
    };
    expect(metadata.rawPoints).toBe(120);
    expect(metadata.downsampledPoints).toBeGreaterThan(0);
    expect(metadata.cacheWriteMode).toBe("published");
    expect(metadata.casSkipped).toBe(false);

    const insert = getCacheInsert(db as MockD1Database);
    expect(insert).toBeDefined();
    expect(insert?.binds[0]).toBe("stablecoin-charts");

    const cached = JSON.parse(String(insert?.binds[1])) as Array<{ totalCirculatingUSD: Record<string, number> }>;
    expect(cached.length).toBeGreaterThan(0);
    expect(cached[0].totalCirculatingUSD.peggedUSD).toBeTypeOf("number");
    expect(getCadenceCompletion(db as MockD1Database)).toBeDefined();
  });

  it("coerces upstream string dates before writing the cached chart payload", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockFetch([
      {
        match: "stablecoincharts/all",
        body: makeRawChartPointsWithStringDates(120, nowSec),
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedUSD: 1 }),
          updated_at: nowSec,
        },
      },
    ]);

    const result = await syncStablecoinCharts(db);

    expect(result.status).toBeUndefined();
    const insert = getCacheInsert(db as MockD1Database);
    const cached = JSON.parse(String(insert?.binds[1])) as Array<{
      date: number;
      totalCirculatingUSD: Record<string, number>;
    }>;
    expect(cached.length).toBeGreaterThan(0);
    expect(typeof cached[0]?.date).toBe("number");
  });

  it("merges structural supplemental supply-history overlays into the cached chart payload", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockFetch([
      {
        match: "stablecoincharts/all",
        body: makeRawChartPoints(120, nowSec),
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedUSD: 1 }),
          updated_at: nowSec,
        },
      },
      {
        match: "FROM supply_history",
        rows: [
          {
            stablecoin_id: "susds-sky",
            snapshot_date: nowSec - 30 * 86_400,
            circulating_usd: 25,
          },
          {
            stablecoin_id: "usg-tangent",
            snapshot_date: nowSec - 30 * 86_400,
            circulating_usd: 13,
          },
          {
            stablecoin_id: "paxg-paxos",
            snapshot_date: nowSec - 30 * 86_400,
            circulating_usd: 7,
          },
        ],
      },
    ]);

    const result = await syncStablecoinCharts(db);
    expect(result.status).toBeUndefined();
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      supplementalHistoryChunks: number;
      supplementalHistoryMaxBindCount: number;
    };
    // Chunked at the 90-bind limit; the config size drives how many chunks the
    // supplemental supply-history query splits into.
    expect(metadata.supplementalHistoryChunks).toBe(
      Math.ceil(STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS.length / 90),
    );
    expect(metadata.supplementalHistoryMaxBindCount).toBeLessThanOrEqual(90);

    const supplyHistoryQueries = (db as MockD1Database)
      .getHistory()
      .filter((entry) => entry.sql.includes("FROM supply_history"));
    expect(supplyHistoryQueries.length).toBe(metadata.supplementalHistoryChunks);
    expect(Math.max(...supplyHistoryQueries.map((entry) => entry.binds.length))).toBeLessThanOrEqual(90);
    expect(supplyHistoryQueries.flatMap((entry) => entry.binds)).not.toContain("susds-sky");

    const insert = getCacheInsert(db as MockD1Database);
    const cached = JSON.parse(String(insert?.binds[1])) as Array<{
      date: number;
      totalCirculatingUSD: Record<string, number>;
    }>;
    const recentPoint = cached.find((point) => point.totalCirculatingUSD.peggedGOLD === 7);
    const targetPoint = cached.find((point) => point.date === nowSec - 30 * 86_400);

    expect(recentPoint?.totalCirculatingUSD.peggedUSD).toBeGreaterThan(25);
    expect(recentPoint?.totalCirculatingUSD.peggedGOLD).toBe(7);
    expect(targetPoint?.totalCirculatingUSD.peggedUSD).toBe(1_090_013);
  });

  it("returns degraded status when DefiLlama API fails", async () => {
    mockFetch([
      {
        match: "stablecoincharts/all",
        body: { error: "upstream unavailable" },
        status: 500,
      },
    ]);

    const db = mockD1();
    const result = await syncStablecoinCharts(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string; apiStatus: number | null };
    expect(metadata.reason).toBe("DL API unavailable");
    expect(metadata.apiStatus).toBe(500);
    expect(getCacheInsert(db as MockD1Database)).toBeUndefined();
  });

  it("returns degraded and avoids cache write on invalid payload shape", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch([
      {
        match: "stablecoincharts/all",
        body: [{ date: 1, totalCirculatingUSD: { peggedUSD: 1 } }],
      },
    ]);

    const db = mockD1();
    const result = await syncStablecoinCharts(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string; rawLength: number };
    expect(metadata.reason).toBe("DL API payload too small");
    expect(metadata.rawLength).toBe(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "defillama-payload-too-small",
      job: "sync-stablecoin-charts",
      level: "error",
      message: "Unexpected data length; skipping cache write",
      metadata: { rawLength: 1 },
    });
    expect(getCacheInsert(db as MockD1Database)).toBeUndefined();
  });

  it("returns degraded and preserves cache when downsampled output is too small", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockFetch([
      {
        match: "stablecoincharts/all",
        body: Array.from({ length: 120 }, () => ({
          date: nowSec - 60,
          totalCirculating: { peggedUSD: 1_000_000 },
          totalCirculatingUSD: { peggedUSD: 1_000_000 },
        })),
      },
    ]);

    const db = mockD1();
    const result = await syncStablecoinCharts(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string; downsampledPoints: number };
    expect(metadata.reason).toBe("downsampled-payload-too-small");
    expect(metadata.downsampledPoints).toBeLessThan(10);
    expect(getCacheInsert(db as MockD1Database)).toBeUndefined();
  });

  it("does not advance the last-write marker when a CAS skip cannot confirm a newer canonical chart cache", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockFetch([
      {
        match: "stablecoincharts/all",
        body: makeRawChartPoints(120, nowSec),
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedUSD: 1 }),
          updated_at: nowSec,
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoin-charts"],
        rows: [],
        first: null,
      },
      {
        match: "INSERT INTO cache",
        rows: [],
        runMeta: { changes: 0 },
      },
    ]);

    const result = await syncStablecoinCharts(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      cacheWriteMode: string;
      casSkipped: boolean;
      lastWriteAdvanced: boolean;
      canonicalReadbackUpdatedAt: number | null;
      cadence: { completed: boolean; retryable: boolean };
    };
    expect(metadata.cacheWriteMode).toBe("skipped-newer");
    expect(metadata.casSkipped).toBe(true);
    expect(metadata.lastWriteAdvanced).toBe(false);
    expect(metadata.canonicalReadbackUpdatedAt).toBeNull();
    expect(metadata.cadence).toMatchObject({ completed: false, retryable: true });
    expect(getCadenceCompletion(db as MockD1Database)).toBeUndefined();
  });

  it("advances the last-write marker after CAS skip only when readback confirms newer canonical chart cache", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockFetch([
      {
        match: "stablecoincharts/all",
        body: makeRawChartPoints(120, nowSec),
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedUSD: 1 }),
          updated_at: nowSec,
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoin-charts"],
        rows: [],
        first: {
          value: "[]",
          updated_at: nowSec + 5,
        },
      },
      {
        match: "INSERT INTO cache",
        rows: [],
        runMeta: { changes: 0 },
      },
    ]);

    const result = await syncStablecoinCharts(db);

    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      lastWriteAdvanced: boolean;
      canonicalReadbackUpdatedAt: number | null;
    };
    expect(metadata.lastWriteAdvanced).toBe(true);
    expect(metadata.canonicalReadbackUpdatedAt).toBe(nowSec + 5);
    expect(getCadenceCompletion(db as MockD1Database)).toBeDefined();
  });

  it("skips FX-based repair when the source freshness is stale even if usable sync is fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockFetch([
      {
        match: "stablecoincharts/all",
        body: [
          ...makeRawChartPoints(119, nowSec),
          {
            date: nowSec - 60,
            totalCirculating: { peggedEUR: 100 },
            totalCirculatingUSD: { peggedEUR: 10_000 },
          },
        ],
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedEUR: 1.08 }),
          updated_at: nowSec - 60,
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: {
          value: JSON.stringify({
            usableSyncAt: nowSec - 60,
            mode: "cached-fallback",
            sourceUpdatedAtByPeg: { peggedEUR: nowSec - 9 * 3600 },
            sourceModeByPeg: { peggedEUR: "cached" },
            sourceCadenceByPeg: { peggedEUR: "intraday" },
            consecutiveFallbackRuns: 2,
          }),
          updated_at: nowSec - 60,
        },
      },
    ]);

    const result = await syncStablecoinCharts(db);
    expect(result.itemCount).toBeGreaterThan(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as { fxFixes: number };
    expect(metadata.fxFixes).toBe(0);
  });

  it("does not rewrite older historical points with the current FX rate", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldPointDate = nowSec - 400 * 86_400;
    mockFetch([
      {
        match: "stablecoincharts/all",
        body: [
          ...makeRawChartPoints(119, nowSec),
          {
            date: oldPointDate,
            totalCirculating: { peggedEUR: 100 },
            totalCirculatingUSD: { peggedEUR: 500 },
          },
        ],
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedEUR: 1.08 }),
          updated_at: nowSec,
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: {
          value: JSON.stringify({
            usableSyncAt: nowSec,
            mode: "live",
            sourceUpdatedAtByPeg: { peggedEUR: nowSec },
            sourceModeByPeg: { peggedEUR: "live" },
            sourceCadenceByPeg: { peggedEUR: "intraday" },
            consecutiveFallbackRuns: 0,
          }),
          updated_at: nowSec,
        },
      },
    ]);

    const result = await syncStablecoinCharts(db);
    expect(result.itemCount).toBeGreaterThan(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as { fxFixes: number };
    expect(metadata.fxFixes).toBe(0);

    const insert = getCacheInsert(db as MockD1Database);
    const cached = JSON.parse(String(insert?.binds[1])) as Array<{
      date: number;
      totalCirculatingUSD: Record<string, number>;
    }>;
    const oldPoint = cached.find((point) => point.date === oldPointDate);
    expect(oldPoint?.totalCirculatingUSD.peggedEUR).toBe(500);
  });
});
