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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- trusted test-only path under worker/migrations/
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

function seedBlacklistPlannerStats(sqlite: import("node:sqlite").DatabaseSync): void {
  sqlite.exec(`
    WITH RECURSIVE seq(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM seq WHERE n < 2000
    )
    INSERT INTO blacklist_events (
      id, stablecoin, chain_id, chain_name, event_type, address,
      tx_hash, block_number, timestamp, explorer_tx_url, explorer_address_url
    )
    SELECT
      printf('event-%05d', n),
      CASE n % 2 WHEN 0 THEN 'USDT' ELSE 'USDC' END,
      'ethereum',
      'Ethereum',
      CASE n % 3 WHEN 0 THEN 'destroy' ELSE 'blacklist' END,
      printf('0x%040d', n),
      printf('0x%064d', n),
      n,
      1700000000 + n,
      'https://example.com/tx',
      'https://example.com/address'
    FROM seq;
    ANALYZE;
  `);
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

  it("maximum legacy-offset reads stay on the timestamp index", () => {
    const sqlite = openSqliteWithMigrations();
    seedBlacklistPlannerStats(sqlite);
    const plan = explainQueryPlan(
      sqlite,
      `SELECT id FROM blacklist_events
       WHERE suppression_reason IS NULL
       ORDER BY timestamp DESC, id DESC
       LIMIT 1001 OFFSET 25000`,
    );
    sqlite.close();
    expect(plan).toContain("idx_blacklist_events_public_date_page");
    expect(plan).not.toContain("USE TEMP B-TREE");
  });

  it("keyset reads stay on the timestamp index without an offset scan", () => {
    const sqlite = openSqliteWithMigrations();
    seedBlacklistPlannerStats(sqlite);
    const plan = explainQueryPlan(
      sqlite,
      `SELECT id FROM blacklist_events
       WHERE suppression_reason IS NULL
         AND ((timestamp < 1700000000) OR (timestamp = 1700000000 AND id < 'event-id'))
       ORDER BY timestamp DESC, id DESC
       LIMIT 1001`,
    );
    sqlite.close();
    expect(plan).toContain("idx_blacklist_events_public_date_page");
    expect(plan).not.toContain("SCAN blacklist_events");
  });
});
