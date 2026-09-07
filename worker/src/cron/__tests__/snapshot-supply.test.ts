import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  buildSupplySnapshotCompletionMarker,
  makeSupplySnapshotDb,
  makeSnapshotAsset,
} from "./snapshot-cron.test-support";

const mockD1 = makeSupplySnapshotDb;

vi.mock("@shared/lib/stablecoins/worker-runtime-registry", () => ({
  WORKER_ACTIVE_IDS: new Set(["usdt-tether", "usdc-circle"]),
  WORKER_ACTIVE_STABLECOINS: [
    { id: "usdt-tether", symbol: "USDT" },
    { id: "usdc-circle", symbol: "USDC" },
  ],
}));

vi.mock("@shared/lib/shadow-stablecoins", () => ({
  SHADOW_IDS: new Set(["eurt-test"]),
}));

// Stub supply helper
vi.mock("@shared/lib/supply", () => ({
  getCirculatingRaw: (asset: { circulating?: Record<string, number> }) => {
    const c = asset.circulating;
    if (!c) return 0;
    return Object.values(c).reduce((a, b) => a + b, 0);
  },
}));

import { snapshotSupply } from "../snapshot-supply";
import type { StablecoinPublicationWaiver } from "../../lib/stablecoin-publication-coverage";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

const DEFAULT_REQUIRED_IDS = ["usdt-tether", "usdc-circle"] as const;

