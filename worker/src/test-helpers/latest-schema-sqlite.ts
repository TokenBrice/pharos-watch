import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "./sqlite-d1";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");
const MIGRATION_FIXTURES_DIR = path.resolve(__dirname, "migration-fixtures");

export function createLatestSchemaSqlite(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration fixtures only.
    sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, migration), "utf8"));
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}

/**
 * Historical replay order: the frozen fixtures for migrations absorbed by the
 * 2026-07-30 baseline squash, unioned with the active migration inventory.
 * Fixtures win on filename collisions so `0000_baseline.sql` resolves to the
 * pre-squash baseline and the individually-numbered fixtures replay on top of
 * it in sequence.
 */
function historicalMigrationFiles(): string[] {
  return [
    ...new Set(
      [...readdirSync(MIGRATION_FIXTURES_DIR), ...readdirSync(MIGRATIONS_DIR)].filter((entry) =>
        /^\d+.*\.sql$/.test(entry),
      ),
    ),
  ].sort();
}

function resolveMigrationPath(file: string): string {
  const fixturePath = path.join(MIGRATION_FIXTURES_DIR, file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled migration path.
  return existsSync(fixturePath) ? fixturePath : path.join(MIGRATIONS_DIR, file);
}

/** Applies one named migration (or frozen fixture) to an already-open database. */
export function applyMigrationFile(sqlite: DatabaseSync, file: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled migration path.
  sqlite.exec(readFileSync(resolveMigrationPath(file), "utf8"));
}

/**
 * Applies migrations in historical order and stops after `throughFile`, so a
 * test can pin the schema as it existed at a specific migration. Prefer
 * `createLatestSchemaSqlite()` unless the test deliberately targets a
 * pre-migration or partial schema.
 */
export function applyMigrationsThrough(sqlite: DatabaseSync, throughFile: string): void {
  for (const file of historicalMigrationFiles()) {
    applyMigrationFile(sqlite, file);
    if (file === throughFile) return;
  }
  throw new Error(`Migration ${throughFile} was not found`);
}
