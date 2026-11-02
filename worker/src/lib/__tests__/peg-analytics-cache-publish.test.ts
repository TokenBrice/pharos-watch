import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { PegSummaryCoin } from "@shared/types/peg";
import {
  getCacheJsonParseFailureCountersForTests,
  resetCacheJsonParseFailureCountersForTests,
} from "../api-cache-read";

const cacheRows = vi.hoisted(() => new Map<string, { value: string; updatedAt: number }>());
const getCacheMock = vi.hoisted(() => vi.fn());
const setCacheIfNewerMock = vi.hoisted(() => vi.fn());
const deleteCacheMock = vi.hoisted(() => vi.fn());

vi.mock("../db-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db-cache")>()),
  getCache: getCacheMock,
  setCacheIfNewer: setCacheIfNewerMock,
  deleteCache: deleteCacheMock,
}));

const { loadPegAnalyticsCache, publishPegAnalyticsCache } = await import("../peg-analytics-cache");

const NOW_SEC = 1_783_891_200;
const TODAY_START_SEC = Math.floor(NOW_SEC / DAY_SECONDS) * DAY_SECONDS;

const pegRow = {
  id: "usdt-tether",
  symbol: "USDT",
  name: "Tether",
  pegType: "peggedUSD",
  pegCurrency: "USD",
  governance: "centralized",
  currentDeviationBps: 0,
  pegScore: 99,
  pegPct: 99.9,
  severityScore: 7,
  spreadPenalty: 2,
  eventCount: 1,
  worstDeviationBps: -120,
  activeDepeg: false,
  lastEventAt: NOW_SEC - DAY_SECONDS,
  trackingSpanDays: 400,
  methodologyVersion: "6.08",
} satisfies PegSummaryCoin;

function validPayload(computedAtSec = NOW_SEC): string {
  return JSON.stringify({
    computedAtSec,
    depegEventsToday: 0,
    depegEventsYesterday: 0,
    pegData: [pegRow],
  });
}

function snapshot(
  allEvents: Array<{ stablecoinId: string; startedAt: number; provenance?: { auditVerdict: string } | null }>,
  nowSec = NOW_SEC,
) {
  return {
    nowSec,
    allEvents: allEvents as never,
    pegDataById: new Map([["usdt-tether", pegRow]]),
  };
}

