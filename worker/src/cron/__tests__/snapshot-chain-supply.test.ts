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

  it("inserts rows for chains with supply", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {
            ethereum: { current: 60, circulatingPrevDay: 60, circulatingPrevWeek: 60, circulatingPrevMonth: 60 },
            bsc: { current: 40, circulatingPrevDay: 40, circulatingPrevWeek: 40, circulatingPrevMonth: 40 },
          },
          chains: ["ethereum", "bsc"],
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
    expect(result.itemCount).toBe(2); // ethereum + bsc
  });

  it("returns degraded when aborted", async () => {
    const db = mockD1();
    const controller = new AbortController();
    controller.abort();
    const result = await snapshotChainSupply(db, controller.signal);
    expect(result.status).toBe("degraded");
  });
});
