import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  batchExecute: vi.fn().mockResolvedValue(0),
  buildInClause: (values: readonly unknown[]) => ({
    sql: values.map(() => "?").join(", "),
    binds: [...values],
  }),
}));

vi.mock("../db-cache", () => ({
  getPriceCache: vi.fn().mockResolvedValue(new Map()),
}));

import { batchExecute } from "../db";
import { getPriceCache } from "../db-cache";
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

interface BoundStatement {
  sql: string;
  args: unknown[];
  all: () => Promise<{ results: unknown[] }>;
}

function mockDb(
  nullEvents: NullPriceEvent[] = [],
  priceHistoryRows: PriceHistoryRow[] = [],
): D1Database {
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...args: unknown[]): BoundStatement => ({
      sql,
      args,
      all: async () => {
        if (sql.includes("FROM mint_burn_events")) {
          return { results: nullEvents };
        }
        if (sql.includes("FROM supply_history")) {
          return { results: priceHistoryRows };
        }
        return { results: [] };
      },
    })),
  }));

  return makeNoopD1({
    prepare,
  });
}

describe("healNullPrices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns healed=0 when no NULL events exist", async () => {
    const db = mockDb([]);
    const result = await healNullPrices(db, NOW);
    expect(result.healed).toBe(0);
    expect(result.affectedHours.size).toBe(0);
  });

  it("resolves prices from getPriceCache and returns correct healed count", async () => {
    const events = [
      { id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 },
      { id: "e2", stablecoin_id: "usdt-tether", chain_id: "ethereum", amount: 2000, timestamp: NOW - 7200 },
    ];
    const db = mockDb(events);
    vi.mocked(getPriceCache).mockResolvedValueOnce(
      new Map([
        ["usdc-circle", { price: 1.0, updatedAt: NOW, source: "binance" }],
        ["usdt-tether", { price: 0.999, updatedAt: NOW, source: "binance" }],
      ]),
    );
    vi.mocked(batchExecute).mockResolvedValueOnce(2);

    const result = await healNullPrices(db, NOW);
    expect(result.healed).toBe(2);
    expect(batchExecute).toHaveBeenCalledTimes(1);
  });

  it("prefers historical supply_history prices over current price_cache rows", async () => {
    const dayTs = Math.floor((NOW - 3600) / 86400) * 86400;
    const events = [
      { id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 },
    ];
    const db = mockDb(events, [
      { stablecoin_id: "usdc-circle", snapshot_date: dayTs, price: 0.98 },
    ]);
    vi.mocked(getPriceCache).mockResolvedValueOnce(
      new Map([["usdc-circle", { price: 1.05, updatedAt: NOW, source: "binance" }]]),
    );
    vi.mocked(batchExecute).mockResolvedValueOnce(1);

    const result = await healNullPrices(db, NOW);

    expect(result.healed).toBe(1);
    const updateStmts = vi.mocked(batchExecute).mock.calls[0]?.[1] as unknown as BoundStatement[];
    expect(updateStmts[0].args).toEqual([
      980,
      0.98,
      dayTs,
      "supply-history-heal",
      "e1",
    ]);
  });

  it("can heal from historical supply_history when the cache row is missing", async () => {
    const dayTs = Math.floor((NOW - 3600) / 86400) * 86400;
    const events = [
      { id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 },
    ];
    const db = mockDb(events, [
      { stablecoin_id: "usdc-circle", snapshot_date: dayTs, price: 1.01 },
    ]);
    vi.mocked(getPriceCache).mockResolvedValueOnce(new Map());
    vi.mocked(batchExecute).mockResolvedValueOnce(1);

    const result = await healNullPrices(db, NOW);

    expect(result.healed).toBe(1);
    const updateStmts = vi.mocked(batchExecute).mock.calls[0]?.[1] as unknown as BoundStatement[];
    expect(updateStmts[0].args).toEqual([
      1010,
      1.01,
      dayTs,
      "supply-history-heal",
      "e1",
    ]);
  });

  it("skips events whose stablecoin has no price in price_cache", async () => {
    const events = [
      { id: "e1", stablecoin_id: "unknown-coin", chain_id: "ethereum", amount: 1000, timestamp: NOW - 3600 },
    ];
    const db = mockDb(events);
    vi.mocked(getPriceCache).mockResolvedValueOnce(new Map());

    const result = await healNullPrices(db, NOW);
    expect(result.healed).toBe(0);
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("collects correct affected hours for re-aggregation", async () => {
    const events = [
      { id: "e1", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 1000, timestamp: 3605 },
      { id: "e2", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 2000, timestamp: 3610 },
      { id: "e3", stablecoin_id: "usdc-circle", chain_id: "ethereum", amount: 500, timestamp: 7205 },
    ];
    const db = mockDb(events);
    vi.mocked(getPriceCache).mockResolvedValueOnce(
      new Map([["usdc-circle", { price: 1.0, updatedAt: NOW, source: "binance" }]]),
    );
    vi.mocked(batchExecute).mockResolvedValueOnce(3);

    const result = await healNullPrices(db, NOW);
    expect(result.affectedHours.size).toBe(2);
  });

  it("skips heal when cached price source is not replay-safe", async () => {
    const events = [
      { id: "evt1", stablecoin_id: "usdc", chain_id: "ethereum", amount: 100, timestamp: NOW - 100 },
    ];
    const db = mockDb(events);
    vi.mocked(getPriceCache).mockResolvedValueOnce(
      new Map([
        [
          "usdc",
          {
            price: 1.01,
            updatedAt: NOW - 200,
            source: "coingecko-native-implied",
          },
        ],
      ]),
    );

    const result = await healNullPrices(db, NOW);
    expect(result.healed).toBe(0);
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("defense-in-depth: skips heal when price_cache row source is dexscreener-search", async () => {
    // Even if a rogue dexscreener-search row ever landed in price_cache (the
    // post-enrichment writer filter would normally exclude it), the heal path
    // must refuse it because the registry marks search-derived sources as
    // non-replay-safe. This test complements Task 5's writer-side filter.
    const events = [
      { id: "evt1", stablecoin_id: "usdc", chain_id: "ethereum", amount: 100, timestamp: NOW - 100 },
    ];
    const db = mockDb(events);
    vi.mocked(getPriceCache).mockResolvedValueOnce(
      new Map([
        [
          "usdc",
          {
            price: 1.0,
            updatedAt: NOW - 200,
            source: "dexscreener-search",
          },
        ],
      ]),
    );

    const result = await healNullPrices(db, NOW);
    expect(result.healed).toBe(0);
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("heals the newest 500 rows with deterministic ID ordering at tied timestamps", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, tx_hash, block_number, timestamp, explorer_tx_url)
      VALUES (?, 'usdc-circle', 'USDC', 'ethereum', 'mint', 100, NULL, ?, 1, ?, '')`);
    for (let index = 0; index < 501; index++) {
      const id = `event-${String(index).padStart(3, "0")}`;
      insert.run(id, id, NOW);
    }
    insert.run("older", "older", NOW - 1);
    const actual = await vi.importActual<{ batchExecute: typeof batchExecute }>("../db");
    vi.mocked(batchExecute).mockImplementationOnce(actual.batchExecute);
    vi.mocked(getPriceCache).mockResolvedValueOnce(new Map([
      ["usdc-circle", { price: 1.01, updatedAt: NOW, source: "binance" }],
    ]));
    expect((await healNullPrices(db, NOW)).healed).toBe(500);
    expect(sqlite.prepare("SELECT id FROM mint_burn_events WHERE amount_usd IS NULL ORDER BY id").all())
      .toEqual([{ id: "event-000" }, { id: "older" }]);
    expect(sqlite.prepare("SELECT amount_usd, price_used FROM mint_burn_events WHERE id = 'event-500'").get())
      .toEqual({ amount_usd: 101, price_used: 1.01 });
  });
});