describe("publishPegAnalyticsCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    resetCacheJsonParseFailureCountersForTests();
    cacheRows.clear();
    getCacheMock.mockReset();
    getCacheMock.mockImplementation(async (_db: unknown, key: string) => cacheRows.get(key) ?? null);
    deleteCacheMock.mockReset();
    deleteCacheMock.mockImplementation(async (_db: unknown, key: string) => {
      cacheRows.delete(key);
    });
    setCacheIfNewerMock.mockReset();
    setCacheIfNewerMock.mockImplementation(async (
      _db: unknown,
      key: string,
      value: string,
      updatedAt: number,
    ) => {
      const existing = cacheRows.get(key);
      if (existing && existing.updatedAt > updatedAt) {
        return { written: false, skippedBecauseNewer: true };
      }
      cacheRows.set(key, { value, updatedAt });
      return { written: true, skippedBecauseNewer: false };
    });
  });

  it("counts today's and yesterday's depeg events and excludes NAV tokens", async () => {
    const published = await publishPegAnalyticsCache(
      {} as D1Database,
      snapshot([
        { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC + 60 },
        { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC - 60 },
        { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC - DAY_SECONDS - 60 },
        // NAV tokens have no fixed peg and never enter the depeg counters.
        { stablecoinId: "scrvusd-curve", startedAt: TODAY_START_SEC + 60 },
        // Reviewed disputes are not public event counts; a null verdict keeps counting.
        { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC + 120, provenance: { auditVerdict: "disputed" } },
        { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC - 120, provenance: { auditVerdict: "false_positive" } },
        { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC + 180, provenance: null },
      ]),
    );

    expect(published).toBe(true);
    expect(setCacheIfNewerMock).toHaveBeenCalledTimes(1);
    expect(setCacheIfNewerMock.mock.calls[0]![1]).toBe("peg-analytics");
    expect(setCacheIfNewerMock.mock.calls[0]![3]).toBe(NOW_SEC);
    expect(JSON.parse(setCacheIfNewerMock.mock.calls[0]![2])).toEqual({
      computedAtSec: NOW_SEC,
      depegEventsToday: 2,
      depegEventsYesterday: 1,
      pegData: [pegRow],
    });
  });
  it("keeps a newer snapshot when an older run publishes late", async () => {
    const db = {} as D1Database;
    await publishPegAnalyticsCache(db, snapshot([], NOW_SEC));
    await publishPegAnalyticsCache(db, snapshot([], NOW_SEC + 900));
    await publishPegAnalyticsCache(db, snapshot([], NOW_SEC));

    const loaded = await loadPegAnalyticsCache(db, { maxAgeMs: Number.MAX_SAFE_INTEGER });
    expect(loaded.kind).toBe("ok");
    if (loaded.kind === "ok") {
      expect(loaded.payload.computedAtSec).toBe(NOW_SEC + 900);
    }
  });
  it("records malformed cache JSON through the shared parse-failure counter", async () => {
    cacheRows.set("peg-analytics", { value: "{bad-json", updatedAt: NOW_SEC });

    await expect(
      loadPegAnalyticsCache({} as D1Database, { maxAgeMs: Number.MAX_SAFE_INTEGER }),
    ).resolves.toEqual({ kind: "miss", reason: "json-parse-failed" });
    expect(getCacheJsonParseFailureCountersForTests()["peg-analytics:peg-analytics"]?.count).toBe(1);
  });

  it("reports a failed publish instead of failing its caller", async () => {
    setCacheIfNewerMock.mockRejectedValue(new Error("d1 unavailable"));

    await expect(publishPegAnalyticsCache({} as D1Database, snapshot([]))).resolves.toBe(false);
  });

  it("rejects a row whose peg data predates the published coin shape", async () => {
    cacheRows.set("peg-analytics", {
      value: JSON.stringify({
        computedAtSec: NOW_SEC,
        depegEventsToday: 0,
        depegEventsYesterday: 0,
        pegData: [{ id: "usdt-tether" }],
      }),
      updatedAt: NOW_SEC,
    });

    await expect(
      loadPegAnalyticsCache({} as D1Database, { maxAgeMs: Number.MAX_SAFE_INTEGER }),
    ).resolves.toEqual({ kind: "miss", reason: "invalid-payload" });
  });

  it("rejects day-scoped counters published on a previous UTC day", async () => {
    const publishedAtSec = Date.parse("2026-07-12T23:46:00Z") / 1000;
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-07-13T00:05:00Z"));
    cacheRows.set("peg-analytics", {
      value: validPayload(publishedAtSec),
      updatedAt: publishedAtSec,
    });

    await expect(
      loadPegAnalyticsCache({} as D1Database, { requireCurrentUtcDay: true }),
    ).resolves.toEqual({ kind: "miss", reason: "stale-day" });
    // The day scope is opt-in: callers that only read the non-day-scoped rows
    // (the OG renderer) still accept the same generation.
    await expect(
      loadPegAnalyticsCache({} as D1Database, { maxAgeMs: Infinity }),
    ).resolves.toMatchObject({ kind: "ok" });
  });

  it("rejects and clears a future-dated row so the next publish can write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const futureSec = NOW_SEC + 86_400;
    cacheRows.set("peg-analytics", { value: validPayload(NOW_SEC), updatedAt: futureSec });

    await expect(
      loadPegAnalyticsCache({} as D1Database, { maxAgeMs: Infinity }),
    ).resolves.toEqual({ kind: "miss", reason: "future-timestamp" });
    expect(deleteCacheMock).toHaveBeenCalledWith(expect.anything(), "peg-analytics");

    await expect(publishPegAnalyticsCache({} as D1Database, snapshot([], NOW_SEC))).resolves.toBe(true);
    expect(cacheRows.get("peg-analytics")?.updatedAt).toBe(NOW_SEC);
  });
});
