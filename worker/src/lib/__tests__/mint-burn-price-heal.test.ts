import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healNullPrices } from "../mint-burn-pipeline/price-heal";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { rebuildMintBurnMaterializationHours } from "../mint-burn-pipeline/materialization-debt";

const { open, closeAll } = createLatestSchemaFixtureTracker();
afterEach(() => { closeAll(); vi.useRealTimers(); });
const NOW = 1_700_000_000;
const DAY = 86400;
const USDC = "usdc-circle", USDT = "usdt-tether";
const day = (time: number) => Math.floor(time / DAY) * DAY;

const insertEvent = (sqlite: DatabaseSync, id: string, timestamp: number, stablecoinId = USDC, amount = 100) =>
  sqlite.prepare(`INSERT INTO mint_burn_events
    (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, tx_hash, block_number, timestamp, explorer_tx_url)
    VALUES (?, ?, 'X', 'ethereum', 'mint', ?, NULL, ?, 1, ?, '')`).run(id, stablecoinId, amount, id, timestamp);
const insertCache = (sqlite: DatabaseSync, observedAt: number, assetId = USDC,
  { price = 1.01, source = "binance", mode = "local_fetch" } = {}) =>
  sqlite.prepare(`INSERT INTO price_cache (asset_id, price, updated_at, source, observed_at, observed_at_mode, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(assetId, price, observedAt, source, observedAt, mode, observedAt);
const insertHistory = (sqlite: DatabaseSync) => sqlite.prepare(`INSERT INTO supply_history
  (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at) VALUES (?, ?, 1, ?, ?)`);
const pricedFixture = () => {
  const fixture = open();
  insertCache(fixture.sqlite, NOW - 60);
  insertEvent(fixture.sqlite, "e1", NOW - 120);
  return fixture;
};
const insertPage = (sqlite: DatabaseSync, prefix: string, timestamp: number) => {
  for (let index = 0; index < 501; index++) {
    insertEvent(sqlite, `${prefix}-${String(index).padStart(3, "0")}`, timestamp);
  }
};

describe("healNullPrices", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW * 1000); });

  it("seeks the null-price index even when no NULL events exist", async () => {
    const { db, sqlite } = open();
    const prepare = vi.spyOn(db, "prepare");
    const result = await healNullPrices(db, NOW);
    expect(sqlite.prepare(`EXPLAIN QUERY PLAN ${prepare.mock.calls[0][0]}`).all(NOW)).toContainEqual(
      expect.objectContaining({ detail: expect.stringMatching(/SEARCH mint_burn_events USING INDEX idx_mbe_null_price_ts \(timestamp>\?\)/) }),
    );
    expect(result.healed).toBe(0);
    expect(result.affectedHours.size).toBe(0);
  });

  it.each([
    [true, NOW - 3600, NOW - 7200, false],
    [false, NOW - 3600, NOW - 3600 - 106 * 3600, false],
    [true, NOW - 2 * DAY, NOW - 3 * DAY, true],
    [true, NOW - 2 * DAY, NOW - DAY, true],
    [true, day(NOW) - 1, day(NOW) + 1, true],
  ] as const)("persists the observation clock from the preferred admissible source (%s, %s, %s, sparse=%s)", async (validSnapshot, eventAt, observedAt, sparse) => {
    const results = [];
    for (const legacy of [true, false]) {
      const { db, sqlite } = open();
      const dayTs = day(eventAt);
      const start = day(NOW) - 4 * DAY;
      insertEvent(sqlite, "e1", eventAt, USDC, 1000);
      const history = insertHistory(sqlite);
      if (!sparse) for (let day = 1; day <= 1000; day++) history.run(USDC, dayTs - day * DAY, 1.4, NOW - 3000);
      history.run(USDC, sparse ? day(observedAt) : dayTs, 0.98, observedAt);
      if (!sparse) insertCache(sqlite, validSnapshot ? NOW : NOW - 600, USDC, { price: validSnapshot ? 1.05 : 1 });
      const prepare = db.prepare.bind(db);
      let sql = "";
      vi.spyOn(db, "prepare").mockImplementation((query) => {
        const stmt = prepare(query), bind = stmt.bind.bind(stmt);
        if (query.includes("FROM supply_history")) {
          sql = query;
          vi.spyOn(stmt, "bind").mockImplementation((...args) => {
            expect.soft(args).toEqual([USDC, start]);
            return legacy ? prepare(query.replace("AND snapshot_date >= ?", "")).bind(args[0]) : bind(...args);
          });
        }
        return stmt;
      });
      expect((await healNullPrices(db, NOW)).healed).toBe(1);
      expect(sqlite.prepare(sql).all(USDC, start)).toEqual(
        sqlite.prepare(sql.replace("AND snapshot_date >= ?", "")).all(USDC).filter((row) => Number(row.snapshot_date) >= start),
      );
      expect(sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(USDC, start).map((row) => row.detail))
        .toContain("SEARCH supply_history USING INDEX sqlite_autoindex_supply_history_1 (stablecoin_id=? AND snapshot_date>?)");
      const row = sqlite.prepare("SELECT amount_usd, price_used, price_timestamp, price_source FROM mint_burn_events WHERE id = 'e1'").get();
      expect(row)
        .toEqual({ amount_usd: validSnapshot ? 980 : 1000, price_used: validSnapshot ? 0.98 : 1,
          price_timestamp: validSnapshot ? observedAt : NOW - 600,
          price_source: validSnapshot ? "supply-history-heal" : "price_cache_heal" });
      results.push(row);
    }
    expect(results[0]).toEqual(results[1]);
  });

  it.each([
    ["missing", null],
    ["a non-replay-safe source", { source: "coingecko-native-implied" }],
    ["a search-derived source", { source: "dexscreener-search" }],
    ["a nominal reference", { mode: "nominal_reference" }],
    ["a non-positive price", { price: 0 }],
  ] as const)("leaves amount_usd NULL when the cache observation is %s", async (_label, cache) => {
    const { db, sqlite } = open();
    insertEvent(sqlite, "e1", NOW - 3600, USDC, 1000);
    if (cache) insertCache(sqlite, NOW, USDC, cache);
    expect((await healNullPrices(db, NOW)).healed).toBe(0);
    expect(sqlite.prepare("SELECT amount_usd FROM mint_burn_events").get()).toEqual({ amount_usd: null });
    expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
  });

  describe("against SQLite", () => {
    it.each(["source", "enqueue"])("rolls back both source and debt when the %s statement fails", async (failure) => {
      const { sqlite } = pricedFixture();
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
      const { db, sqlite } = pricedFixture();
      sqlite.prepare("UPDATE mint_burn_events SET price_repair_status = 'pending_aggregate'").run();
      insertEvent(sqlite, "review", NOW - 119);
      sqlite.prepare(`UPDATE mint_burn_events SET direction = 'burn', burn_type = 'review_required', amount_usd = 100
        WHERE id = 'review'`).run();
      const hour = Math.floor((NOW - 120) / 3600) * 3600;
      sqlite.prepare(`INSERT INTO mint_burn_hourly
        (stablecoin_id, chain_id, hour_ts, mint_count, mint_volume_usd, mint_unresolved_event_count, burn_unresolved_event_count)
        VALUES ('usdc-circle', 'ethereum', ?, 1, 7, 0, 1)`).run(hour);
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
      expect(sqlite.prepare("SELECT mint_volume_usd, mint_unpriced_event_count, mint_unresolved_event_count, burn_unresolved_event_count FROM mint_burn_hourly").get())
        .toEqual({ mint_volume_usd: 101, mint_unpriced_event_count: 0, mint_unresolved_event_count: 0, burn_unresolved_event_count: 1 });
      expect(sqlite.prepare("SELECT price_repair_status FROM mint_burn_events").get())
        .toEqual({ price_repair_status: "recovered" });
      expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
    });

    it("reads a newer mutation during rebuild and preserves debt re-enqueued after clear", async () => {
      const { db, sqlite } = pricedFixture();
      const first = await healNullPrices(db, NOW);
      insertEvent(sqlite, "second", NOW - 119);
      await healNullPrices(db, NOW);
      await rebuildMintBurnMaterializationHours(db, first.affectedHours);
      expect(sqlite.prepare("SELECT mint_count, mint_volume_usd FROM mint_burn_hourly").get())
        .toEqual({ mint_count: 2, mint_volume_usd: 202 });
      insertEvent(sqlite, "third", NOW - 118);
      await healNullPrices(db, NOW);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_dirty_hours").get()).toEqual({ count: 1 });
      expect(sqlite.prepare("SELECT mint_count FROM mint_burn_hourly").get()).toEqual({ mint_count: 2 });
      await rebuildMintBurnMaterializationHours(db, first.affectedHours);
      expect(sqlite.prepare("SELECT mint_count, mint_volume_usd FROM mint_burn_hourly").get())
        .toEqual({ mint_count: 3, mint_volume_usd: 303 });
      expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
    });

    it("admits observations within ±24h inclusive of the event and rejects ±24h±1s and old events", async () => {
      const { db, sqlite } = open();
      const usdtObservedAt = NOW - 1_000;
      const usdcObservedAt = NOW - 100_000;
      insertCache(sqlite, usdtObservedAt, USDT);
      insertCache(sqlite, usdcObservedAt);
      for (const [id, coin, time] of [
        ["obs-minus-24h-1s", USDT, usdtObservedAt + (DAY + 1)],
        ["obs-exact", USDT, usdtObservedAt],
        ["obs-minus-24h", USDC, usdcObservedAt + DAY],
        ["obs-plus-24h", USDT, usdtObservedAt - DAY],
        ["obs-plus-24h-1s", USDT, usdtObservedAt - (DAY + 1)],
        ["old-event-current-quote", USDT, NOW - 170_000],
      ] as const) insertEvent(sqlite, id, time, coin);

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
      const { db, sqlite } = open();
      insertCache(sqlite, NOW + 60, USDT);
      insertEvent(sqlite, "e1", NOW - 60, USDT);

      expect((await healNullPrices(db, NOW)).healed).toBe(0);
    });

    it("never admits a legacy snapshot without a recorded observation clock", async () => {
      const { db, sqlite } = open();
      const dayTs = day(NOW);
      insertHistory(sqlite).run(USDT, dayTs, 1, null);
      insertEvent(sqlite, "e1", NOW - 60, USDT);

      expect((await healNullPrices(db, NOW)).healed).toBe(0);

      sqlite.prepare("UPDATE supply_history SET price_observed_at = ? WHERE stablecoin_id = 'usdt-tether'").run(NOW - 120);
      expect((await healNullPrices(db, NOW)).healed).toBe(1);
      expect(sqlite.prepare("SELECT price_timestamp, price_source FROM mint_burn_events WHERE id = 'e1'").get())
        .toEqual({ price_timestamp: NOW - 120, price_source: "supply-history-heal" });
    });

    it("never treats a legacy protocol-redeem par row of a nominal-par route as an observation", async () => {
      const { db, sqlite } = open();
      insertCache(sqlite, NOW - 60, "usbd-bima", { price: 1, source: "protocol-redeem" });
      insertEvent(sqlite, "usbd", NOW - 120, "usbd-bima");
      expect((await healNullPrices(db, NOW)).healed).toBe(0);

      sqlite.prepare("DELETE FROM price_cache WHERE asset_id = 'usbd-bima'").run();
      insertCache(sqlite, NOW - 60, "usbd-bima");
      expect((await healNullPrices(db, NOW)).healed).toBe(1);
    });

    it("skips coins without admissible evidence so their rows cannot starve healable coins", async () => {
      const { db, sqlite } = open();
      for (let index = 0; index < 600; index++) {
        insertEvent(sqlite, `stale-${String(index).padStart(3, "0")}`, NOW - index);
      }
      insertCache(sqlite, NOW - 30 * DAY);
      insertEvent(sqlite, "healable", NOW - 3_600, USDT);
      insertCache(sqlite, NOW - 3_000, USDT);

      expect((await healNullPrices(db, NOW)).healed).toBe(1);
      expect(sqlite.prepare("SELECT id FROM mint_burn_events WHERE amount_usd IS NOT NULL").all())
        .toEqual([{ id: "healable" }]);
    });

    it("resumes past 501 ineligible same-coin rows despite restart, cursor deletion and newer arrivals", async () => {
      const { db, sqlite } = open();
      insertPage(sqlite, "stale", NOW - 60);
      insertCache(sqlite, NOW - 36 * 3600);
      insertEvent(sqlite, "healable", NOW - 36 * 3600);

      expect((await healNullPrices(db, NOW)).healed).toBe(0);
      const checkpoint = sqlite.prepare("SELECT value FROM cache WHERE key = 'mint-burn-price-heal-cursor:v1'");
      expect(JSON.parse(checkpoint.get()!.value as string)).toEqual({ timestamp: NOW - 60, id: "stale-001" });
      sqlite.prepare("DELETE FROM mint_burn_events WHERE id = 'stale-001'").run();
      insertPage(sqlite, "arrival", NOW);

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

      sqlite.prepare("UPDATE price_cache SET observed_at = ?, updated_at = ?").run(NOW - 60, NOW - 60);
      for (const expected of [500, 500, 1]) {
        expect((await healNullPrices(createSqliteD1(sqlite), NOW + 2)).healed).toBe(expected);
      }
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events WHERE amount_usd IS NULL").get())
        .toEqual({ count: 0 });
    });

    it.each(["{", JSON.stringify({ timestamp: NOW - 2 * DAY - 1, id: "expired" })])(
      "starts a fresh pass when its durable checkpoint is invalid or outside the lookback (%s)",
      async (value) => {
        const { db, sqlite } = open();
        sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('mint-burn-price-heal-cursor:v1', ?, ?)")
          .run(value, NOW);
        insertCache(sqlite, NOW);
        insertEvent(sqlite, "recent", NOW - 60);
        expect((await healNullPrices(db, NOW)).healed).toBe(1);
        expect(sqlite.prepare("SELECT amount_usd FROM mint_burn_events WHERE id = 'recent'").get())
          .toEqual({ amount_usd: 101 });
      },
    );

    it("heals the newest 500 rows with deterministic ID ordering at tied timestamps", async () => {
      const { db, sqlite } = open();
      insertPage(sqlite, "event", NOW);
      insertEvent(sqlite, "older", NOW - 1);
      insertCache(sqlite, NOW);

      expect((await healNullPrices(db, NOW)).healed).toBe(500);
      expect(sqlite.prepare("SELECT id FROM mint_burn_events WHERE amount_usd IS NULL ORDER BY id").all())
        .toEqual([{ id: "event-000" }, { id: "older" }]);
      expect(sqlite.prepare("SELECT amount_usd, price_used FROM mint_burn_events WHERE id = 'event-500'").get())
        .toEqual({ amount_usd: 101, price_used: 1.01 });
      insertEvent(sqlite, "new-arrival", NOW + 1);
      expect((await healNullPrices(createSqliteD1(sqlite), NOW + 1)).healed).toBe(2);
      expect(sqlite.prepare("SELECT id FROM mint_burn_events WHERE amount_usd IS NULL").all())
        .toEqual([{ id: "new-arrival" }]);
      expect((await healNullPrices(createSqliteD1(sqlite), NOW + 1)).healed).toBe(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events WHERE amount_usd IS NULL").get())
        .toEqual({ count: 0 });
    });
  });
});
