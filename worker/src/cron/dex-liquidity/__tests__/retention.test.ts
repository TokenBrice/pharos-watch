import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import { pruneOldDexLiquidityGenerations } from "../persistence";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

const openDatabases: ReturnType<typeof createLatestSchemaSqlite>["sqlite"][] = [];

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe("DEX liquidity generation retention", () => {
  it("drains oldest terminal generations in bounded passes while protecting current, active, recent, and boundary rows", async () => {
    const harness = createLatestSchemaSqlite();
    openDatabases.push(harness.sqlite);
    const nowSec = 1_700_000_000;
    const cutoff = nowSec - 3 * 60 * 60;
    const insertGeneration = harness.sqlite.prepare(
      `INSERT INTO dex_liquidity_publication_generations (
         generation_id, started_at, state, expected_row_count,
         written_row_count, created_at
       ) VALUES (?, ?, ?, 1, 1, ?)`,
    );
    const insertRunRow = harness.sqlite.prepare(
      `INSERT INTO dex_liquidity_run_rows (
         generation_id, stablecoin_id, symbol, updated_at
       ) VALUES (?, ?, 'TST', ?)`,
    );
    const seed = (generationId: string, startedAt: number, state: "staged" | "published" | "failed") => {
      insertGeneration.run(generationId, startedAt, state, startedAt);
      insertRunRow.run(generationId, `coin-${generationId}`, startedAt);
    };

    for (let index = 0; index < 18; index++) {
      seed(`expired-${index.toString().padStart(2, "0")}`, cutoff - 1_000 + index, "failed");
    }
    seed("at-cutoff", cutoff, "failed");
    seed("abandoned-staged", cutoff - 5_000, "staged");
    seed("recent-staged", cutoff + 1, "staged");
    seed("recent-failed", cutoff + 1, "failed");
    seed("current-published", cutoff - 10_000, "published");
    seed("inactive-public-row", cutoff - 9_000, "published");
    harness.sqlite.prepare(
      `INSERT INTO dex_liquidity (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state)
       VALUES ('__global__', 'ALL', ?, 'current-published', 'published')`,
    ).run(nowSec);
    harness.sqlite.prepare(
      `INSERT INTO dex_liquidity (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state)
       VALUES ('inactive-coin', 'OLD', ?, 'inactive-public-row', 'published')`,
    ).run(nowSec - 9_000);

    const first = await pruneOldDexLiquidityGenerations(harness.db, nowSec);
    const second = await pruneOldDexLiquidityGenerations(harness.db, nowSec);

    expect(first).toMatchObject({
      cutoff,
      deletedRunRows: 16,
      deletedGenerationRows: 15,
      deletedRows: 31,
      error: null,
    });
    expect(second).toMatchObject({
      deletedRunRows: 4,
      deletedGenerationRows: 4,
      deletedRows: 8,
      error: null,
    });
    expect(
      harness.sqlite
        .prepare("SELECT generation_id FROM dex_liquidity_publication_generations ORDER BY generation_id")
        .all()
        .map((row) => row.generation_id),
    ).toEqual([
      "at-cutoff",
      "current-published",
      "inactive-public-row",
      "recent-failed",
      "recent-staged",
    ]);
    expect(
      harness.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM dex_liquidity_run_rows WHERE generation_id = 'current-published'",
      ).get(),
    ).toEqual({ count: 1 });
    expect(
      harness.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM dex_liquidity_run_rows WHERE generation_id = 'inactive-public-row'",
      ).get(),
    ).toEqual({ count: 0 });
  });

  it("reports cleanup errors without throwing", async () => {
    const db = makeNoopD1({
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("liquidity retention unavailable");
          },
        }),
      }),
    });

    const retention = await pruneOldDexLiquidityGenerations(db, 1_700_000_000);

    expect(retention.deletedRows).toBe(0);
    expect(retention.error).toBe("liquidity retention unavailable");
  });

  it("does not let public references without run rows exhaust the bounded candidate set", async () => {
    const harness = createLatestSchemaSqlite();
    openDatabases.push(harness.sqlite);
    const nowSec = 1_700_000_000;
    const cutoff = nowSec - 3 * 60 * 60;
    const insertGeneration = harness.sqlite.prepare(
      `INSERT INTO dex_liquidity_publication_generations (
         generation_id, started_at, state, expected_row_count,
         written_row_count, created_at
       ) VALUES (?, ?, 'published', 1, 1, ?)`,
    );

    for (let index = 0; index < 16; index++) {
      const generationId = `stale-public-${index.toString().padStart(2, "0")}`;
      const startedAt = cutoff - 1_000 + index;
      insertGeneration.run(generationId, startedAt, startedAt);
      harness.sqlite.prepare(
        `INSERT INTO dex_liquidity (
           stablecoin_id, symbol, updated_at, publication_generation_id, publication_state
         ) VALUES (?, 'OLD', ?, ?, 'published')`,
      ).run(`inactive-${index}`, startedAt, generationId);
    }

    insertGeneration.run("expired-unreferenced", cutoff - 500, cutoff - 500);
    harness.sqlite.prepare(
      `INSERT INTO dex_liquidity_run_rows (
         generation_id, stablecoin_id, symbol, updated_at
       ) VALUES ('expired-unreferenced', 'expired-coin', 'TST', ?)`,
    ).run(cutoff - 500);

    const retention = await pruneOldDexLiquidityGenerations(harness.db, nowSec);

    expect(retention).toMatchObject({
      deletedRunRows: 1,
      deletedGenerationRows: 1,
      deletedRows: 2,
      error: null,
    });
    expect(
      harness.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM dex_liquidity_run_rows WHERE generation_id = 'expired-unreferenced'",
      ).get(),
    ).toEqual({ count: 0 });
    expect(
      harness.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM dex_liquidity_publication_generations WHERE generation_id = 'expired-unreferenced'",
      ).get(),
    ).toEqual({ count: 0 });
    expect(
      harness.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM dex_liquidity_publication_generations WHERE generation_id LIKE 'stale-public-%'",
      ).get(),
    ).toEqual({ count: 16 });
  });
});
