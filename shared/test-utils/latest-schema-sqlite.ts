import type { D1Database } from "@shared/types/cloudflare-runtime";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1, type SqliteD1Options } from "./sqlite-d1";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../worker/migrations");

// Migration files are immutable during a test run, and replaying all of them
// costs ~40ms per database. The migrated schema is therefore built once per
// process and serialized; each fixture restores those bytes into its own fresh
// :memory: database (~0.06ms). A restored database owns resizeable storage and
// shares nothing with the template bytes or with any other fixture.
let cachedTemplate: Uint8Array | undefined;

function readMigrationSql(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .map((name) => readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
}

function buildTemplate(): Uint8Array {
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const sql of readMigrationSql()) {
      sqlite.exec(sql);
    }
    return sqlite.serialize();
  } finally {
    sqlite.close();
  }
}

function openLatestSchemaSqlite(options: SqliteD1Options, openDatabases?: Set<DatabaseSync>, uncached = false) {
  const sqlite = new DatabaseSync(":memory:");
  openDatabases?.add(sqlite);
  try {
    if (uncached) {
      for (const sql of readMigrationSql()) {
        sqlite.exec(sql);
      }
    } else {
      // A failed build is never cached: the assignment only runs on success.
      sqlite.deserialize((cachedTemplate ??= buildTemplate()));
    }
    return { sqlite, db: createSqliteD1(sqlite, options) };
  } catch (error) {
    sqlite.close();
    openDatabases?.delete(sqlite);
    throw error;
  }
}

export function createLatestSchemaSqlite(options: SqliteD1Options = {}): { sqlite: DatabaseSync; db: D1Database } {
  return openLatestSchemaSqlite(options);
}

/** Reads `worker/migrations` fresh on every open, bypassing the per-process cache. Use when the migration inventory itself is under test. */
export function createLatestSchemaSqliteUncached(options: SqliteD1Options = {}): { sqlite: DatabaseSync; db: D1Database } {
  return openLatestSchemaSqlite(options, undefined, true);
}

export function createLatestSchemaFixtureTracker(options: { uncached?: boolean } = {}) {
  const uncached = options.uncached === true;
  const openDatabases = new Set<DatabaseSync>();
  const open = () => openLatestSchemaSqlite({}, openDatabases, uncached);
  const closeAll = () => {
    const errors: unknown[] = [];
    for (const sqlite of openDatabases) {
      try {
        if (sqlite.isOpen) sqlite.close();
        openDatabases.delete(sqlite);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close SQLite fixtures");
  };
  return { open, closeAll };
}
