import { beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { PegSummaryCoin } from "@shared/types/market";

const setCacheMock = vi.hoisted(() => vi.fn());

vi.mock("../db-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db-cache")>()),
  setCache: setCacheMock,
}));

const { publishPegAnalyticsCache } = await import("../peg-analytics-cache");

const NOW_SEC = 1_783_891_200;
const TODAY_START_SEC = Math.floor(NOW_SEC / DAY_SECONDS) * DAY_SECONDS;

const pegRow = { id: "usdt-tether" } as unknown as PegSummaryCoin;

function snapshot(allEvents: Array<{ stablecoinId: string; startedAt: number }>) {
  return {
    nowSec: NOW_SEC,
    allEvents: allEvents as never,
    pegDataById: new Map([["usdt-tether", pegRow]]),
  };
}

describe("publishPegAnalyticsCache", () => {
  beforeEach(() => {
    setCacheMock.mockReset();
    setCacheMock.mockResolvedValue(undefined);
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
    expect(setCacheMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(setCacheMock.mock.calls[0]![2])).toEqual({
      computedAtSec: NOW_SEC,
      depegEventsToday: 1,
      depegEventsYesterday: 1,
      pegData: [pegRow],
    });
  });

  it("reports a failed publish instead of failing its caller", async () => {
    setCacheMock.mockRejectedValue(new Error("d1 unavailable"));

    await expect(publishPegAnalyticsCache({} as D1Database, snapshot([]))).resolves.toBe(false);
  });
});