const completionMarker = buildSupplySnapshotCompletionMarker;

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

  it("skips the snapshot once the cache is older than two producer intervals (>1800s)", async () => {
    const staleUpdatedAt = Math.floor(Date.now() / 1000) - 1801;
    const cacheValue = JSON.stringify({
      peggedAssets: [makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } })],
    });
    const db = mockD1({ stablecoins: { assets: cacheValue, updatedAt: staleUpdatedAt } });
    const result = await snapshotSupply(db);
    expect(result.itemCount).toBe(0);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ reason: "cache_stale" });
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"))).toBe(false);
  });

  it("still snapshots a cache age of 1799s (boundary below the two-interval skip gate)", async () => {
    const boundaryUpdatedAt = Math.floor(Date.now() / 1000) - 1799;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }),
        makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50_000_000 } }),
      ],
    });
    const db = mockD1({ stablecoins: { assets: cacheValue, updatedAt: boundaryUpdatedAt } });
    const result = await snapshotSupply(db);
    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(2);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"))).toBe(true);
  });

  it("does not consume the daily write marker when the cache predates the scheduled slot", async () => {
    const slotStartedAt = Math.floor(Date.parse("2025-06-15T08:00:00Z") / 1000);
    vi.setSystemTime(new Date(slotStartedAt * 1000));
    const staleForSlotUpdatedAt = slotStartedAt - 15 * 60;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }),
        makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50_000_000 } }),
      ],
    });
    const db = mockD1({ stablecoins: { assets: cacheValue, updatedAt: staleForSlotUpdatedAt } });

    const result = await snapshotSupply(db, undefined, {
      minStablecoinsCacheUpdatedAtSec: slotStartedAt,
      freshnessGateLabel: "daily0800Utc",
    });

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(result.metadata).toBe(JSON.stringify({
      reason: "stablecoins_cache_before_slot",
      cacheUpdatedAt: staleForSlotUpdatedAt,
      requiredUpdatedAt: slotStartedAt,
      freshnessGateLabel: "daily0800Utc",
    }));
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
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }),
        makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50_000_000 } }),
      ],
    });
    const db = mockD1({
      stablecoins: { assets: cacheValue, updatedAt: cacheUpdatedAt },
      cacheRows: [{
        key: "snapshot-supply:last-write",
        value: completionMarker({ snapshotDate: todaySnapshotDate }),
        updatedAt: slotStartedAt - 60,
      }],
    });

    const result = await snapshotSupply(db, undefined, {
      minStablecoinsCacheUpdatedAtSec: slotStartedAt,
      freshnessGateLabel: "daily0800Utc",
    });

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(0);
    expect(result.metadata).toBe(JSON.stringify({
      reason: "already_written_today_before_freshness_gate",
      snapshotDate: todaySnapshotDate,
      cacheUpdatedAt,
      requiredUpdatedAt: slotStartedAt,
      freshnessGateLabel: "daily0800Utc",
    }));
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"))).toBe(false);
  });

  it("does not let a v1 count-only marker bypass the daily freshness gate", async () => {
    const slotStartedAt = Date.parse("2025-06-15T08:00:00Z") / 1000;
    const snapshotDate = Date.UTC(2025, 5, 15) / 1000;
    vi.setSystemTime(new Date(slotStartedAt * 1000));
    const cacheUpdatedAt = slotStartedAt - 15 * 60;
    const db = mockD1({
      stablecoins: {
        assets: { peggedAssets: [
          makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100 } }),
          makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 50 } }),
        ] },
        updatedAt: cacheUpdatedAt,
        first: false,
      },
      cacheRows: [{
        key: "snapshot-supply:last-write",
        value: { snapshotDate, coverageVersion: 1, expectedActiveCount: 2, accountedActiveCount: 2 },
        updatedAt: slotStartedAt - 60,
        first: false,
      }],
    });

    const result = await snapshotSupply(db, undefined, {
      minStablecoinsCacheUpdatedAtSec: slotStartedAt,
      freshnessGateLabel: "daily0800Utc",
    });

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({ reason: "stablecoins_cache_before_slot" });
  });

  it("does not let an identity-matched marker hide incomplete current coverage at the freshness gate", async () => {
    const slotStartedAt = Date.parse("2025-06-15T08:00:00Z") / 1000;
    const snapshotDate = Date.UTC(2025, 5, 15) / 1000;
    vi.setSystemTime(new Date(slotStartedAt * 1000));
    const db = mockD1({
      stablecoins: {
        assets: { peggedAssets: [makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100 } })] },
        updatedAt: slotStartedAt - 15 * 60,
        first: false,
      },
      cacheRows: [{
        key: "snapshot-supply:last-write",
        value: completionMarker({ snapshotDate }),
        updatedAt: slotStartedAt - 60,
        first: false,
      }],
    });

    const result = await snapshotSupply(db, undefined, {
      minStablecoinsCacheUpdatedAtSec: slotStartedAt,
      freshnessGateLabel: "daily0800Utc",
    });

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({ reason: "stablecoins_cache_before_slot" });
  });

  it("inserts rows for tracked assets with valid supply", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }),
        makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50_000_000 } }),
        makeSnapshotAsset({ id: "cash-stabl-fi", symbol: "CASH", price: 1.0, circulating: { peggedUSD: 10_000 } }), // not tracked
      ],
    });
    const db = mockD1({ stablecoins: { assets: cacheValue, updatedAt: freshUpdatedAt } });
    const result = await snapshotSupply(db);
    // Should insert 2 rows (IDs "usdt-tether" and "usdc-circle" are tracked, "cash-stabl-fi" is not)
    expect(result.itemCount).toBe(2);
  });

  it("skips restored rows while writing non-restored rows", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", supplyRestored: true, price: 1.0, circulating: { peggedUSD: 100 } }),
        makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50 } }),
      ],
    });
    const db = mockD1({ stablecoins: { assets: cacheValue, updatedAt: freshUpdatedAt } });

    const result = await snapshotSupply(db, undefined, {
      requiredActiveIds: ["usdc-circle"],
      snapshotEligibleIds: DEFAULT_REQUIRED_IDS,
    });

    expect(result.itemCount).toBe(1);
    const inserts = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"));
    expect(inserts.flatMap((entry) => entry.binds)).toContain("usdc-circle");
    expect(inserts.flatMap((entry) => entry.binds)).not.toContain("usdt-tether");
  });

  it("writes observed rows and reports restored-only required assets as skipped", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", supplyRestored: true, price: 1.0, circulating: { peggedUSD: 100 } }),
        makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50 } }),
      ],
    });
    const db = mockD1({ stablecoins: { assets: cacheValue, updatedAt: freshUpdatedAt } });

    const result = await snapshotSupply(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      reason: "snapshot_written_restored_skipped",
      restoredOnlyIds: ["usdt-tether"],
      writtenRows: 1,
    });
    const insertedSql = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"));
    expect(insertedSql.length).toBeGreaterThan(0);
    expect(db.getHistory().some((entry) => entry.binds.includes("usdt-tether") && entry.sql.includes("INSERT OR REPLACE INTO supply_history"))).toBe(false);
  });

  it("skips assets with zero circulating supply", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 30;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 0 } }),
      ],
    });
    const db = mockD1({ stablecoins: { assets: cacheValue, updatedAt: freshUpdatedAt } });
    const result = await snapshotSupply(db);
    expect(result.itemCount).toBe(0);
  });

  it("skips when today's UTC snapshot is already written", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const todaySnapshotDate = Math.floor(Date.UTC(2025, 5, 15) / 1000);
    const cacheValue = JSON.stringify({
      peggedAssets: [
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }),
        makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50_000_000 } }),
      ],
    });
    const db = mockD1({
      stablecoins: { assets: cacheValue, updatedAt: freshUpdatedAt },
      cacheRows: [{
        key: "snapshot-supply:last-write",
        value: completionMarker({ snapshotDate: todaySnapshotDate }),
        updatedAt: freshUpdatedAt,
      }],
    });

    const result = await snapshotSupply(db);

    expect(result.itemCount).toBe(0);
    expect(JSON.parse(String(result.metadata))).toMatchObject({ reason: "already_written_today" });
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"))).toBe(false);
  });

  it("retries a same-count active-ID replacement and removes the prior owned row", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const snapshotDate = Date.UTC(2025, 5, 15) / 1000;
    const db = mockD1({
      stablecoins: {
        assets: { peggedAssets: [
          makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100 } }),
          makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 50 } }),
        ] },
        updatedAt: freshUpdatedAt,
        first: false,
      },
      cacheRows: [{
        key: "snapshot-supply:last-write",
        value: completionMarker({
          snapshotDate,
          requiredIds: ["usdt-tether", "eurt-test"],
          ownedRowIds: ["usdt-tether", "eurt-test"],
        }),
        updatedAt: freshUpdatedAt,
        first: false,
      }],
    });

    const result = await snapshotSupply(db, undefined, {
      requiredActiveIds: DEFAULT_REQUIRED_IDS,
      snapshotEligibleIds: DEFAULT_REQUIRED_IDS,
    });

    expect(result.itemCount).toBe(2);
    const deletes = db.getHistory().filter((entry) => entry.sql.includes("DELETE FROM supply_history"));
    expect(deletes.some((entry) => entry.binds.includes("eurt-test"))).toBe(true);
    const inserts = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"));
    expect(inserts.flatMap((entry) => entry.binds)).not.toContain("eurt-test");
  });

  it("invalidates the same-day marker when an active asset is promoted", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const snapshotDate = Date.UTC(2025, 5, 15) / 1000;
    const requiredIds = [...DEFAULT_REQUIRED_IDS, "eurt-test"];
    const db = mockD1({
      stablecoins: {
        assets: { peggedAssets: [
          makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100 } }),
          makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 50 } }),
          makeSnapshotAsset({ id: "eurt-test", symbol: "EURT", circulating: { peggedEUR: 25 } }),
        ] },
        updatedAt: freshUpdatedAt,
        first: false,
      },
      cacheRows: [{
        key: "snapshot-supply:last-write",
        value: completionMarker({ snapshotDate }),
        updatedAt: freshUpdatedAt,
        first: false,
      }],
    });

    const result = await snapshotSupply(db, undefined, {
      requiredActiveIds: requiredIds,
      snapshotEligibleIds: requiredIds,
    });

    expect(result.itemCount).toBe(3);
  });

  it("replaces a removed asset without deleting rows outside snapshot ownership", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const snapshotDate = Date.UTC(2025, 5, 15) / 1000;
    const previousIds = [...DEFAULT_REQUIRED_IDS, "eurt-test"];
    const db = mockD1({
      stablecoins: {
        assets: { peggedAssets: [
          makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100 } }),
          makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 50 } }),
          makeSnapshotAsset({ id: "eurt-test", symbol: "EURT", circulating: { peggedEUR: 25 } }),
          makeSnapshotAsset({ id: "admin-backfill-only", symbol: "ADMIN", circulating: { peggedUSD: 10 } }),
        ] },
        updatedAt: freshUpdatedAt,
        first: false,
      },
      cacheRows: [{
        key: "snapshot-supply:last-write",
        value: completionMarker({ snapshotDate, requiredIds: previousIds, ownedRowIds: previousIds }),
        updatedAt: freshUpdatedAt,
        first: false,
      }],
    });

    const result = await snapshotSupply(db, undefined, {
      requiredActiveIds: DEFAULT_REQUIRED_IDS,
      snapshotEligibleIds: DEFAULT_REQUIRED_IDS,
    });

    expect(result.itemCount).toBe(2);
    const deleteBinds = db.getHistory()
      .filter((entry) => entry.sql.includes("DELETE FROM supply_history"))
      .flatMap((entry) => entry.binds);
    expect(deleteBinds).toContain("eurt-test");
    expect(deleteBinds).not.toContain("admin-backfill-only");
  });

  it("replaces owned rows exactly while preserving an outside admin row in SQLite", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
            const nowSec = Math.floor(Date.now() / 1000);
      const snapshotDate = Date.UTC(2025, 5, 15) / 1000;
      const previousIds = [...DEFAULT_REQUIRED_IDS, "eurt-test"];
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        "stablecoins",
        JSON.stringify({ peggedAssets: [
          makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100 } }),
          makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 50 } }),
        ] }),
        nowSec - 60,
      );
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        "snapshot-supply:last-write",
        completionMarker({
          snapshotDate,
          requiredIds: previousIds,
          ownedRowIds: previousIds,
        }),
        nowSec - 60,
      );
      const seed = sqlite.prepare(
        "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
      );
      seed.run("usdt-tether", snapshotDate, 90, 1);
      seed.run("usdc-circle", snapshotDate, 45, 1);
      seed.run("eurt-test", snapshotDate, 25, 1);
      seed.run("admin-backfill-only", snapshotDate, 10, 1);

      const result = await snapshotSupply(createSqliteD1(sqlite), undefined, {
        nowSec,
        requiredActiveIds: DEFAULT_REQUIRED_IDS,
        snapshotEligibleIds: DEFAULT_REQUIRED_IDS,
      });

      expect(result.itemCount).toBe(2);
      const ids = sqlite.prepare(
        "SELECT stablecoin_id FROM supply_history WHERE snapshot_date = ? ORDER BY stablecoin_id",
      ).all(snapshotDate) as Array<{ stablecoin_id: string }>;
      expect(ids.map((row) => row.stablecoin_id)).toEqual([
        "admin-backfill-only",
        "usdc-circle",
        "usdt-tether",
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("repairs null prices in an already-complete same-day snapshot without rewriting other fields", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
            const nowSec = Math.floor(Date.now() / 1000);
      const snapshotDate = Date.UTC(2025, 5, 15) / 1000;
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        "stablecoins",
        JSON.stringify({ peggedAssets: [
          makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1.001, circulating: { peggedUSD: 100 } }),
          makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50 } }),
          makeSnapshotAsset({ id: "eurt-test", symbol: "EURT", price: 0.99, supplyRestored: true, circulating: { peggedEUR: 25 } }),
        ] }),
        nowSec - 60,
      );
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        "snapshot-supply:last-write",
        completionMarker({ snapshotDate }),
        nowSec - 60,
      );
      sqlite.prepare(
        "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
      ).run("usdt-tether", snapshotDate, 90, null);
      sqlite.prepare(
        "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
      ).run("usdc-circle", snapshotDate, 45, 0.998);
      sqlite.prepare(
        "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
      ).run("eurt-test", snapshotDate, 25, null);

      const result = await snapshotSupply(createSqliteD1(sqlite), undefined, {
        nowSec,
        requiredActiveIds: DEFAULT_REQUIRED_IDS,
        snapshotEligibleIds: [...DEFAULT_REQUIRED_IDS, "eurt-test"],
      });

      expect(result.itemCount).toBe(1);
      expect(JSON.parse(String(result.metadata))).toMatchObject({
        reason: "repaired_missing_prices_today",
        repairedPriceRows: 1,
      });
      expect(sqlite.prepare(
        "SELECT stablecoin_id, circulating_usd, price FROM supply_history ORDER BY stablecoin_id",
      ).all()).toEqual([
        { stablecoin_id: "eurt-test", circulating_usd: 25, price: null },
        { stablecoin_id: "usdc-circle", circulating_usd: 45, price: 0.998 },
        { stablecoin_id: "usdt-tether", circulating_usd: 90, price: 1.001 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("invalidates completion when an applied waiver owner or expiry changes", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const snapshotDate = Date.UTC(2025, 5, 15) / 1000;
    const originalWaiver: StablecoinPublicationWaiver = {
      stablecoinId: "usdc-circle",
      owner: "data-platform",
      reason: "upstream unavailable",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const variants: StablecoinPublicationWaiver[] = [
      { ...originalWaiver, owner: "data-operations" },
      { ...originalWaiver, expiresAt: originalWaiver.expiresAt + 3600 },
    ];

    for (const currentWaiver of variants) {
      const db = mockD1({
        stablecoins: {
          assets: { peggedAssets: [makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100 } })] },
          updatedAt: freshUpdatedAt,
          first: false,
        },
        cacheRows: [{
          key: "snapshot-supply:last-write",
          value: completionMarker({
            snapshotDate,
            appliedWaivers: [originalWaiver],
            ownedRowIds: ["usdt-tether"],
            writtenRows: 1,
          }),
          updatedAt: freshUpdatedAt,
          first: false,
        }],
      });

      const result = await snapshotSupply(db, undefined, {
        nowSec: Math.floor(Date.now() / 1000),
        publicationWaivers: [currentWaiver],
        snapshotEligibleIds: DEFAULT_REQUIRED_IDS,
        requiredActiveIds: DEFAULT_REQUIRED_IDS,
      });

      expect(result.itemCount).toBe(1);
    }
  });

  it("fails closed when a same-day marker's applied waiver reaches expiry", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const snapshotDate = Date.UTC(2025, 5, 15) / 1000;
    const waiver: StablecoinPublicationWaiver = {
      stablecoinId: "usdc-circle",
      owner: "data-platform",
      reason: "upstream unavailable",
      expiresAt: nowSec,
    };
    const db = mockD1({
      stablecoins: {
        assets: { peggedAssets: [makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100 } })] },
        updatedAt: nowSec - 60,
        first: false,
      },
      cacheRows: [{
        key: "snapshot-supply:last-write",
        value: completionMarker({
          snapshotDate,
          appliedWaivers: [waiver],
          ownedRowIds: ["usdt-tether"],
          writtenRows: 1,
        }),
        updatedAt: nowSec - 60,
        first: false,
      }],
    });

    const result = await snapshotSupply(db, undefined, {
      nowSec,
      publicationWaivers: [waiver],
      snapshotEligibleIds: DEFAULT_REQUIRED_IDS,
      requiredActiveIds: DEFAULT_REQUIRED_IDS,
    });

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      reason: "partial_snapshot_blocked",
      missingActiveIds: ["usdc-circle"],
    });
  });

  it("retries a same-day v1 count-equal marker that cannot prove exact identity coverage", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const todaySnapshotDate = Math.floor(Date.UTC(2025, 5, 15) / 1000);
    const cacheValue = JSON.stringify({
      peggedAssets: [
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1, circulating: { peggedUSD: 100_000_000 } }),
        makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", price: 1, circulating: { peggedUSD: 50_000_000 } }),
      ],
    });
    const db = mockD1({
      stablecoins: { assets: cacheValue, updatedAt: freshUpdatedAt, first: false },
      cacheRows: [{
        key: "snapshot-supply:last-write",
        value: { snapshotDate: todaySnapshotDate, coverageVersion: 1, expectedActiveCount: 2, accountedActiveCount: 2 },
        updatedAt: freshUpdatedAt,
        first: false,
      }],
    });

    const result = await snapshotSupply(db);

    expect(result.itemCount).toBe(2);
    expect(db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO supply_history"))).toHaveLength(1);
    const markerWrite = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "snapshot-supply:last-write"
    );
    expect(JSON.parse(String(markerWrite?.binds[1]))).toMatchObject({
      snapshotDate: todaySnapshotDate,
      coverageVersion: 2,
      expectedActiveCount: 2,
      accountedActiveCount: 2,
      coverageDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      ownedRowIds: ["usdc-circle", "usdt-tether"],
      writtenRows: 2,
    });
  });

  it("writes after UTC midnight even when the previous write is under 20 hours old", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const yesterdaySnapshotDate = Math.floor(Date.UTC(2025, 5, 14) / 1000);
    const cacheValue = JSON.stringify({
      peggedAssets: [
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }),
        makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", price: 0.999, circulating: { peggedUSD: 50_000_000 } }),
      ],
    });
    const db = mockD1({
      stablecoins: { assets: cacheValue, updatedAt: freshUpdatedAt },
      cacheRows: [{
        key: "snapshot-supply:last-write",
        value: { snapshotDate: yesterdaySnapshotDate },
        // Written 22:00 UTC yesterday — 10.5h ago, inside the old 20h cooldown
        updatedAt: Math.floor(Date.now() / 1000) - 10.5 * 3600,
      }],
    });

    const result = await snapshotSupply(db);

    expect(result.itemCount).toBe(2);
  });

  it("blocks partial daily snapshots instead of writing a sparse day", async () => {
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 30;
    const cacheValue = JSON.stringify({
      peggedAssets: [
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }),
      ],
    });
    const db = mockD1({ stablecoins: { assets: cacheValue, updatedAt: freshUpdatedAt } });

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
        makeSnapshotAsset({ id: "usdt-tether", symbol: "USDT", price: 1, circulating: { peggedUSD: 100_000_000 } }),
        makeSnapshotAsset({ id: "usdc-circle", symbol: "USDC", price: 1, circulating: { peggedUSD: 50_000_000 } }),
      ],
    });
    const db = mockD1({
      stablecoins: { assets: cacheValue, updatedAt: freshUpdatedAt },
      tables: [{
        match: "INSERT OR REPLACE INTO supply_history",
        rows: [],
        throwError: new Error("partial batch failure"),
      }],
    });
    const batches: D1PreparedStatement[][] = [];
    const originalBatch = db.batch.bind(db);
    db.batch = (async (statements: D1PreparedStatement[]) => {
      batches.push(statements);
      return originalBatch(statements);
    }) as D1Database["batch"];

    const result = await snapshotSupply(db);

    expect(result).toMatchObject({ status: "degraded", itemCount: 0 });
    expect(JSON.parse(String(result.metadata))).toMatchObject({ reason: "db_write_failed" });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((statement) => (statement as { sql?: string }).sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("DELETE FROM supply_history"),
      expect.stringContaining("INSERT OR REPLACE INTO supply_history"),
      expect.stringContaining("INSERT OR REPLACE INTO cache"),
    ]));
  });
});
