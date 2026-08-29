import { afterEach, describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  DEX_PRICE_SCENARIOS,
  insertPublicPrice,
  makeObservationMap,
  makePricePoolMap,
  readPublicPriceRows,
  readPublicPrices,
  seedPublishedDexGeneration as createPublishedDexGeneration,
  type PriceScenario,
  type PublicPriceRow,
  type SeedGenerationOptions,
  makeUsdPricePools,
} from "../dex-liquidity/__tests__/scoring-test-support";
import {
  computeDepthStability,
  computeDexPrices,
  DEX_PRICE_STAGE_RETENTION_GENERATIONS_PER_RUN,
  pruneExpiredDexPriceStages,
} from "../dex-liquidity/scoring";
import type { DexPriceObs, PoolEntry } from "../dex-liquidity/types";

const NOW_SEC = 1_700_000_000;
const GENERATION_ID = `dex-liquidity-${NOW_SEC}`;
const EXPECTED_GENERATION_ROWS = ACTIVE_STABLECOINS.length + 1;
const openSqlite: Array<import("node:sqlite").DatabaseSync> = [];

function seedPublishedDexGeneration(options: SeedGenerationOptions = {}): {
  sqlite: import("node:sqlite").DatabaseSync;
  db: D1Database;
  generationId: string;
} {
  const fixture = createPublishedDexGeneration(options);
  openSqlite.push(fixture.sqlite);
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

function computePriceGeneration(
  db: D1Database,
  retainedPools: Map<string, PoolEntry[]>,
  nowSec: number,
  generationId = `dex-liquidity-${nowSec}`,
  preloadedPrimaryPrices?: Map<string, number>,
  exactPriceEvidence?: Map<string, DexPriceObs[]>,
) {
  return computeDexPrices(
    db,
    retainedPools,
    nowSec,
    undefined,
    undefined,
    exactPriceEvidence,
    generationId,
    preloadedPrimaryPrices,
  );
}

function expectPriceStageEmpty(sqlite: import("node:sqlite").DatabaseSync, generationId: string): void {
  expect(
    sqlite
      .prepare("SELECT COUNT(*) AS count FROM dex_price_run_rows WHERE generation_id = ?")
      .get(generationId),
  ).toEqual({ count: 0 });
}

async function runPriceScenario(scenario: PriceScenario): Promise<{
  sqlite: import("node:sqlite").DatabaseSync;
  db: D1Database;
  generationId: string;
  steps: Array<{ rows: PublicPriceRow[]; diagnostics: unknown }>;
}> {
  const fixture = seedPublishedDexGeneration({ nowSec: scenario.nowSec });
  for (const row of scenario.existingPrices ?? []) {
    insertPublicPrice(fixture.sqlite, row.stablecoinId, row.symbol, row.price, row.updatedAt ?? scenario.nowSec - 1);
  }
  if (scenario.cacheValue !== undefined) {
    fixture.sqlite
      .prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
      .run(scenario.cacheValue, scenario.nowSec - 1);
  }

  const steps: Array<{ rows: PublicPriceRow[]; diagnostics: unknown }> = [];
  for (const step of scenario.steps) {
    const stepNowSec = step.nowSec ?? scenario.nowSec;
    const diagnostics = await computePriceGeneration(
      fixture.db,
      makePricePoolMap(step.retainedPools ?? []),
      stepNowSec,
      fixture.generationId,
      step.primaryPrices === undefined ? undefined : new Map(step.primaryPrices),
      step.exactPriceEvidence === undefined ? undefined : makeObservationMap(step.exactPriceEvidence),
    );
    steps.push({ rows: readPublicPriceRows(fixture.sqlite), diagnostics });
  }
  return { ...fixture, steps };
}

function expectCompleteGeneration(
  sqlite: import("node:sqlite").DatabaseSync,
  generationId: string,
  expected: PriceScenario["expectedGeneration"],
): void {
  if (!expected) return;
  expect(
    sqlite
      .prepare("SELECT state, expected_row_count, current_row_count FROM dex_liquidity_publication_generations WHERE generation_id = ?")
      .get(generationId),
  ).toEqual(expected);
}

afterEach(() => {
  while (openSqlite.length > 0) openSqlite.pop()?.close();
});

describe("DEX scoring publication atomicity", () => {
  it("keeps the previous dex_prices generation when a later staging batch fails", async () => {
    const { sqlite, db } = seedPublishedDexGeneration();
    const before = readPublicPrices(sqlite);

    await expect(
      computePriceGeneration(failAfterSuccessfulBatches(db, 1), makeUsdPricePools(30), NOW_SEC),
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
      computePriceGeneration(failAfterSuccessfulBatches(db, 2), makeUsdPricePools(30), NOW_SEC),
    ).rejects.toThrow("injected D1 batch failure");

    expect(readPublicPrices(sqlite)).toEqual(before);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM dex_price_run_rows WHERE generation_id = ?").get(GENERATION_ID),
    ).toEqual({ count: 30 });
  });

  it("replays an ambiguous post-commit publication without emptying dex_prices", async () => {
    const { sqlite, db } = seedPublishedDexGeneration();

    await computePriceGeneration(failOnceAfterCommittedPublication(db), makeUsdPricePools(30), NOW_SEC);

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
      computePriceGeneration(supersedeBeforePublication(db, sqlite), makeUsdPricePools(30), NOW_SEC),
    ).rejects.toThrow("price publication fence/replacement changed 0 rows");

    expect(readPublicPrices(sqlite)).toEqual(before);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM dex_price_run_rows WHERE generation_id = ?").get(GENERATION_ID),
    ).toEqual({ count: 30 });
  });

  it("republishes prices against a complete generation from a pre-roster-change deploy", async () => {
    // Regression: 2026-08-18 23:16Z — a coin quarantine deployed between the
    // even-hour publication and the odd-hour reuse slot shrank the active
    // roster by one, and the completeness guard compared the (internally
    // consistent) published generation against the new bundle's roster count
    // and threw "is not the complete current publication". The guard must
    // compare the generation against its own recorded expectation instead.
    const { sqlite, db } = seedPublishedDexGeneration();
    const retiredCoinId = "roster-drift-retired-coin";
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite
        .prepare(
          `INSERT INTO dex_liquidity_run_rows
            (generation_id, stablecoin_id, symbol, depth_stability, updated_at)
           VALUES (?, ?, 'RETD', 0.25, ?)`,
        )
        .run(GENERATION_ID, retiredCoinId, NOW_SEC);
      sqlite
        .prepare(
          `INSERT INTO dex_liquidity
            (stablecoin_id, symbol, depth_stability, updated_at, publication_generation_id, publication_state)
           VALUES (?, 'RETD', 0.25, ?, ?, 'published')`,
        )
        .run(retiredCoinId, NOW_SEC, GENERATION_ID);
      sqlite
        .prepare(
          `UPDATE dex_liquidity_publication_generations
           SET expected_row_count = ?, written_row_count = ?, current_row_count = ?
           WHERE generation_id = ?`,
        )
        .run(
          EXPECTED_GENERATION_ROWS + 1,
          EXPECTED_GENERATION_ROWS + 1,
          EXPECTED_GENERATION_ROWS + 1,
          GENERATION_ID,
        );
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }

    await computePriceGeneration(db, makeUsdPricePools(30), NOW_SEC);

    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM dex_prices WHERE updated_at = ?").get(NOW_SEC),
    ).toEqual({ count: 30 });
  });

  it("publishes only eligible depth-stability rows and propagates DB failures", async () => {
    const { sqlite, db } = seedPublishedDexGeneration();

    await computeDepthStability(
      db,
      new Map([["usdt-tether", 0.9]]),
      GENERATION_ID,
    );

    const publicDepthRows = sqlite
      .prepare(
        `SELECT stablecoin_id, depth_stability, publication_generation_id, publication_state
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__'
         ORDER BY stablecoin_id`,
      )
      .all();
    expect(publicDepthRows).toEqual(
      ACTIVE_STABLECOINS
        .map((coin) => ({
          stablecoin_id: coin.id,
          depth_stability: coin.id === "usdt-tether" ? 0.9 : null,
          publication_generation_id: GENERATION_ID,
          publication_state: "published",
        }))
        .sort((a, b) => a.stablecoin_id.localeCompare(b.stablecoin_id)),
    );
    expect(
      sqlite
        .prepare(
          `SELECT stablecoin_id, depth_stability
           FROM dex_liquidity_run_rows
           WHERE generation_id = ? AND stablecoin_id != '__global__'
           ORDER BY stablecoin_id`,
        )
        .all(GENERATION_ID),
    ).toEqual(
      ACTIVE_STABLECOINS
        .map((coin) => ({
          stablecoin_id: coin.id,
          depth_stability: coin.id === "usdt-tether" ? 0.9 : null,
        }))
        .sort((a, b) => a.stablecoin_id.localeCompare(b.stablecoin_id)),
    );
    expect(
      sqlite
        .prepare(
          `SELECT state, expected_row_count, written_row_count, current_row_count
           FROM dex_liquidity_publication_generations
           WHERE generation_id = ?`,
        )
        .get(GENERATION_ID),
    ).toEqual({
      state: "published",
      expected_row_count: EXPECTED_GENERATION_ROWS,
      written_row_count: EXPECTED_GENERATION_ROWS,
      current_row_count: EXPECTED_GENERATION_ROWS,
    });

    const failed = seedPublishedDexGeneration();
    await expect(
      computeDepthStability(
        failAfterSuccessfulBatches(failed.db, 0),
        new Map([["usdt-tether", 0.9]]),
        failed.generationId,
      ),
    ).rejects.toThrow("injected D1 batch failure");
    expect(
      failed.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM dex_liquidity
           WHERE stablecoin_id != '__global__' AND depth_stability = 0.25`,
        )
        .get(),
    ).toEqual({ count: ACTIVE_STABLECOINS.length });
  });

  for (const scenario of DEX_PRICE_SCENARIOS) {
    it(scenario.label, async () => {
      const result = await runPriceScenario(scenario);
      for (const [index, step] of scenario.steps.entries()) {
        const actual = result.steps[index];
        expect(actual?.rows).toEqual(step.expectedRows);
        expectPriceStageEmpty(result.sqlite, result.generationId);
        if (step.expectedDiagnostics !== undefined) {
          const expected = step.expectedDiagnostics as {
            retention?: { durationMs?: unknown };
          };
          expect(actual?.diagnostics).toEqual(
            expected.retention
              ? {
                  ...expected,
                  retention: {
                    ...expected.retention,
                    durationMs: expect.any(Number),
                  },
                }
              : expected,
          );
        }
      }
      expectCompleteGeneration(result.sqlite, result.generationId, scenario.expectedGeneration);
    });
  }

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
