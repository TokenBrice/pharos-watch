import { beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { PegSummaryCoin } from "@shared/types/market";

const cacheRows = vi.hoisted(() => new Map<string, { value: string; updatedAt: number }>());
const getCacheMock = vi.hoisted(() => vi.fn());
const setCacheIfNewerMock = vi.hoisted(() => vi.fn());

vi.mock("../db-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db-cache")>()),
  getCache: getCacheMock,
  setCacheIfNewer: setCacheIfNewerMock,
}));

const { loadPegAnalyticsCache, publishPegAnalyticsCache } = await import("../peg-analytics-cache");

const NOW_SEC = 1_783_891_200;
const TODAY_START_SEC = Math.floor(NOW_SEC / DAY_SECONDS) * DAY_SECONDS;

const pegRow = { id: "usdt-tether" } as unknown as PegSummaryCoin;

function snapshot(
  allEvents: Array<{ stablecoinId: string; startedAt: number }>,
  nowSec = NOW_SEC,
) {
  return {
    nowSec,
    allEvents: allEvents as never,
    pegDataById: new Map([["usdt-tether", pegRow]]),
  };
}

describe("publishPegAnalyticsCache", () => {
  beforeEach(() => {
    cacheRows.clear();
    getCacheMock.mockReset();
    getCacheMock.mockImplementation(async (_db: unknown, key: string) => cacheRows.get(key) ?? null);
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
      ]),
    );

    expect(published).toBe(true);
    expect(setCacheIfNewerMock).toHaveBeenCalledTimes(1);
    expect(setCacheIfNewerMock.mock.calls[0]![1]).toBe("peg-analytics");
    expect(setCacheIfNewerMock.mock.calls[0]![3]).toBe(NOW_SEC);
    expect(JSON.parse(setCacheIfNewerMock.mock.calls[0]![2])).toEqual({
      computedAtSec: NOW_SEC,
      depegEventsToday: 1,
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

  it("reports a failed publish instead of failing its caller", async () => {
    setCacheIfNewerMock.mockRejectedValue(new Error("d1 unavailable"));

    await expect(publishPegAnalyticsCache({} as D1Database, snapshot([]))).resolves.toBe(false);
  });
});
