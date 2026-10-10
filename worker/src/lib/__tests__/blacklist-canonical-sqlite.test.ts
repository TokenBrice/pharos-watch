import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { blacklistCanonicalEventFilterSql, blacklistEventIdentitySql } from "@shared/lib/blacklist-event-order";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { insertBlacklistRows } from "../../cron/blacklist/persistence";
import { makePendingBlacklistRow } from "../../cron/blacklist/__tests__/blacklist.test-support";

const fixtures = createLatestSchemaFixtureTracker();
const migrationSql = readFileSync("worker/migrations/0267_block_timestamp_cache_hash.sql", "utf8")
  .match(/CREATE INDEX IF NOT EXISTS idx_blacklist_semantic_identity[\s\S]*?;/)![0];
const INDEX = "idx_blacklist_semantic_identity";
afterEach(fixtures.closeAll);

describe("indexed canonical blacklist exclusion", () => {
  it("seeks aliased peers by exact identity in the migrated schema", () => {
    const { sqlite } = fixtures.open();
    const predicate = blacklistCanonicalEventFilterSql();
    const queries = [
      `SELECT id FROM blacklist_events WHERE ${predicate}`,
      `SELECT COUNT(*) FROM blacklist_events WHERE ${predicate} AND stablecoin = 'USDC' AND chain_id = 'arbitrum'`,
      `SELECT amount_status, COUNT(*) FROM blacklist_events WHERE ${predicate} AND event_type IN ('blacklist', 'destroy') GROUP BY amount_status`,
      `SELECT stablecoin, event_type, SUM(amount_usd_at_event) FROM blacklist_events WHERE ${predicate} GROUP BY stablecoin, event_type`,
      `WITH ranked AS (SELECT id, ROW_NUMBER() OVER (PARTITION BY stablecoin, chain_id, address, event_type ORDER BY timestamp DESC) AS rn FROM blacklist_events WHERE ${predicate}) SELECT id FROM ranked WHERE rn = 1`,
      `SELECT e.id FROM blacklist_events AS e WHERE ${blacklistCanonicalEventFilterSql("e")}`,
    ];
    for (const query of queries) {
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).filter((detail) => /\bpeer\b/.test(detail))).toEqual([
        expect.stringMatching(new RegExp(`^SEARCH peer USING INDEX ${INDEX} \\(<expr>=\\?\\)$`)),
      ]);
    }
    // The production migration is idempotent, not just an equivalent test-only index.
    sqlite.exec(migrationSql);
  });

  it("uses the same full-ledger index for the actual insertion guard, including suppressed identities", async () => {
    const { sqlite } = fixtures.open();
    let insertSql = "";
    const db = createSqliteD1(sqlite, { onRun: (sql) => { insertSql = sql; } });
    const tx = "0xabc";
    const suppressed = makePendingBlacklistRow({
      id: `ethereum-${tx}-0xa`, chain_id: "ethereum", tx_hash: tx, suppression_reason: "mirror",
    });
    expect(await insertBlacklistRows(db, [suppressed])).toBe(1);
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${insertSql}`).all(...Array(25).fill(null), "ethereum:0xabc:000000000000000a:0") as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail)).toContain(
      `SEARCH blacklist_events USING COVERING INDEX ${INDEX} (<expr>=?)`,
    );
    const duplicate = { ...suppressed, id: `ethereum-${tx}-10`, suppression_reason: null };
    expect(await insertBlacklistRows(db, [duplicate])).toBe(0);
    const fallback = makePendingBlacklistRow({ id: "fallback-insertion", tx_hash: "" });
    expect(await insertBlacklistRows(db, [fallback])).toBe(1);
    expect(await insertBlacklistRows(db, [fallback])).toBe(0);
    expect(sqlite.prepare("SELECT id FROM blacklist_events ORDER BY id").all()).toEqual([
      { id: suppressed.id }, { id: fallback.id },
    ]);
  });

  it("preserves unindexed row membership, fallback identities, suppression and lexical id ties", () => {
    const { sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number, timestamp,
       suppression_reason, explorer_tx_url, explorer_address_url)
      VALUES (?, 'USDC', ?, 'Ethereum', 'blacklist', '0x1', ?, 1, 1800000000, ?, '', '')`);
    const rows: Array<[string, string, string, string | null]> = [
      ["ethereum-0xabc-0xa", "ethereum", "0xabc", null],
      ["ethereum-0xabc-10", "ethereum", "0xabc", null],
      ["ethereum-0xabc-00010", "ethereum", "0xabc", null],
      ["ethereum-0xabc-10-0", "ethereum", "0xabc", null],
      ["ethereum-0xabc-000010", "ethereum", "0xabc", "mirror"],
      ["ethereum-0xabc-10-1", "ethereum", "0xabc", null],
      ["ethereum-0xabc-0xa-01", "ethereum", "0xabc", null],
      ["ethereum-0xDEF-0Xb", "ethereum", "0xDEF", null],
      ["ethereum-0xdef-11", "ethereum", "0xdef", null],
      ["arbitrum-0xabc-10", "arbitrum", "0xabc", null],
      ["fallback-legacy", "ethereum", "0xabc", null],
      ["fallback-empty-tx", "ethereum", "", null],
      ["fallback-suppressed", "ethereum", "0xabc", "mirror"],
      // A fallback id can itself equal another row's parsed identity; never
      // narrow equality to chain/tx alone or assume fallback rows are unique.
      ["ethereum:0xabc:000000000000000a:0", "arbitrum", "different", null],
      ["ethereum-0xonly-00", "ethereum", "0xonly", "mirror"],
      ["ethereum-0xonly-0", "ethereum", "0xonly", null],
    ];
    for (const row of rows) insert.run(...row);

    const referencePredicate = `blacklist_events.suppression_reason IS NULL AND NOT EXISTS (
      SELECT 1 FROM blacklist_events AS peer NOT INDEXED
      WHERE (${blacklistEventIdentitySql("peer")}) = (${blacklistEventIdentitySql("blacklist_events")})
        AND peer.suppression_reason IS NULL AND peer.id < blacklist_events.id
    )`;
    const select = (predicate: string) => sqlite.prepare(`SELECT id FROM blacklist_events WHERE ${predicate} ORDER BY id`).all();
    const expectedIds = [
      "arbitrum-0xabc-10", "ethereum-0xDEF-0Xb", "ethereum-0xabc-00010",
      "ethereum-0xabc-0xa-01", "ethereum-0xonly-0", "fallback-empty-tx", "fallback-legacy",
    ];
    const reference = select(referencePredicate);
    expect(reference.map((row) => row.id)).toEqual(expectedIds);
    expect(select(blacklistCanonicalEventFilterSql())).toEqual(reference);

    sqlite.exec(`DROP INDEX ${INDEX}`);
    expect(select(blacklistCanonicalEventFilterSql())).toEqual(reference);
    sqlite.exec(migrationSql);
    expect(select(blacklistCanonicalEventFilterSql())).toEqual(reference);

    // Suppression changes still filter peers after seeking their full-ledger identity.
    sqlite.prepare("UPDATE blacklist_events SET suppression_reason = 'mirror' WHERE id = ?").run("ethereum-0xabc-00010");
    expect(select(blacklistCanonicalEventFilterSql())).toEqual(select(referencePredicate));
    sqlite.prepare("UPDATE blacklist_events SET suppression_reason = NULL WHERE id = ?").run("ethereum-0xabc-000010");
    expect(select(blacklistCanonicalEventFilterSql())).toEqual(select(referencePredicate));
    expect(select(blacklistCanonicalEventFilterSql()).map((row) => row.id)).toContain("ethereum-0xabc-000010");
  });
});
