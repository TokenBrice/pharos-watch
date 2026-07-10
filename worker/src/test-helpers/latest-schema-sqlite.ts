import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "./sqlite-d1";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

export function createLatestSchemaSqlite(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, migration), "utf8"));
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}
