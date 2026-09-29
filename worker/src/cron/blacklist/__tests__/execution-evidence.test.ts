import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { blacklistEventOrderSql, compareBlacklistEvents } from "@shared/lib/blacklist-event-order";
import { buildBlacklistActiveRecords } from "@shared/lib/blacklist-active-records";
import { mapBlacklistEventRow } from "../../../lib/blacklist-api";
import { makeBlacklistRow } from "../../../test-helpers/__shared/fixtures";
import { buildLatestBlacklistRows } from "../../../lib/blacklist/row-preparation";
import { quarantineBlacklistDecodeFailure } from "../../../lib/blacklist/decode-quarantine";
import type { BlacklistRow } from "../../../lib/blacklist/shared";
import { processFetchedBlacklistRows } from "../post-fetch";
import { ethereumConfig } from "./balance.test-support";

function memoryD1(sqlite: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    let args: unknown[] = [];
    return { bind(...values: unknown[]) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args as never[]) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args as never[]) }; },
      async run() { return { meta: sqlite.prepare(sql).run(...args as never[]) }; } };
  }, async batch(statements: D1PreparedStatement[]) {
    return Promise.all(statements.map((statement) => statement.all()));
  } } as unknown as D1Database;
}

describe("blacklist execution evidence", () => {
  it.each(["ethereum", "tron"])("repairs an older %s duplicate using all relevant retained execution evidence", async (chain) => {
    const sqlite = new DatabaseSync(":memory:");
    const rows = (["blacklist", "blacklist", "destroy"] as const).map((event_type, index) => makeBlacklistRow({
      event_type, timestamp: 100, block_number: 10, chain_id: chain,
      tx_hash: chain === "tron" ? `tx${index}` : "0xaa",
      id: `${chain}-${chain === "tron" ? `tx${index}` : "0xaa"}-${["0xe", "0xf", "0x10"][index]}`,
      config_key: ethereumConfig.configKey, contract_address: ethereumConfig.contractAddress,
      amount_native: 123, amount_usd_at_event: 123,
    }) as BlacklistRow);
    const columns = Object.keys(rows[0]);
    sqlite.exec(`CREATE TABLE blacklist_events (${columns.map((column) => `"${column}"`).join(",")});
      CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
      CREATE TABLE blacklist_current_balances (
        id TEXT PRIMARY KEY, stablecoin, chain_id, address, config_key, contract_address,
        amount_native, amount_usd, source, status, observed_at, last_successful_observed_at,
        attempt_count, last_attempted_at, last_error_class, consecutive_failures);`);
    const insert = sqlite.prepare(`INSERT INTO blacklist_events VALUES (${columns.map(() => "?").join(",")})`);
    for (const row of rows) insert.run(...Object.values(row));
    const result = await processFetchedBlacklistRows({
      db: memoryD1(sqlite), config: ethereumConfig, rows: [rows[0]], chainLabel: chain === "tron" ? "tron" : "evm",
      etherscanApiKey: null, drpcApiKey: null, trongridApiKey: null,
      etherscanLimiter: async (fn) => fn(), tronLimiter: async (fn) => fn(),
      runBudget: { subrequestBudget: { count: 0, limit: 10 }, deadlineMs: Date.now() + 10_000, minimumConfigWindowMs: 0 },
    });
    const balances = sqlite.prepare("SELECT amount_native, source FROM blacklist_current_balances").all();
    expect(result.currentBalanceCacheCounters.updated).toBe(chain === "tron" ? 0 : 1);
    expect(balances).toEqual(chain === "tron" ? [] : [{ amount_native: 123, source: "destroy_event" }]);
    sqlite.close();
  });

  it.each(["blacklist", "unblacklist"] as const)("keeps repeated Tron %s effects unambiguous in either provider order", (eventType) => {
    const rows = ["a", "b"].map((tx) => makeBlacklistRow({
      chain_id: "tron", tx_hash: tx, id: `tron-${tx}-0`, timestamp: 100, block_number: 10, event_type: eventType,
    }) as BlacklistRow);
    for (const permutation of [rows, [...rows].reverse()]) {
      const latest = buildLatestBlacklistRows(permutation);
      expect(latest.map((row) => row.event_type)).toEqual([eventType]);
      const records = buildBlacklistActiveRecords(permutation.map((row) => mapBlacklistEventRow({
        ...row, methodology_version: row.methodology_version ?? null, suppression_reason: row.suppression_reason ?? null,
      })));
      if (eventType === "unblacklist") expect(records).toEqual([]);
      else {
        expect(records).toMatchObject([{ destroyedAt: null }]);
        expect(records[0].orderAmbiguityReason).toBeUndefined();
      }
    }
  });

  it("does not resurrect an older snapshot behind conflicting Tron transactions", () => {
    const rows = (["blacklist", "blacklist", "unblacklist"] as const).map((event_type, index) => makeBlacklistRow({
      chain_id: "tron", tx_hash: `tx${index}`, id: `tron-tx${index}-0`, timestamp: index === 0 ? 90 : 100,
      block_number: index === 0 ? 9 : 10, event_type,
    }) as BlacklistRow);
    expect(buildLatestBlacklistRows(rows)).toEqual([]);
    expect(buildBlacklistActiveRecords(rows.map((row) => mapBlacklistEventRow({
      ...row, methodology_version: row.methodology_version ?? null, suppression_reason: row.suppression_reason ?? null,
    })))).toMatchObject([
      { orderAmbiguityReason: "tron-cross-transaction-order" },
    ]);
  });

  it.each([
    [6, 108, "destroyed"],
    [108, 6, "frozen"],
    [null, 108, "ambiguous"],
    [6, null, "ambiguous"],
    [6, 6, "ambiguous"],
  ] as const)("uses confirmed Tron positions %s/%s, otherwise withholds state", (freezePosition, destroyPosition, expected) => {
    const rows = (["blacklist", "destroy"] as const).map((event_type, index) => ({
      ...makeBlacklistRow({
        chain_id: "tron", tx_hash: `tx${index}`, id: `tron-tx${index}-${9 - index}`,
        timestamp: 100, block_number: 10, event_type,
      }),
      transaction_index: index === 0 ? freezePosition : destroyPosition,
    }) as BlacklistRow);
    for (const permutation of [rows, [...rows].reverse()]) {
      const records = buildBlacklistActiveRecords(permutation.map((row) => mapBlacklistEventRow({
        ...row, suppression_reason: row.suppression_reason ?? null,
      })));
      expect(records[0].orderAmbiguityReason).toBe(expected === "ambiguous" ? "tron-cross-transaction-order" : undefined);
      expect(records[0].destroyedAt).toBe(expected === "destroyed" ? 100 : null);
      expect(buildLatestBlacklistRows(permutation).map((row) => row.event_type))
        .toEqual(expected === "ambiguous" ? [] : [expected === "destroyed" ? "destroy" : "blacklist"]);
    }
  });

  it.each(["data", "result"])("bounds oversized %s evidence while releasing the third-scan frontier", async (field) => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT CHECK(length(value) < 20000), updated_at INTEGER)");
    const evidence = { transactionHash: "0xabc", blockNumber: "0xa", [field]: "é".repeat(2_000_000), ignored: "x".repeat(2_000_000) };
    for (const scan of [1, 2, 3]) {
      expect(await quarantineBlacklistDecodeFailure(memoryD1(sqlite), "ethereum-contract", "block:tx:log", "invalid-address", evidence, scan)).toBe(scan === 3);
    }
    const state = JSON.parse(String(sqlite.prepare("SELECT value FROM cache").get()!.value));
    expect(state.evidenceTruncated).toBe(true);
    expect(state.evidence.transactionHash).toBe("0xabc");
    expect(new TextEncoder().encode(state.evidence[field]).length).toBe(4096);
    expect(state.evidence.ignored).toBeUndefined();
    expect(state.quarantined).toBe(true);
    sqlite.close();
  });

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
