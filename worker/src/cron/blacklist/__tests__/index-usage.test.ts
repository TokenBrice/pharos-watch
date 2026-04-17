import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../migrations");

function openSqliteWithMigrations(): import("node:sqlite").DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    sqlite.exec(sql);
  }
  return sqlite;
}

function explainQueryPlan(
  sqlite: import("node:sqlite").DatabaseSync,
  sql: string,
): string {
  const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
    detail?: string;
  }>;
  return rows.map((r) => r.detail ?? "").join("\n");
}

describe("composite indexes for hot blacklist queries", () => {
  it("backfill SELECT uses idx_blacklist_events_backfill", () => {
    const sqlite = openSqliteWithMigrations();
    const plan = explainQueryPlan(
      sqlite,
      `SELECT id FROM blacklist_events
       WHERE event_type IN ('blacklist','destroy')
         AND amount_status IN ('recoverable_pending')
       ORDER BY timestamp DESC LIMIT 50`,
    );
    sqlite.close();
    expect(plan).toContain("idx_blacklist_events_backfill");
  });

  it("public API filter SELECT uses idx_blacklist_events_api_filter", () => {
    const sqlite = openSqliteWithMigrations();
    const plan = explainQueryPlan(
      sqlite,
      `SELECT id FROM blacklist_events
       WHERE stablecoin = 'USDC' AND chain_name = 'Ethereum' AND event_type = 'blacklist'
       ORDER BY timestamp DESC LIMIT 50`,
    );
    sqlite.close();
    expect(plan).toContain("idx_blacklist_events_api_filter");
  });
});
