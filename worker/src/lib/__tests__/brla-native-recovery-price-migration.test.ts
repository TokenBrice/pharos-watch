import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "worker/src/test-helpers/migration-fixtures");
const FIXTURES_DIR = join(process.cwd(), "worker/src/test-helpers/migration-fixtures");

// Migrations absorbed by the 2026-07-30 baseline squash live on as frozen test fixtures.
function resolveMigrationPath(file: string): string {
  const fixture = join(FIXTURES_DIR, file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled test fixture path
  return existsSync(fixture) ? fixture : join(MIGRATIONS_DIR, file);
}

function applyMigration(db: DatabaseSync, file: string): void {
  // Test-only replay of repo-controlled migration files.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  db.exec(readFileSync(resolveMigrationPath(file), "utf8"));
}

function applyThrough(db: DatabaseSync, throughFile: string): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    applyMigration(db, file);
    if (file === throughFile) return;
  }
  throw new Error(`missing migration ${throughFile}`);
}

describe("0195 BRLA native recovery price repair", () => {
  it("clears only the known mixed-unit recovery price", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, "0194_yield_history_reproducible_pys_inputs.sql");
      db.exec(`
        INSERT INTO depeg_events
          (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
           started_at, ended_at, start_price, peak_price, recovery_price,
           peg_reference, source, close_reason)
        VALUES
          (90509, 'brla-brla-digital', 'BRLA', 'peggedREAL', 'below', -150,
           1783600469, 1783601364, 0.984969, 0.984969, 0.1918020523709537,
           1, 'live', 'recovered-primary'),
          (90510, 'brla-brla-digital', 'BRLA', 'peggedREAL', 'below', -150,
           1783600470, 1783601364, 0.984969, 0.984969, 0.1918020523709537,
           1, 'live', 'recovered-primary');
      `);

      applyMigration(db, "0195_brla_native_recovery_price_repair.sql");

      expect(
        db.prepare("SELECT id, recovery_price FROM depeg_events WHERE id IN (90509, 90510) ORDER BY id").all(),
      ).toEqual([
        { id: 90509, recovery_price: null },
        { id: 90510, recovery_price: 0.1918020523709537 },
      ]);
    } finally {
      db.close();
    }
  });
});
