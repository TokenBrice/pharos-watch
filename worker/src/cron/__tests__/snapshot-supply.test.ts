import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

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

  it("does not consume the daily write marker when the cache predates the scheduled slot", async () => {
    const slotStartedAt = Math.floor(Date.parse("2025-06-15T08:00:00Z") / 1000);
    vi.setSystemTime(new Date(slotStartedAt * 1000));
    const staleForSlotUpdatedAt = slotStartedAt - 15 * 60;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } },
        { id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50_000_000 } },
      ],
    });
    const db = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [],
        first: { key: "stablecoins", value: cacheValue, updated_at: staleForSlotUpdatedAt },
      },
    ]);

    const result = await snapshotSupply(db, undefined, {
      minStablecoinsCacheUpdatedAtSec: slotStartedAt,
      freshnessGateLabel: "daily0800Utc",
    });

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      reason: "stablecoins_cache_before_slot",
      cacheUpdatedAt: staleForSlotUpdatedAt,
      requiredUpdatedAt: slotStartedAt,
      freshnessGateLabel: "daily0800Utc",
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"))).toBe(false);
    expect(db.getHistory().some((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds.includes("snapshot-supply:last-write")
    )).toBe(false);
  });

  it("treats a completed daily snapshot as neutral when the daily freshness gate sees an older cache", async () => {
    const slotStartedAt = Math.floor(Date.parse("2025-06-15T08:00:00Z") / 1000);
    const todaySnapshotDate = Math.floor(Date.UTC(2025, 5, 15) / 1000);
    vi.setSystemTime(new Date(slotStartedAt * 1000));
    const cacheUpdatedAt = slotStartedAt - 15 * 60;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } },
        { id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50_000_000 } },
      ],
    });
    const db = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [],
        first: { key: "stablecoins", value: cacheValue, updated_at: cacheUpdatedAt },
      },
      {
        match: "cache",
        matchBinds: ["snapshot-supply:last-write"],
        rows: [],
        first: {
          key: "snapshot-supply:last-write",
          value: JSON.stringify({
            snapshotDate: todaySnapshotDate,
            coverageVersion: 1,
            expectedActiveCount: 2,
            accountedActiveCount: 2,
            writtenRows: 2,
          }),
          updated_at: slotStartedAt - 60,
        },
      },
    ]);

    const result = await snapshotSupply(db, undefined, {
      minStablecoinsCacheUpdatedAtSec: slotStartedAt,
      freshnessGateLabel: "daily0800Utc",
    });

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      reason: "already_written_today_before_freshness_gate",
      snapshotDate: todaySnapshotDate,
      cacheUpdatedAt,
      requiredUpdatedAt: slotStartedAt,
      freshnessGateLabel: "daily0800Utc",
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"))).toBe(false);
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

  it("skips when today's UTC snapshot is already written", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const todaySnapshotDate = Math.floor(Date.UTC(2025, 5, 15) / 1000);
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } },
        { id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50_000_000 } },
      ],
    });
    const db = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [],
        first: { key: "stablecoins", value: cacheValue, updated_at: freshUpdatedAt },
      },
      {
        match: "cache",
        matchBinds: ["snapshot-supply:last-write"],
        rows: [],
        first: {
          key: "snapshot-supply:last-write",
          value: JSON.stringify({
            snapshotDate: todaySnapshotDate,
            coverageVersion: 1,
            expectedActiveCount: 2,
            accountedActiveCount: 2,
            writtenRows: 2,
          }),
          updated_at: freshUpdatedAt,
        },
      },
    ]);

    const result = await snapshotSupply(db);

    expect(result.itemCount).toBe(0);
    expect(JSON.parse(String(result.metadata))).toMatchObject({ reason: "already_written_today" });
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"))).toBe(false);
  });

  it("retries a same-day legacy marker that cannot prove exact coverage", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const todaySnapshotDate = Math.floor(Date.UTC(2025, 5, 15) / 1000);
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", price: 1, circulating: { peggedUSD: 100_000_000 } },
        { id: "usdc-circle", symbol: "USDC", price: 1, circulating: { peggedUSD: 50_000_000 } },
      ],
    });
    const db = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [{ key: "stablecoins", value: cacheValue, updated_at: freshUpdatedAt }],
      },
      {
        match: "cache",
        matchBinds: ["snapshot-supply:last-write"],
        rows: [{
          key: "snapshot-supply:last-write",
          value: JSON.stringify({ snapshotDate: todaySnapshotDate }),
          updated_at: freshUpdatedAt,
        }],
      },
    ]);

    const result = await snapshotSupply(db);

    expect(result.itemCount).toBe(2);
    expect(db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"))).toHaveLength(2);
    const markerWrite = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "snapshot-supply:last-write"
    );
    expect(JSON.parse(String(markerWrite?.binds[1]))).toMatchObject({
      snapshotDate: todaySnapshotDate,
      coverageVersion: 1,
      expectedActiveCount: 2,
      accountedActiveCount: 2,
      writtenRows: 2,
    });
  });

  it("writes after UTC midnight even when the previous write is under 20 hours old", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const yesterdaySnapshotDate = Math.floor(Date.UTC(2025, 5, 14) / 1000);
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } },
        { id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50_000_000 } },
      ],
    });
    const db = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [],
        first: { key: "stablecoins", value: cacheValue, updated_at: freshUpdatedAt },
      },
      {
        match: "cache",
        matchBinds: ["snapshot-supply:last-write"],
        rows: [],
        first: {
          key: "snapshot-supply:last-write",
          value: JSON.stringify({ snapshotDate: yesterdaySnapshotDate }),
          // Written 22:00 UTC yesterday — 10.5h ago, inside the old 20h cooldown
          updated_at: Math.floor(Date.now() / 1000) - 10.5 * 3600,
        },
      },
    ]);

    const result = await snapshotSupply(db);

    expect(result.itemCount).toBe(2);
  });

  it("blocks partial daily snapshots instead of writing a sparse day", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 30;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } },
      ],
    });
    const db = mockD1([{
      match: "cache",
      matchBinds: ["stablecoins"],
      rows: [],
      first: { key: "stablecoins", value: cacheValue, updated_at: freshUpdatedAt },
    }]);

    const result = await snapshotSupply(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      reason: "partial_snapshot_blocked",
      validRows: 1,
      expectedCount: 2,
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("snapshot-supply:last-write"))).toBe(false);
  });

  it("leaves the day retryable when the snapshot batch fails", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 30;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", price: 1, circulating: { peggedUSD: 100_000_000 } },
        { id: "usdc-circle", symbol: "USDC", price: 1, circulating: { peggedUSD: 50_000_000 } },
      ],
    });
    const db = mockD1([
      {
        match: "cache",
        rows: [],
        first: { key: "stablecoins", value: cacheValue, updated_at: freshUpdatedAt },
      },
      {
        match: "INSERT OR REPLACE INTO supply_history",
        rows: [],
        throwError: new Error("partial batch failure"),
      },
    ]);

    const result = await snapshotSupply(db);

    expect(result).toMatchObject({ status: "degraded", itemCount: 0 });
    expect(JSON.parse(String(result.metadata))).toMatchObject({ reason: "db_write_failed" });
    expect(db.getHistory().some((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "snapshot-supply:last-write"
    )).toBe(false);
  });
});
