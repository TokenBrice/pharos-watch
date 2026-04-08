import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_META_BY_ID: new Map(),
  TRACKED_STABLECOINS: [],
}));

vi.mock("@shared/lib/supply", () => ({
  sumPegBuckets: (c: Record<string, number> | undefined) => {
    if (!c) return 0;
    return Object.values(c).reduce((a, b) => a + b, 0);
  },
}));

import { snapshotChainSupply } from "../snapshot-chain-supply";

describe("snapshotChainSupply", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T08:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns degraded when cache is missing", async () => {
    const db = mockD1();
    const result = await snapshotChainSupply(db);
    expect(result.itemCount).toBe(0);
    expect(result.status).toBe("degraded");
  });

  it("normalizes chain display names through the canonical resolver before snapshotting", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {
            Ethereum: {
              current: 60,
              circulatingPrevDay: 60,
              circulatingPrevWeek: 60,
              circulatingPrevMonth: 60,
            },
            BSC: {
              current: 40,
              circulatingPrevDay: 40,
              circulatingPrevWeek: 40,
              circulatingPrevMonth: 40,
            },
            "Citrea Mainnet": {
              current: 10,
              circulatingPrevDay: 10,
              circulatingPrevWeek: 10,
              circulatingPrevMonth: 10,
            },
          },
          chains: ["ethereum", "bsc", "citrea"],
        },
      ],
    };
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const db = mockD1([{
      match: "cache",
      matchBinds: ["stablecoins"],
      rows: [],
      first: { key: "stablecoins", value: JSON.stringify(payload), updated_at: freshUpdatedAt },
    }]);
    const result = await snapshotChainSupply(db);
    expect(result.itemCount).toBe(3);

    const inserts = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO chain_supply_history"));
    expect(inserts).toHaveLength(3);
    expect(inserts.map((entry) => entry.binds[0])).toEqual(["ethereum", "bsc", "citrea"]);
    expect(inserts.map((entry) => entry.binds[2])).toEqual([60, 40, 10]);
    expect(inserts.map((entry) => entry.binds[3])).toEqual([1, 1, 1]);
  });

  it("returns degraded when the stablecoins cache produces no valid chain rows", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {},
          chains: [],
        },
      ],
    };
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const db = mockD1([{
      match: "cache",
      matchBinds: ["stablecoins"],
      rows: [],
      first: { key: "stablecoins", value: JSON.stringify(payload), updated_at: freshUpdatedAt },
    }]);

    const result = await snapshotChainSupply(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string };
    expect(metadata.reason).toBe("no-valid-chain-rows");
  });

  it("returns degraded when aborted", async () => {
    const db = mockD1();
    const controller = new AbortController();
    controller.abort();
    const result = await snapshotChainSupply(db, controller.signal);
    expect(result.status).toBe("degraded");
  });
});
