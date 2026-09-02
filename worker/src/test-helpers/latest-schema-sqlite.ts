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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration fixtures only.
    sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, migration), "utf8"));
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}

export function createLatestSchemaFixtureTracker() {
  const openDatabases: DatabaseSync[] = [];
  const open = () => {
    const fixture = createLatestSchemaSqlite();
    openDatabases.push(fixture.sqlite);
    return fixture;
  };
  const closeAll = () => openDatabases.splice(0).forEach((sqlite) => sqlite.close());
  return { open, closeAll };
}
