import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// Stub psi-eligible to avoid importing the full stablecoins list
vi.mock("../../../../src/lib/psi-eligible", () => ({
  PSI_ELIGIBLE_STABLECOINS: [
    { id: "1", symbol: "USDT" },
    { id: "2", symbol: "USDC" },
  ],
}));

// Stub supply helper
vi.mock("../../../../src/lib/supply", () => ({
  sumPegBuckets: (c: Record<string, number> | undefined) => {
    if (!c) return 0;
    return Object.values(c).reduce((a, b) => a + b, 0);
  },
}));

import { snapshotSupply } from "../snapshot-supply";

describe("snapshotSupply", () => {
  const nowSec = Math.floor(Date.now() / 1000);

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

  it("returns itemCount 0 when cache is stale (>1200s)", async () => {
    const staleUpdatedAt = Math.floor(Date.now() / 1000) - 1500;
    const cacheValue = JSON.stringify({
      peggedAssets: [{ id: "1", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
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
        { id: "1", price: 1.0, circulating: { peggedUSD: 100_000_000 } },
        { id: "2", price: 0.999, circulating: { peggedUSD: 50_000_000 } },
        { id: "99", price: 1.0, circulating: { peggedUSD: 10_000 } }, // not tracked
      ],
    });
    const db = mockD1([{
      match: "cache",
      rows: [],
      first: { key: "stablecoins", value: cacheValue, updated_at: freshUpdatedAt },
    }]);
    const result = await snapshotSupply(db);
    // Should insert 2 rows (IDs "1" and "2" are tracked, "99" is not)
    expect(result.itemCount).toBe(2);
  });

  it("skips assets with zero circulating supply", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 30;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "1", price: 1.0, circulating: { peggedUSD: 0 } },
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
