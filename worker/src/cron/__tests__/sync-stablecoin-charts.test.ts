import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "../../api/__tests__/helpers/mock-d1";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

import { syncStablecoinCharts } from "../sync-stablecoin-charts";

function makeRawChartPoints(count: number, nowSec: number): Array<{
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

function getCacheInsert(db: MockD1Database): { sql: string; binds: unknown[] } | undefined {
  return db
    .getHistory()
    .find((entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "stablecoin-charts");
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
    };
    expect(metadata.rawPoints).toBe(120);
    expect(metadata.downsampledPoints).toBeGreaterThan(0);

    const insert = getCacheInsert(db as MockD1Database);
    expect(insert).toBeDefined();
    expect(insert?.binds[0]).toBe("stablecoin-charts");

    const cached = JSON.parse(String(insert?.binds[1])) as Array<{ totalCirculatingUSD: Record<string, number> }>;
    expect(cached.length).toBeGreaterThan(0);
    expect(cached[0].totalCirculatingUSD.peggedUSD).toBeTypeOf("number");
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
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unexpected data length"));
    expect(getCacheInsert(db as MockD1Database)).toBeUndefined();
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
});
