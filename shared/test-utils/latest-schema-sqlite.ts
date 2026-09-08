import type { D1Database } from "@shared/types/cloudflare-runtime";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1, type SqliteD1Options } from "./sqlite-d1";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../worker/migrations");

function openLatestSchemaSqlite(options: SqliteD1Options, openDatabases?: Set<DatabaseSync>) {
  const sqlite = new DatabaseSync(":memory:");
  openDatabases?.add(sqlite);
  try {
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    for (const migration of migrations) {
      sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, migration), "utf8"));
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

export function createLatestSchemaFixtureTracker() {
  const openDatabases = new Set<DatabaseSync>();
  const open = () => openLatestSchemaSqlite({}, openDatabases);
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
