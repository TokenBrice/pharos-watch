import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// Stub psi-eligible to avoid importing the full stablecoins list
vi.mock("@shared/lib/psi-eligible", () => ({
  PSI_ELIGIBLE_STABLECOINS: [
    { id: "usdt-tether", symbol: "USDT" },
    { id: "usdc-circle", symbol: "USDC" },
  ],
}));

// Stub supply helper
vi.mock("@shared/lib/supply", () => ({
  sumPegBuckets: (c: Record<string, number> | undefined) => {
    if (!c) return 0;
    return Object.values(c).reduce((a, b) => a + b, 0);
  },
}));

import { snapshotSupply } from "../snapshot-supply";

describe("snapshotSupply", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T08:30:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns itemCount 0 when cache is missing", async () => {
    const db = mockD1();
    const result = await snapshotSupply(db);
    expect(result.itemCount).toBe(0);
  });

  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("snapshot supply aborted"));

    await expect(snapshotSupply(mockD1(), controller.signal)).rejects.toThrow("snapshot supply aborted");
  });

  it("returns itemCount 0 when cache is stale (>1200s)", async () => {
    const staleUpdatedAt = Math.floor(Date.now() / 1000) - 1500;
    const cacheValue = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = mockD1([{
      match: "cache",
      rows: [],
      first: { key: "stablecoins", value: cacheValue, updated_at: staleUpdatedAt },
    }]);
    const result = await snapshotSupply(db);
    expect(result.itemCount).toBe(0);
  });

  it("inserts rows for tracked assets with valid supply", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } },
        { id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50_000_000 } },
        { id: "cash-stabl-fi", symbol: "CASH", price: 1.0, circulating: { peggedUSD: 10_000 } }, // not tracked
      ],
    });
    const db = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [],
        first: { key: "stablecoins", value: cacheValue, updated_at: freshUpdatedAt },
      },
    ]);
    const result = await snapshotSupply(db);
    // Should insert 2 rows (IDs "usdt-tether" and "usdc-circle" are tracked, "cash-stabl-fi" is not)
    expect(result.itemCount).toBe(2);
  });

  it("skips assets with zero circulating supply", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 30;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 0 } },
      ],
    });
    const db = mockD1([{
      match: "cache",
      rows: [],
      first: { key: "stablecoins", value: cacheValue, updated_at: freshUpdatedAt },
    }]);
    const result = await snapshotSupply(db);
    expect(result.itemCount).toBe(0);
  });
});
