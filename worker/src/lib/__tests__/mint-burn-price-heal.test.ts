import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  batchExecute: vi.fn().mockResolvedValue(0),
  buildInClause: (values: readonly unknown[]) => ({
    sql: values.map(() => "?").join(", "),
    binds: [...values],
  }),
}));

import { batchExecute } from "../db";
import { healNullPrices } from "../mint-burn-pipeline/price-heal";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

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
    })),
  }));

  return makeNoopD1({ prepare });
}

function healedArgs(): unknown[][] {
  const updateStmts = vi.mocked(batchExecute).mock.calls[0]?.[1] as unknown as BoundStatement[];
  return updateStmts.map((stmt) => stmt.args);
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

  it("prefers the event-day supply_history snapshot over an in-window price_cache observation", async () => {
    const dayTs = Math.floor((NOW - 3600) / 86400) * 86400;
    const db = mockDb(
      [{ id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 }],
      [{ stablecoin_id: "usdc-circle", snapshot_date: dayTs, price: 0.98 }],
      [cacheRow({ asset_id: "usdc-circle", price: 1.05 })],
    );
    vi.mocked(batchExecute).mockResolvedValueOnce(1);

    expect((await healNullPrices(db, NOW)).healed).toBe(1);
    expect(healedArgs()).toEqual([[980, 0.98, dayTs, "supply-history-heal", "e1"]]);
  });

  it("uses an in-window replay-safe observation stamped with its observation clock when no snapshot qualifies", async () => {
    const dayTs = Math.floor((NOW - 3600) / 86400) * 86400;
    const db = mockDb(
      [{ id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 }],
      [
        { stablecoin_id: "usdc-circle", snapshot_date: dayTs - 30 * 86400, price: 0.98 },
        { stablecoin_id: "usdc-circle", snapshot_date: dayTs, price: 1.4 },
      ],
      [cacheRow({ asset_id: "usdc-circle", observed_at: NOW - 600, updated_at: NOW - 600 })],
    );
    vi.mocked(batchExecute).mockResolvedValueOnce(1);

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
    expect(batchExecute).not.toHaveBeenCalled();
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
    vi.mocked(batchExecute).mockResolvedValueOnce(3);

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
      const actual = await vi.importActual<{ batchExecute: typeof batchExecute }>("../db");
      vi.mocked(batchExecute).mockImplementation(actual.batchExecute);
    });

    afterEach(() => {
      vi.mocked(batchExecute).mockReset().mockResolvedValue(0);
      vi.useRealTimers();
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
    });
  });
});
