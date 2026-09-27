import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { blacklistEventOrderSql, compareBlacklistEvents } from "@shared/lib/blacklist-event-order";
import { buildBlacklistActiveRecords } from "@shared/lib/blacklist-active-records";
import { mapBlacklistEventRow } from "../../../lib/blacklist-api";
import { makeBlacklistRow } from "../../../test-helpers/__shared/fixtures";
import { buildLatestBlacklistRows } from "../../../lib/blacklist/row-preparation";
import { quarantineBlacklistDecodeFailure } from "../../../lib/blacklist/decode-quarantine";
import type { BlacklistRow } from "../../../lib/blacklist/shared";

function memoryD1(sqlite: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    let args: unknown[] = [];
    return { bind(...values: unknown[]) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args as never[]) ?? null; },
      async run() { return sqlite.prepare(sql).run(...args as never[]); } };
  } } as unknown as D1Database;
}

describe("blacklist execution evidence", () => {
  it.each([["0xf", "0x10", "0x11"], ["9", "10", "11"], ["0xf-9", "0xf-10", "0x10-0"]])("agrees across SQL, row preparation and rebuild fold for %s", (...indices) => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE events (id TEXT, timestamp INTEGER, block_number INTEGER, chain_id TEXT, tx_hash TEXT)");
    const rows = (["blacklist", "destroy", "unblacklist"] as const).map((event_type, index) => makeBlacklistRow({
      event_type, timestamp: 100, block_number: 10, chain_id: "ethereum",
      tx_hash: `0x${3-index}`, id: `ethereum-0x${3-index}-${indices[index]}`,
    }) as BlacklistRow);
    for (const row of rows) sqlite.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.timestamp, row.block_number, row.chain_id, row.tx_hash);
    const sqlIds = sqlite.prepare(`SELECT id FROM events ORDER BY ${blacklistEventOrderSql("ASC")}`).all().map((row) => row.id);
    for (const permutation of [rows, [...rows].reverse(), [rows[1], rows[2], rows[0]]]) {
      expect([...permutation].sort(compareBlacklistEvents).map((row) => row.id)).toEqual(sqlIds);
      expect(buildLatestBlacklistRows(permutation)[0].event_type).toBe("unblacklist");
      expect(buildBlacklistActiveRecords(permutation.map((row) => mapBlacklistEventRow({
        ...row, methodology_version: row.methodology_version ?? null, suppression_reason: row.suppression_reason ?? null,
      })))).toEqual([]);
    }
    sqlite.close();
  });

  it.each([
    [["blacklist", "destroy", "unblacklist"], "released"],
    [["blacklist", "unblacklist", "destroy"], "released"],
    [["destroy", "blacklist", "unblacklist"], "released"],
    [["unblacklist", "blacklist", "destroy"], "destroyed"],
    [["destroy", "unblacklist", "blacklist"], "frozen"],
    [["unblacklist", "destroy", "blacklist"], "frozen"],
  ] as const)("folds execution sequence %j to %s regardless of provider input order", (sequence, expected) => {
    const rows = sequence.map((event_type, index) => makeBlacklistRow({
      event_type, timestamp: 100, block_number: 10, chain_id: "ethereum", tx_hash: "0xaa",
      id: `ethereum-0xaa-0x${(15 + index).toString(16)}`,
    }) as BlacklistRow);
    const records = buildBlacklistActiveRecords(rows.reverse().map((row) => mapBlacklistEventRow({
      ...row, methodology_version: row.methodology_version ?? null, suppression_reason: row.suppression_reason ?? null,
    })));
    if (expected === "released") expect(records).toEqual([]);
    else {
      expect(records).toHaveLength(1);
      expect(records[0].destroyedAt).toBe(expected === "destroyed" ? 100 : null);
    }
  });

  it("holds two distinct scans, retains evidence on the third, and never increments twice per scan", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
    const db = memoryD1(sqlite);
    const observe = (scan: number) => quarantineBlacklistDecodeFailure(db, "config", "block:tx:log", "invalid-direction-bool", { data: "0x" }, scan);
    expect(await observe(1)).toBe(false);
    expect(await observe(1)).toBe(false);
    expect(await observe(2)).toBe(false);
    expect(await observe(3)).toBe(true);
    expect(await observe(4)).toBe(true);
    const state = JSON.parse(String(sqlite.prepare("SELECT value FROM cache").get()!.value));
    expect(state).toMatchObject({ attempts: 3, quarantined: true, reason: "invalid-direction-bool", disposition: "decode-retry-exhausted", evidence: { data: "0x" } });
    sqlite.close();
  });

  it("does not consume failed durable writes", async () => {
    const sqlite = new DatabaseSync(":memory:");
    expect(await quarantineBlacklistDecodeFailure(memoryD1(sqlite), "config", "log", "invalid-address", {}, 1)).toBe(false);
    sqlite.close();
  });
});
