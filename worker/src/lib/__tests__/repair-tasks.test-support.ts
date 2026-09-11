import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";

const REPAIR_SCHEMA_SQL = ["0000_baseline.sql", "0228_depeg_resolver_incident_closed_pre_lock.sql"]
  .map((file) => readFileSync(join(process.cwd(), "worker/migrations", file), "utf8"))
  .join("\n");

export function makeSqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(REPAIR_SCHEMA_SQL);
    return Object.assign(createSqliteD1(sqlite), { sqlite, close: () => sqlite.close() });
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type SqliteD1 = ReturnType<typeof makeSqliteD1>;
