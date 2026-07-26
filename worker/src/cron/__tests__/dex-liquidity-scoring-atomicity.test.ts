import { afterEach, describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  computeDepthStability,
  computeDexPrices,
  DEX_PRICE_STAGE_RETENTION_GENERATIONS_PER_RUN,
  pruneExpiredDexPriceStages,
} from "../dex-liquidity/scoring";
import type { PoolEntry } from "../dex-liquidity/types";

const NOW_SEC = 1_700_000_000;
const GENERATION_ID = `dex-liquidity-${NOW_SEC}`;
const EXPECTED_GENERATION_ROWS = ACTIVE_STABLECOINS.length + 1;
const openSqlite: Array<import("node:sqlite").DatabaseSync> = [];

function seedPublishedDexGeneration(): {
  sqlite: import("node:sqlite").DatabaseSync;
  db: D1Database;
} {
  const fixture = createLatestSchemaSqlite();
  openSqlite.push(fixture.sqlite);
  fixture.sqlite
    .prepare(
      `INSERT INTO dex_liquidity_publication_generations
        (generation_id, started_at, state, expected_row_count, written_row_count,
         current_row_count, created_at, published_at)
       VALUES (?, ?, 'published', ?, ?, ?, ?, ?)`,
    )
    .run(
      GENERATION_ID,
      NOW_SEC,
      EXPECTED_GENERATION_ROWS,
      EXPECTED_GENERATION_ROWS,
      EXPECTED_GENERATION_ROWS,
      NOW_SEC,
      NOW_SEC,
    );

  const insertStaged = fixture.sqlite.prepare(
    `INSERT INTO dex_liquidity_run_rows
      (generation_id, stablecoin_id, symbol, depth_stability, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertPublic = fixture.sqlite.prepare(
    `INSERT INTO dex_liquidity
      (stablecoin_id, symbol, depth_stability, updated_at, publication_generation_id, publication_state)
     VALUES (?, ?, ?, ?, ?, 'published')`,
  );
  fixture.sqlite.exec("BEGIN IMMEDIATE");
  try {
    for (const coin of ACTIVE_STABLECOINS) {
      insertStaged.run(GENERATION_ID, coin.id, coin.symbol, 0.25, NOW_SEC);
      insertPublic.run(coin.id, coin.symbol, 0.25, NOW_SEC, GENERATION_ID);
    }
    insertStaged.run(GENERATION_ID, "__global__", "__global__", null, NOW_SEC);
    insertPublic.run("__global__", "__global__", null, NOW_SEC, GENERATION_ID);
    fixture.sqlite.exec("COMMIT");
  } catch (error) {
    fixture.sqlite.exec("ROLLBACK");
    throw error;
  }

  fixture.sqlite
    .prepare(
      `INSERT INTO dex_prices
        (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl, updated_at)
       VALUES ('legacy-a', 'OLDA', 0.91, 1, 100000, ?),
              ('legacy-b', 'OLDB', 1.09, 1, 100000, ?)`,
    )
    .run(NOW_SEC - 1, NOW_SEC - 1);
  return fixture;
}

function failAfterSuccessfulBatches(db: D1Database, successfulBatchLimit: number): D1Database {
  let successfulBatches = 0;
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      if (successfulBatches >= successfulBatchLimit) {
        throw new Error("injected D1 batch failure");
      }
      const result = await db.batch<T>(statements);
      successfulBatches++;
      return result;
    },
  } as unknown as D1Database;
}

function failOnceAfterCommittedPublication(db: D1Database): D1Database {
  let batchCount = 0;
  let injected = false;
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      batchCount++;
      const result = await db.batch<T>(statements);
      if (batchCount === 3 && !injected) {
        injected = true;
        throw new Error("D1_ERROR: internal error; reference injected-post-commit");
      }
      return result;
    },
  } as unknown as D1Database;
}

function supersedeBeforePublication(
  db: D1Database,
  sqlite: import("node:sqlite").DatabaseSync,
): D1Database {
  let batchCount = 0;
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      batchCount++;
      if (batchCount === 3) {
        const nextGenerationId = `${GENERATION_ID}-superseding`;
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          sqlite
            .prepare(
              `INSERT INTO dex_liquidity_publication_generations
                (generation_id, started_at, state, expected_row_count, written_row_count,
                 current_row_count, created_at, published_at)
               VALUES (?, ?, 'published', ?, ?, ?, ?, ?)`,
            )
            .run(
              nextGenerationId,
              NOW_SEC + 1,
              EXPECTED_GENERATION_ROWS,
              EXPECTED_GENERATION_ROWS,
              EXPECTED_GENERATION_ROWS,
              NOW_SEC + 1,
              NOW_SEC + 1,
            );
          sqlite
            .prepare("UPDATE dex_liquidity_run_rows SET generation_id = ? WHERE generation_id = ?")
            .run(nextGenerationId, GENERATION_ID);
          sqlite
            .prepare("UPDATE dex_liquidity SET publication_generation_id = ?")
            .run(nextGenerationId);
          sqlite.exec("COMMIT");
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      }
      return db.batch<T>(statements);
    },
  } as unknown as D1Database;
}

function makePricePools(count: number): Map<string, PoolEntry[]> {
  const usdCoins = ACTIVE_STABLECOINS.filter((coin) => coin.flags.pegCurrency === "USD").slice(0, count);
  if (usdCoins.length !== count) throw new Error(`Expected ${count} active USD stablecoins for the fixture`);
  return new Map(
    usdCoins.map((coin, index) => [
      coin.id,
      [{
        poolId: `ethereum:atomicity-${index}`,
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 100_000,
        symbol: `${coin.symbol}/USDC`,
        volumeUsd1d: 0,
        volumeUsd7d: null,
        poolType: "stable",
        source: "dl",
        price: 1,
      } satisfies PoolEntry],
    ]),
  );
}

function readPublicPrices(sqlite: import("node:sqlite").DatabaseSync): unknown[] {
  return sqlite
    .prepare("SELECT stablecoin_id, symbol, dex_price_usd, updated_at FROM dex_prices ORDER BY stablecoin_id")
    .all();
}

afterEach(() => {
  while (openSqlite.length > 0) openSqlite.pop()?.close();
});

describe("DEX scoring publication atomicity", () => {
  it("keeps the previous dex_prices generation when a later staging batch fails", async () => {
    const { sqlite, db } = seedPublishedDexGeneration();
    const before = readPublicPrices(sqlite);

    await expect(
      computeDexPrices(failAfterSuccessfulBatches(db, 1), makePricePools(30), NOW_SEC),
    ).rejects.toThrow("injected D1 batch failure");

    expect(readPublicPrices(sqlite)).toEqual(before);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM dex_price_run_rows WHERE generation_id = ?").get(GENERATION_ID),
    ).toEqual({ count: 25 });
  });

  it("keeps the previous dex_prices generation when the final atomic batch fails", async () => {
    const { sqlite, db } = seedPublishedDexGeneration();
    const before = readPublicPrices(sqlite);

    await expect(
      computeDexPrices(failAfterSuccessfulBatches(db, 2), makePricePools(30), NOW_SEC),
    ).rejects.toThrow("injected D1 batch failure");

    expect(readPublicPrices(sqlite)).toEqual(before);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM dex_price_run_rows WHERE generation_id = ?").get(GENERATION_ID),
    ).toEqual({ count: 30 });
  });

  it("replays an ambiguous post-commit publication without emptying dex_prices", async () => {
    const { sqlite, db } = seedPublishedDexGeneration();

    await computeDexPrices(failOnceAfterCommittedPublication(db), makePricePools(30), NOW_SEC);

    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM dex_prices WHERE updated_at = ?").get(NOW_SEC),
    ).toEqual({ count: 30 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM dex_prices").get()).toEqual({ count: 30 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM dex_price_run_rows WHERE generation_id = ?").get(GENERATION_ID),
    ).toEqual({ count: 0 });
  });

  it("rejects publication when a newer generation becomes current before the atomic write", async () => {
    const { sqlite, db } = seedPublishedDexGeneration();
    const before = readPublicPrices(sqlite);

    await expect(
      computeDexPrices(supersedeBeforePublication(db, sqlite), makePricePools(30), NOW_SEC),
    ).rejects.toThrow("price publication fence/replacement changed 0 rows");

    expect(readPublicPrices(sqlite)).toEqual(before);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM dex_price_run_rows WHERE generation_id = ?").get(GENERATION_ID),
    ).toEqual({ count: 30 });
  });

  it("prunes only a bounded set of expired failed stages and protects live generations", async () => {
    const { sqlite, db } = seedPublishedDexGeneration();
    const explicitlyProtected = `${GENERATION_ID}-in-flight`;
    const insertStage = sqlite.prepare(
      `INSERT INTO dex_price_run_rows
        (generation_id, stablecoin_id, symbol, dex_price_usd, source_pool_count,
         source_total_tvl, updated_at)
       VALUES (?, ?, 'TST', 1, 1, 100000, ?)`,
    );
    for (let index = 0; index < 10; index++) {
      insertStage.run(`failed-${index}`, `failed-coin-${index}`, NOW_SEC - 10 * 24 * 60 * 60 + index);
    }
    insertStage.run("recent-failed", "recent-coin", NOW_SEC - 60);
    insertStage.run("at-cutoff", "boundary-coin", NOW_SEC - 3 * 60 * 60);
    insertStage.run(GENERATION_ID, "live-coin", NOW_SEC - 30 * 24 * 60 * 60);
    insertStage.run(explicitlyProtected, "in-flight-coin", NOW_SEC - 30 * 24 * 60 * 60);
    sqlite.prepare(
      `INSERT INTO dex_liquidity_publication_generations (
         generation_id, started_at, state, expected_row_count, written_row_count, created_at
       ) VALUES ('active-staged', ?, 'staged', 1, 1, ?)`,
    ).run(NOW_SEC - 30 * 24 * 60 * 60, NOW_SEC - 30 * 24 * 60 * 60);
    insertStage.run("active-staged", "active-coin", NOW_SEC - 30 * 24 * 60 * 60);

    const retention = await pruneExpiredDexPriceStages(db, explicitlyProtected, NOW_SEC);

    expect(retention.deletedRows).toBe(DEX_PRICE_STAGE_RETENTION_GENERATIONS_PER_RUN);
    expect(retention.cutoff).toBe(NOW_SEC - 3 * 60 * 60);
    expect(retention.error).toBeNull();
    expect(
      sqlite
        .prepare("SELECT generation_id FROM dex_price_run_rows ORDER BY generation_id")
        .all()
        .map((row) => row.generation_id),
    ).toEqual([
      GENERATION_ID,
      "active-staged",
      "at-cutoff",
      explicitlyProtected,
      "failed-8",
      "failed-9",
      "recent-failed",
    ].sort());
  });

  it("reports price-stage cleanup errors without throwing", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("price-stage retention unavailable");
          },
        }),
      }),
    } as unknown as D1Database;

    const retention = await pruneExpiredDexPriceStages(db, GENERATION_ID, NOW_SEC);

    expect(retention.deletedRows).toBe(0);
    expect(retention.error).toBe("price-stage retention unavailable");
  });

  it("keeps every public depth value intact when a later staging batch fails", async () => {
    const { sqlite, db } = seedPublishedDexGeneration();
    const stability = new Map(
      ACTIVE_STABLECOINS.slice(0, 60).map((coin, index) => [coin.id, 0.5 + index / 1_000] as const),
    );

    await expect(
      computeDepthStability(failAfterSuccessfulBatches(db, 1), stability, GENERATION_ID),
    ).rejects.toThrow("injected D1 batch failure");

    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM dex_liquidity
           WHERE stablecoin_id != '__global__' AND depth_stability = 0.25`,
        )
        .get(),
    ).toEqual({ count: ACTIVE_STABLECOINS.length });
  });

  it("keeps every public depth value intact when the final atomic batch fails", async () => {
    const { sqlite, db } = seedPublishedDexGeneration();
    const stability = new Map(
      ACTIVE_STABLECOINS.slice(0, 60).map((coin, index) => [coin.id, 0.5 + index / 1_000] as const),
    );

    await expect(
      computeDepthStability(failAfterSuccessfulBatches(db, 3), stability, GENERATION_ID),
    ).rejects.toThrow("injected D1 batch failure");

    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM dex_liquidity
           WHERE stablecoin_id != '__global__' AND depth_stability = 0.25`,
        )
        .get(),
    ).toEqual({ count: ACTIVE_STABLECOINS.length });
  });
});
