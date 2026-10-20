import type { DatabaseSync } from "node:sqlite";
import type * as DebtModule from "../mint-burn-pipeline/materialization-debt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mint-burn-pipeline/materialization-debt", async (importOriginal) => {
  const actual = await importOriginal<typeof DebtModule>();
  return { ...actual, executeMintBurnMaintenanceMutations: vi.fn().mockResolvedValue({ changed: 0, affectedHours: new Map() }) };
});

import { healNullPrices } from "../mint-burn-pipeline/price-heal";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { executeMintBurnMaintenanceMutations, rebuildMintBurnMaterializationHours } from "../mint-burn-pipeline/materialization-debt";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const NOW = 1_700_000_000;

interface NullPriceEvent {
  id: string;
  stablecoin_id: string;
  chain_id: string;
  amount: number;
  timestamp: number;
}

interface PriceHistoryRow {
  stablecoin_id: string;
  snapshot_date: number;
  price: number;
  price_observed_at: number;
}

interface PriceCacheRow {
  asset_id: string;
  price: number;
  updated_at: number;
  observed_at: number | null;
  observed_at_mode: string | null;
  source: string | null;
}

interface BoundStatement {
  sql: string;
  args: unknown[];
  all: () => Promise<{ results: unknown[] }>;
  first: () => Promise<null>;
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
}

function cacheRow(overrides: Partial<PriceCacheRow> & Pick<PriceCacheRow, "asset_id">): PriceCacheRow {
  return {
    price: 1.0,
    updated_at: NOW,
    observed_at: NOW,
    observed_at_mode: "local_fetch",
    source: "binance",
    ...overrides,
  };
}

function mockDb(
  nullEvents: NullPriceEvent[] = [],
  priceHistoryRows: PriceHistoryRow[] = [],
  priceCacheRows: PriceCacheRow[] = [],
): D1Database {
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...args: unknown[]): BoundStatement => ({
      sql,
      args,
      all: async () => {
        if (sql.includes("FROM mint_burn_events")) return { results: nullEvents };
        if (sql.includes("FROM supply_history")) return { results: priceHistoryRows };
        if (sql.includes("FROM price_cache")) return { results: priceCacheRows };
        return { results: [] };
      },
      first: async () => null,
      run: async () => ({ success: true, meta: { changes: 1 } }),
    })),
  }));

  return makeNoopD1({ prepare });
}

function healedArgs(): unknown[][] {
  const mutations = vi.mocked(executeMintBurnMaintenanceMutations).mock.calls[0]?.[1] ?? [];
  return mutations.map((mutation) => (mutation.update as unknown as BoundStatement).args);
}

