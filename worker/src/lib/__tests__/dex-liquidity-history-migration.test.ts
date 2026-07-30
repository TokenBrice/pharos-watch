import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../migrations");
const FIXTURES_DIR = path.resolve(__dirname, "../../test-helpers/migration-fixtures");

// Migrations absorbed by the 2026-07-30 baseline squash live on as frozen test fixtures.
function resolveMigrationPath(file: string): string {
  const fixture = path.join(FIXTURES_DIR, file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled test fixture path
  return existsSync(fixture) ? fixture : path.join(MIGRATIONS_DIR, file);
}

function openSqlite(): import("node:sqlite").DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(":memory:");
}

function applyMigration(sqlite: import("node:sqlite").DatabaseSync, file: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- trusted test-only path under worker/migrations/
  sqlite.exec(readFileSync(resolveMigrationPath(file), "utf8"));
}

function createLegacyDexLiquidityHistory(sqlite: import("node:sqlite").DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE dex_liquidity_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stablecoin_id TEXT NOT NULL,
      total_tvl_usd REAL NOT NULL,
      total_volume_24h_usd REAL NOT NULL DEFAULT 0,
      liquidity_score INTEGER,
      snapshot_date INTEGER NOT NULL,
      methodology_version TEXT NOT NULL DEFAULT '3.2',
      coverage_class TEXT NOT NULL DEFAULT 'unobserved',
      coverage_confidence REAL NOT NULL DEFAULT 0,
      source_mix_json TEXT
    );

    CREATE INDEX idx_dex_hist_coin_date
      ON dex_liquidity_history(stablecoin_id, snapshot_date DESC);
  `);
}

describe("DEX liquidity history uniqueness migration", () => {
  it("keeps the latest duplicate and makes repair upserts coin/day idempotent", () => {
    const sqlite = openSqlite();
    try {
      createLegacyDexLiquidityHistory(sqlite);
      const insert = sqlite.prepare(`
        INSERT INTO dex_liquidity_history (
          stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score,
          snapshot_date, methodology_version, coverage_class, coverage_confidence, source_mix_json
        ) VALUES (?, ?, ?, ?, ?, '5.8', 'primary', 1, NULL)
      `);
      insert.run("usdt-tether", 1, 1, 10, 1_780_000_000);
      insert.run("usdt-tether", 2, 2, 20, 1_780_000_000);
      insert.run("usdc-circle", 3, 3, 30, 1_780_000_000);

      applyMigration(sqlite, "0170_dex_liquidity_history_unique_snapshot.sql");

      const dedupedRows = sqlite
        .prepare(
          `SELECT stablecoin_id, total_tvl_usd, liquidity_score
             FROM dex_liquidity_history
            ORDER BY stablecoin_id`,
        )
        .all();
      expect(dedupedRows).toEqual([
        { stablecoin_id: "usdc-circle", total_tvl_usd: 3, liquidity_score: 30 },
        { stablecoin_id: "usdt-tether", total_tvl_usd: 2, liquidity_score: 20 },
      ]);

      sqlite
        .prepare(
          `INSERT OR REPLACE INTO dex_liquidity_history (
             stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score,
             snapshot_date, methodology_version, coverage_class, coverage_confidence, source_mix_json
           ) VALUES (?, ?, ?, ?, ?, '5.8', 'primary', 1, NULL)`,
        )
        .run("usdt-tether", 9, 9, 90, 1_780_000_000);

      const repairedUsdtRows = sqlite
        .prepare(
          `SELECT total_tvl_usd, liquidity_score
             FROM dex_liquidity_history
            WHERE stablecoin_id = 'usdt-tether'
              AND snapshot_date = 1780000000`,
        )
        .all();
      expect(repairedUsdtRows).toEqual([{ total_tvl_usd: 9, liquidity_score: 90 }]);

      const uniqueIndexes = sqlite
        .prepare("PRAGMA index_list('dex_liquidity_history')")
        .all() as Array<{ name: string; unique: number }>;
      expect(uniqueIndexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "idx_dex_hist_coin_date_unique", unique: 1 }),
        ]),
      );
    } finally {
      sqlite.close();
    }
  });
});