describe("healNullPrices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns healed=0 when no NULL events exist", async () => {
    const result = await healNullPrices(mockDb([]), NOW);
    expect(result.healed).toBe(0);
    expect(result.affectedHours.size).toBe(0);
  });

  it("prefers an in-window supply_history snapshot, stamped with its observation clock, over price_cache", async () => {
    const dayTs = Math.floor((NOW - 3600) / 86400) * 86400;
    const db = mockDb(
      [{ id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 }],
      [{ stablecoin_id: "usdc-circle", snapshot_date: dayTs, price: 0.98, price_observed_at: NOW - 7200 }],
      [cacheRow({ asset_id: "usdc-circle", price: 1.05 })],
    );
    vi.mocked(executeMintBurnMaintenanceMutations).mockResolvedValueOnce({ changed: 1, affectedHours: new Map() });

    expect((await healNullPrices(db, NOW)).healed).toBe(1);
    expect(healedArgs()).toEqual([[980, 0.98, NOW - 7200, "supply-history-heal", "e1"]]);
  });

  it("uses an in-window replay-safe observation stamped with its observation clock when no snapshot qualifies", async () => {
    const dayTs = Math.floor((NOW - 3600) / 86400) * 86400;
    const db = mockDb(
      [{ id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 }],
      [
        // Event-day snapshot whose price was observed 106h before the event.
        { stablecoin_id: "usdc-circle", snapshot_date: dayTs, price: 0.98, price_observed_at: NOW - 3600 - 106 * 3600 },
        // In-window but implausible.
        { stablecoin_id: "usdc-circle", snapshot_date: dayTs, price: 1.4, price_observed_at: NOW - 3000 },
      ],
      [cacheRow({ asset_id: "usdc-circle", observed_at: NOW - 600, updated_at: NOW - 600 })],
    );
    vi.mocked(executeMintBurnMaintenanceMutations).mockResolvedValueOnce({ changed: 1, affectedHours: new Map() });

    expect((await healNullPrices(db, NOW)).healed).toBe(1);
    expect(healedArgs()).toEqual([[1000, 1, NOW - 600, "price_cache_heal", "e1"]]);
  });

  it.each([
    ["missing", []],
    ["a non-replay-safe source", [cacheRow({ asset_id: "usdc-circle", source: "coingecko-native-implied" })]],
    ["a search-derived source", [cacheRow({ asset_id: "usdc-circle", source: "dexscreener-search" })]],
    ["a nominal reference", [cacheRow({ asset_id: "usdc-circle", observed_at_mode: "nominal_reference" })]],
    ["a non-positive price", [cacheRow({ asset_id: "usdc-circle", price: 0 })]],
  ])("leaves amount_usd NULL when the cache observation is %s", async (_label, rows) => {
    const db = mockDb(
      [{ id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 }],
      [],
      rows,
    );

    expect((await healNullPrices(db, NOW)).healed).toBe(0);
    expect(executeMintBurnMaintenanceMutations).not.toHaveBeenCalled();
  });

  it("collects correct affected hours for re-aggregation", async () => {
    const db = mockDb(
      [
        { id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3595 },
        { id: "e2", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 2000, timestamp: NOW - 3590 },
        { id: "e3", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 500, timestamp: NOW - 7195 },
      ],
      [],
      [cacheRow({ asset_id: "usdc-circle" })],
    );
    const firstHour = Math.floor((NOW - 3595) / 3600) * 3600;
    const secondHour = Math.floor((NOW - 7195) / 3600) * 3600;
    vi.mocked(executeMintBurnMaintenanceMutations).mockResolvedValueOnce({ changed: 3, affectedHours: new Map([
      ["first", { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: firstHour }],
      ["second", { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: secondHour }],
    ]) });

    const result = await healNullPrices(db, NOW);
    expect(result.affectedHours.size).toBe(2);
  });

  describe("against SQLite", () => {
    const insertEvent = (
      sqlite: DatabaseSync,
      id: string,
      stablecoinId: string,
      timestamp: number,
    ) => sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, tx_hash, block_number, timestamp, explorer_tx_url)
      VALUES (?, ?, 'X', 'ethereum', 'mint', 100, NULL, ?, 1, ?, '')`).run(id, stablecoinId, id, timestamp);
    const insertCache = (
      sqlite: DatabaseSync,
      assetId: string,
      observedAt: number,
    ) => sqlite.prepare(`INSERT INTO price_cache (asset_id, price, updated_at, source, observed_at, observed_at_mode, synced_at)
      VALUES (?, 1.01, ?, 'binance', ?, 'local_fetch', ?)`).run(assetId, observedAt, observedAt, observedAt);

    beforeEach(async () => {
      const actual = await vi.importActual<typeof DebtModule>("../mint-burn-pipeline/materialization-debt");
      vi.mocked(executeMintBurnMaintenanceMutations).mockImplementation(actual.executeMintBurnMaintenanceMutations);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW * 1000);
    });

    afterEach(() => {
      vi.mocked(executeMintBurnMaintenanceMutations).mockReset().mockResolvedValue({ changed: 0, affectedHours: new Map() });
      vi.useRealTimers();
    });

    it.each(["source", "enqueue"])("rolls back both source and debt when the %s statement fails", async (failure) => {
      const { sqlite } = fixtures.open();
      insertCache(sqlite, "usdc-circle", NOW - 60);
      insertEvent(sqlite, "e1", "usdc-circle", NOW - 120);
      const db = createSqliteD1(sqlite, { onRun(sql) {
        if ((failure === "source" && sql.includes("UPDATE mint_burn_events"))
          || (failure === "enqueue" && sql.includes("INSERT OR REPLACE INTO mint_burn_dirty_hours"))) {
          throw new Error("injected maintenance failure");
        }
      } });
      await expect(healNullPrices(db, NOW)).rejects.toThrow("injected maintenance failure");
      expect(sqlite.prepare("SELECT amount_usd FROM mint_burn_events").get()).toEqual({ amount_usd: null });
      expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'mint-burn-price-heal-cursor:v1'").all()).toEqual([]);
    });

    it("retains committed debt and the last bucket when immediate rebuild fails, then atomically settles it", async () => {
      const { db, sqlite } = fixtures.open();
      insertCache(sqlite, "usdc-circle", NOW - 60);
      insertEvent(sqlite, "e1", "usdc-circle", NOW - 120);
      sqlite.prepare("UPDATE mint_burn_events SET price_repair_status = 'pending_aggregate'").run();
      const hour = Math.floor((NOW - 120) / 3600) * 3600;
      sqlite.prepare(`INSERT INTO mint_burn_hourly
        (stablecoin_id, chain_id, hour_ts, mint_count, mint_volume_usd)
        VALUES ('usdc-circle', 'ethereum', ?, 1, 7)`).run(hour);
      const healed = await healNullPrices(db, NOW);
      const failingDb = createSqliteD1(sqlite, { onRun(sql) {
        if (sql.includes("DELETE FROM mint_burn_dirty_hours")) throw new Error("injected debt-clear failure");
      } });
      await expect(rebuildMintBurnMaterializationHours(failingDb, healed.affectedHours))
        .rejects.toThrow("injected debt-clear failure");
      expect(sqlite.prepare("SELECT mint_volume_usd FROM mint_burn_hourly").get()).toEqual({ mint_volume_usd: 7 });
      expect(sqlite.prepare("SELECT amount_usd, price_repair_status FROM mint_burn_events").get())
        .toEqual({ amount_usd: 101, price_repair_status: "pending_aggregate" });
      expect(sqlite.prepare("SELECT hour_ts FROM mint_burn_dirty_hours").all()).toEqual([{ hour_ts: hour }]);
      await rebuildMintBurnMaterializationHours(db, healed.affectedHours);
      expect(sqlite.prepare("SELECT mint_volume_usd, mint_unpriced_event_count FROM mint_burn_hourly").get())
        .toEqual({ mint_volume_usd: 101, mint_unpriced_event_count: 0 });
      expect(sqlite.prepare("SELECT price_repair_status FROM mint_burn_events").get())
        .toEqual({ price_repair_status: "recovered" });
      expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
    });

    it("reads a newer mutation during rebuild and preserves debt re-enqueued after clear", async () => {
      const { db, sqlite } = fixtures.open();
      insertCache(sqlite, "usdc-circle", NOW - 60);
      insertEvent(sqlite, "first", "usdc-circle", NOW - 120);
      const first = await healNullPrices(db, NOW);
      insertEvent(sqlite, "second", "usdc-circle", NOW - 119);
      await healNullPrices(db, NOW);
      await rebuildMintBurnMaterializationHours(db, first.affectedHours);
      expect(sqlite.prepare("SELECT mint_count, mint_volume_usd FROM mint_burn_hourly").get())
        .toEqual({ mint_count: 2, mint_volume_usd: 202 });
      insertEvent(sqlite, "third", "usdc-circle", NOW - 118);
      await healNullPrices(db, NOW);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_dirty_hours").get()).toEqual({ count: 1 });
      expect(sqlite.prepare("SELECT mint_count FROM mint_burn_hourly").get()).toEqual({ mint_count: 2 });
      await rebuildMintBurnMaterializationHours(db, first.affectedHours);
      expect(sqlite.prepare("SELECT mint_count, mint_volume_usd FROM mint_burn_hourly").get())
        .toEqual({ mint_count: 3, mint_volume_usd: 303 });
      expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
    });

    it("admits observations within ±24h inclusive of the event and rejects ±24h±1s and old events", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW * 1000);
      const { db, sqlite } = fixtures.open();
      // Observation clocks sit before and after the events so both window edges are exercised.
      const usdtObservedAt = NOW - 1_000;
      const usdcObservedAt = NOW - 100_000;
      insertCache(sqlite, "usdt-tether", usdtObservedAt);
      insertCache(sqlite, "usdc-circle", usdcObservedAt);
      insertEvent(sqlite, "obs-minus-24h-1s", "usdt-tether", usdtObservedAt + 86_401);
      insertEvent(sqlite, "obs-exact", "usdt-tether", usdtObservedAt);
      insertEvent(sqlite, "obs-minus-24h", "usdc-circle", usdcObservedAt + 86_400);
      insertEvent(sqlite, "obs-plus-24h", "usdt-tether", usdtObservedAt - 86_400);
      insertEvent(sqlite, "obs-plus-24h-1s", "usdt-tether", usdtObservedAt - 86_401);
      insertEvent(sqlite, "old-event-current-quote", "usdt-tether", NOW - 170_000);

      expect((await healNullPrices(db, NOW)).healed).toBe(3);
      expect(sqlite.prepare(
        "SELECT id, price_timestamp, price_source FROM mint_burn_events WHERE amount_usd IS NOT NULL ORDER BY id",
      ).all()).toEqual([
        { id: "obs-exact", price_timestamp: usdtObservedAt, price_source: "price_cache_heal" },
        { id: "obs-minus-24h", price_timestamp: usdcObservedAt, price_source: "price_cache_heal" },
        { id: "obs-plus-24h", price_timestamp: usdtObservedAt, price_source: "price_cache_heal" },
      ]);
    });

    it("rejects an observation clock after the assessment time", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW * 1000);
      const { db, sqlite } = fixtures.open();
      insertCache(sqlite, "usdt-tether", NOW + 60);
      insertEvent(sqlite, "e1", "usdt-tether", NOW - 60);

      expect((await healNullPrices(db, NOW)).healed).toBe(0);
    });

    it("never admits a legacy snapshot without a recorded observation clock", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW * 1000);
      const { db, sqlite } = fixtures.open();
      const dayTs = Math.floor(NOW / 86400) * 86400;
      sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, 1, 1)")
        .run("usdt-tether", dayTs);
      insertEvent(sqlite, "e1", "usdt-tether", NOW - 60);

      expect((await healNullPrices(db, NOW)).healed).toBe(0);

      sqlite.prepare("UPDATE supply_history SET price_observed_at = ? WHERE stablecoin_id = 'usdt-tether'").run(NOW - 120);
      expect((await healNullPrices(db, NOW)).healed).toBe(1);
      expect(sqlite.prepare("SELECT price_timestamp, price_source FROM mint_burn_events WHERE id = 'e1'").get())
        .toEqual({ price_timestamp: NOW - 120, price_source: "supply-history-heal" });
    });

    it("never treats a legacy protocol-redeem par row of a nominal-par route as an observation", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW * 1000);
      const { db, sqlite } = fixtures.open();
      const insertParRow = sqlite.prepare(`INSERT OR REPLACE INTO price_cache
        (asset_id, price, updated_at, source, observed_at, observed_at_mode, synced_at)
        VALUES (?, 1, ?, 'protocol-redeem', ?, 'local_fetch', ?)`);
      // usbd-bima is a protocol-par route; its in-window legacy row is par, not an observation.
      insertParRow.run("usbd-bima", NOW - 60, NOW - 60, NOW - 60);
      insertEvent(sqlite, "usbd", "usbd-bima", NOW - 120);
      expect((await healNullPrices(db, NOW)).healed).toBe(0);

      // A real observation of the same route is still admissible.
      sqlite.prepare("DELETE FROM price_cache WHERE asset_id = 'usbd-bima'").run();
      insertCache(sqlite, "usbd-bima", NOW - 60);
      expect((await healNullPrices(db, NOW)).healed).toBe(1);
    });

    it("skips coins without admissible evidence so their rows cannot starve healable coins", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW * 1000);
      const { db, sqlite } = fixtures.open();
      // 600 newer rows of a coin whose only price is weeks old fill more than the 500-row budget.
      for (let index = 0; index < 600; index++) {
        insertEvent(sqlite, `stale-${String(index).padStart(3, "0")}`, "usdc-circle", NOW - index);
      }
      insertCache(sqlite, "usdc-circle", NOW - 30 * 86_400);
      insertEvent(sqlite, "healable", "usdt-tether", NOW - 3_600);
      insertCache(sqlite, "usdt-tether", NOW - 3_000);

      expect((await healNullPrices(db, NOW)).healed).toBe(1);
      expect(sqlite.prepare("SELECT id FROM mint_burn_events WHERE amount_usd IS NOT NULL").all())
        .toEqual([{ id: "healable" }]);
    });

    it("resumes past 501 ineligible same-coin rows despite restart, cursor deletion and newer arrivals", async () => {
      const { db, sqlite } = fixtures.open();
      for (let index = 0; index < 501; index++) {
        insertEvent(sqlite, `stale-${String(index).padStart(3, "0")}`, "usdc-circle", NOW - 60);
      }
      insertCache(sqlite, "usdc-circle", NOW - 36 * 3600);
      insertEvent(sqlite, "healable", "usdc-circle", NOW - 36 * 3600);

      expect((await healNullPrices(db, NOW)).healed).toBe(0);
      const checkpoint = sqlite.prepare("SELECT value FROM cache WHERE key = 'mint-burn-price-heal-cursor:v1'");
      expect(JSON.parse(checkpoint.get()!.value as string)).toEqual({ timestamp: NOW - 60, id: "stale-001" });
      sqlite.prepare("DELETE FROM mint_burn_events WHERE id = 'stale-001'").run();
      for (let index = 0; index < 501; index++) {
        insertEvent(sqlite, `arrival-${String(index).padStart(3, "0")}`, "usdc-circle", NOW);
      }

      const resumed = await healNullPrices(createSqliteD1(sqlite), NOW + 1);
      expect(resumed.healed).toBe(1);
      expect(sqlite.prepare("SELECT id, amount_usd, price_timestamp FROM mint_burn_events WHERE amount_usd IS NOT NULL").all())
        .toEqual([{ id: "healable", amount_usd: 101, price_timestamp: NOW - 36 * 3600 }]);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events WHERE amount_usd IS NULL").get())
        .toEqual({ count: 1001 });
      expect(JSON.parse(checkpoint.get()!.value as string)).toBeNull();
      expect(sqlite.prepare("SELECT hour_ts FROM mint_burn_dirty_hours").all())
        .toEqual([{ hour_ts: Math.floor((NOW - 36 * 3600) / 3600) * 3600 }]);
      await rebuildMintBurnMaterializationHours(db, resumed.affectedHours);
      expect(sqlite.prepare("SELECT mint_volume_usd FROM mint_burn_hourly").get()).toEqual({ mint_volume_usd: 101 });
      expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);

      // Exhaustion wraps, so newly available evidence revisits previously inspected NULLs.
      sqlite.prepare("UPDATE price_cache SET observed_at = ?, updated_at = ?").run(NOW - 60, NOW - 60);
      for (const expected of [500, 500, 1]) {
        expect((await healNullPrices(createSqliteD1(sqlite), NOW + 2)).healed).toBe(expected);
      }
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events WHERE amount_usd IS NULL").get())
        .toEqual({ count: 0 });
    });

    it.each(["{", JSON.stringify({ timestamp: NOW - 48 * 3600 - 1, id: "expired" })])(
      "starts a fresh pass when its durable checkpoint is invalid or outside the lookback (%s)",
      async (value) => {
        const { db, sqlite } = fixtures.open();
        sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('mint-burn-price-heal-cursor:v1', ?, ?)")
          .run(value, NOW);
        insertCache(sqlite, "usdc-circle", NOW);
        insertEvent(sqlite, "recent", "usdc-circle", NOW - 60);
        expect((await healNullPrices(db, NOW)).healed).toBe(1);
        expect(sqlite.prepare("SELECT amount_usd FROM mint_burn_events WHERE id = 'recent'").get())
          .toEqual({ amount_usd: 101 });
      },
    );

    it("heals the newest 500 rows with deterministic ID ordering at tied timestamps", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW * 1000);
      const { db, sqlite } = fixtures.open();
      for (let index = 0; index < 501; index++) {
        insertEvent(sqlite, `event-${String(index).padStart(3, "0")}`, "usdc-circle", NOW);
      }
      insertEvent(sqlite, "older", "usdc-circle", NOW - 1);
      insertCache(sqlite, "usdc-circle", NOW);

      expect((await healNullPrices(db, NOW)).healed).toBe(500);
      expect(sqlite.prepare("SELECT id FROM mint_burn_events WHERE amount_usd IS NULL ORDER BY id").all())
        .toEqual([{ id: "event-000" }, { id: "older" }]);
      expect(sqlite.prepare("SELECT amount_usd, price_used FROM mint_burn_events WHERE id = 'event-500'").get())
        .toEqual({ amount_usd: 101, price_used: 1.01 });
      insertEvent(sqlite, "new-arrival", "usdc-circle", NOW + 1);
      expect((await healNullPrices(createSqliteD1(sqlite), NOW + 1)).healed).toBe(2);
      expect(sqlite.prepare("SELECT id FROM mint_burn_events WHERE amount_usd IS NULL").all())
        .toEqual([{ id: "new-arrival" }]);
      expect((await healNullPrices(createSqliteD1(sqlite), NOW + 1)).healed).toBe(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events WHERE amount_usd IS NULL").get())
        .toEqual({ count: 0 });
    });
  });
});
