import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { type MockD1Database } from "@shared/test-utils/mock-d1";
import { projectFreezeBlocked, projectFreezeDestroyed, projectFreezeUnblocked } from "../freeze";
import { mockTapeD1, tapeCacheWriteBinds, tapeInsertBinds } from "./test-support";
import { FREEZE_RECOVERY_WINDOW_SEC, loadFreshFreezeAlerts } from "../../../cron/telegram-alert-freeze";
import { insertBlacklistRows } from "../../../cron/blacklist/persistence";
import { makeBlacklistRow as makeFixtureBlacklistRow } from "../../../test-helpers/__shared/fixtures";
import type { BlacklistPersistedRow } from "../../blacklist/shared";
import { CONTRACT_CONFIGS } from "../../blacklist-contracts";
import { SOURCE_RECONCILIATION_LOOKBACK_SEC } from "../types";
import { handleEvents } from "../../../api/events";
import { buildTapeEventId } from "../../tape-event-helpers";

const CHAIN_MIGRATION = readFileSync(
  new NodeURL("../../../../migrations/0266_tape_freeze_chain_identity.sql", import.meta.url),
  { encoding: "utf8" },
);
const MIGRATED_CHAIN_NAMES = [...CHAIN_MIGRATION.match(/AND chain IN \(([\s\S]*?)\)/)![1]!
  .matchAll(/'([^']+)'/g)].map((match) => match[1]!);

function insertOldFreezeTapeRow(
  sqlite: DatabaseSync,
  sourceId: string,
  type: string,
  chain: string,
  timestamp = SEC - 365 * 86400,
  sourceTable = "blacklist_events",
): void {
  const transition = type === "freeze.unblocked" ? "resolved" : "opened";
  const eventId = buildTapeEventId({
    tsMs: timestamp * 1000, type, sourceTable, sourceRowId: sourceId, transition,
  });
  sqlite.prepare(`INSERT INTO tape_events
    (event_id, type, severity, ts, chain, title, summary, payload_json,
     source_table, source_row_id, transition, created_at)
    VALUES (?, ?, 'warning', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, type, timestamp * 1000, chain, `USDT freeze · ${chain}`, `Freeze on ${chain}.`,
      JSON.stringify({ stablecoin: "USDT", stablecoinId: "usdt-tether", chainName: chain, sourceEventId: sourceId }),
      sourceTable, sourceId, transition, SEC);
}

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

const SEC = 1_700_000_000;
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(SEC * 1000));
const RECONCILIATION_SINCE = SEC - SOURCE_RECONCILIATION_LOOKBACK_SEC;
const MATCH_BLACKLIST_EVENTS = "FROM blacklist_events";

function makeBlacklistRow(overrides: Partial<BlacklistPersistedRow> = {}): BlacklistPersistedRow {
  return {
    ...makeFixtureBlacklistRow(),
    methodology_version: "3.1",
    amount_attempt_count: 0,
    amount_last_attempted_at: null,
    amount_last_error_class: null,
    amount_last_provider: null,
    ...overrides,
  };
}

function blacklistRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "freeze-a",
    stablecoin: "USDT",
    chain_id: "1",
    chain_name: "Ethereum",
    event_type: "blacklist",
    amount_usd_at_event: 1_500_000,
    timestamp: SEC,
    methodology_version: "freeze-v1",
    rowid: 1,
    ...overrides,
  };
}

describe("freeze projector", () => {
  it("persists canonical freeze chains and idempotently repairs archived rows for canonical and alias API filters", async () => {
    const { db, sqlite } = fixtures.open();
    const cases = [
      { chainId: "ethereum", chainName: "Ethereum", symbol: "USDT", eventType: "blacklist", project: projectFreezeBlocked },
      { chainId: "bsc", chainName: "BSC", symbol: "USDC", eventType: "unblacklist", project: projectFreezeUnblocked },
      { chainId: "tron", chainName: "Tron", symbol: "USDT", eventType: "destroy", project: projectFreezeDestroyed },
    ] as const;
    const insert = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, explorer_tx_url, explorer_address_url, amount_usd_at_event)
      VALUES (?, ?, ?, ?, ?, '0xabc', '0xdef', 1, ?, 'https://example.com', 'https://example.com', 1500000)`);
    for (const item of cases) {
      insert.run(item.chainId, item.symbol, item.chainId, item.chainName, item.eventType, SEC);
      await item.project(db);
    }
    const select = sqlite.prepare("SELECT * FROM tape_events ORDER BY source_row_id");
    const original = select.all();
    expect(original.map((row) => row.chain)).toEqual(["bsc", "ethereum", "tron"]);
    for (const item of cases) {
      const row = original.find((row) => row.source_row_id === item.chainId)!;
      expect(JSON.parse(String(row.payload_json))).toMatchObject({ chainName: item.chainName });
      expect(row.title).toContain(item.chainName);
      // Seed the exact historical display-name defect after latest-schema setup.
      sqlite.prepare("UPDATE tape_events SET chain = ? WHERE source_row_id = ?").run(item.chainName, item.chainId);
    }
    sqlite.exec(CHAIN_MIGRATION);
    expect(select.all()).toEqual(original);
    sqlite.exec(CHAIN_MIGRATION);
    expect(sqlite.prepare("SELECT changes() AS count").get()).toEqual({ count: 0 });
    expect(select.all()).toEqual(original);

    const unfilteredResponse = await handleEvents(db, new URL("https://example.com/api/events"));
    const unfiltered = await unfilteredResponse.json() as { events: { id: string; chain: string }[] };
    expect(unfiltered.events).toHaveLength(3);
    for (const item of cases) {
      for (const filter of [item.chainId, item.chainName]) {
        const response = await handleEvents(db, new URL(`https://example.com/api/events?chain=${filter}`));
        expect(response.status).toBe(200);
        const filtered = await response.json() as { events: { id: string; chain: string }[] };
        expect(filtered.events.map((event) => event.id)).toEqual(
          unfiltered.events.filter((event) => event.chain === item.chainId).map((event) => event.id),
        );
      }
    }
  });

  it.each([
    { eventType: "blacklist" as const, type: "freeze.blocked", project: projectFreezeBlocked },
    { eventType: "unblacklist" as const, type: "freeze.unblocked", project: projectFreezeUnblocked },
    { eventType: "destroy" as const, type: "freeze.destroyed", project: projectFreezeDestroyed },
  ])("repairs post-migration old-writer $type rows without replacing identities or replaying alerts", async ({ eventType, type, project }) => {
    const { db, sqlite } = fixtures.open();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    // Apply 0266 before the OLD Worker writes, including rows outside the
    // scheduled source lookback and rows within the Telegram recovery gate.
    sqlite.exec(CHAIN_MIGRATION);
    expect(MIGRATED_CHAIN_NAMES).toHaveLength(9);
    expect([...new Set(CONTRACT_CONFIGS.map(({ chain }) => chain.chainName))].sort())
      .toEqual([...MIGRATED_CHAIN_NAMES].sort());
    for (const name of MIGRATED_CHAIN_NAMES) {
      await insertBlacklistRows(db, [makeBlacklistRow({
        id: name, chain_id: name.toLowerCase(), chain_name: name, event_type: eventType,
        timestamp: SEC - 365 * 86400,
      })]);
      insertOldFreezeTapeRow(sqlite, name, type, name);
    }
    insertOldFreezeTapeRow(sqlite, "boundary", type, "Ethereum", SEC - FREEZE_RECOVERY_WINDOW_SEC);
    insertOldFreezeTapeRow(sqlite, "expired", type, "Ethereum", SEC - FREEZE_RECOVERY_WINDOW_SEC - 1);
    insertOldFreezeTapeRow(sqlite, "recent", type, "Ethereum", SEC - 12 * 3600);
    // Preserve non-migration names, already canonical chains and other sources.
    insertOldFreezeTapeRow(sqlite, "unknown", type, "Fantom");
    insertOldFreezeTapeRow(sqlite, "canonical", type, "ethereum");
    insertOldFreezeTapeRow(sqlite, "other-source", type, "Ethereum", SEC, "other_events");
    const select = sqlite.prepare("SELECT * FROM tape_events ORDER BY id");
    const before = select.all();
    sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')")
      .run(SEC);
    const consumed = await loadFreshFreezeAlerts(db, 0, SEC);
    expect(consumed.alerts.map((alert) => alert.sourceEventId)).toEqual(["boundary", "recent", "other-source"]);

    expect(await project(db, { dryRun: true })).toEqual({ projected: 0, advanced: null });
    expect(select.all()).toEqual(before);
    expect(sqlite.prepare("SELECT key FROM cache WHERE key LIKE 'tape-projector:%'").all()).toEqual([]);
    expect(await project(db)).toEqual({ projected: 0, advanced: null });
    const expected = before.map((row) => ({
      ...row,
      chain: row.source_table === "blacklist_events" && MIGRATED_CHAIN_NAMES.includes(String(row.chain))
        ? String(row.chain).toLowerCase() : row.chain,
    }));
    expect(select.all()).toEqual(expected);
    for (const name of MIGRATED_CHAIN_NAMES) {
      const response = await handleEvents(db, new URL(`https://example.com/api/events?chain=${name.toLowerCase()}`));
      expect(response.status).toBe(200);
      const body = await response.json() as { events: { sourceRowId: string }[] };
      expect(body.events.map((event) => event.sourceRowId)).toContain(name);
    }
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line))).filter((entry) => entry.event === "freeze-chain-repair"))
      .toEqual([expect.objectContaining({ metadata: { type, scanned: before.length, repaired: 12, continuing: false } })]);
    const changesBefore = sqlite.prepare("SELECT total_changes() AS count").get();
    expect(await project(db)).toEqual({ projected: 0, advanced: null });
    expect(sqlite.prepare("SELECT total_changes() AS count").get()).toEqual(changesBefore);
    expect(select.all()).toEqual(expected);
    expect((await loadFreshFreezeAlerts(db, consumed.cursor, SEC)).alerts).toEqual([]);
    expect((await loadFreshFreezeAlerts(db, 0, SEC)).alerts.map((alert) => alert.sourceEventId))
      .toEqual(consumed.alerts.map((alert) => alert.sourceEventId));
  });

  it("bounds repair reads and writes, resumes indexed pages, and wraps to catch rollback inserts behind the cursor", async () => {
    const { db, sqlite } = fixtures.open();
    const prepare = vi.spyOn(db, "prepare");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const type = "freeze.blocked";
    const key = `tape-projector:freeze-chain-repair:${type}`;
    for (let i = 0; i < 501; i++) insertOldFreezeTapeRow(sqlite, `archive-${i}`, type, "Ethereum");
    expect(await projectFreezeBlocked(db)).toEqual({ projected: 0, advanced: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM tape_events WHERE chain = 'ethereum'").get()).toEqual({ count: 500 });
    const cursor = JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key)!.value)) as { ts: number; id: number };
    expect(cursor.id).toBe(2);
    // A rollback writes a newer row after the first page: only the next sweep
    // can find it because it sorts ahead of the persisted scan cursor.
    insertOldFreezeTapeRow(sqlite, "rollback", type, "Ethereum", SEC);
    expect(await projectFreezeBlocked(db)).toEqual({ projected: 0, advanced: null });
    expect(sqlite.prepare("SELECT id FROM tape_events WHERE chain = 'Ethereum'").all()).toEqual([{ id: 502 }]);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key)).toBeUndefined();
    expect(await projectFreezeBlocked(db)).toEqual({ projected: 0, advanced: null });
    expect(sqlite.prepare("SELECT id FROM tape_events WHERE chain = 'Ethereum'").all()).toEqual([]);
    const scans = prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("FROM tape_events INDEXED BY idx_tape_type_ts"));
    expect(scans).toHaveLength(3);
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${scans[1]}`)
      .all(type, cursor.ts, cursor.id, 500).map((row) => row.detail).join("\n");
    expect(plan).toContain("idx_tape_type_ts");
    expect(plan).toContain("ts<?");
    expect(plan).not.toContain("SCAN tape_events");
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line))).filter((entry) => entry.event === "freeze-chain-repair")
      .map((entry) => entry.metadata)).toEqual([
      { type, scanned: 500, repaired: 500, continuing: true },
      { type, scanned: 1, repaired: 1, continuing: false },
      { type, scanned: 500, repaired: 1, continuing: true },
    ]);
  });

  it.each(["scan", "update"] as const)("continues fresh projection and reports a repair %s failure without advancing its cursor", async (phase) => {
    const { db, sqlite } = fixtures.open();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const key = "tape-projector:freeze-chain-repair:freeze.blocked";
    const cursorValue = JSON.stringify({ ts: SEC * 1000, id: 999 });
    insertOldFreezeTapeRow(sqlite, "legacy-pending-repair", "freeze.blocked", "Ethereum");
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(key, cursorValue, SEC);
    await insertBlacklistRows(db, [makeBlacklistRow({
      id: "fresh-during-repair-failure", chain_id: "ethereum", chain_name: "Ethereum", timestamp: SEC,
    })]);
    const error = new Error("repair temporarily unavailable");
    if (phase === "scan") {
      const prepare = db.prepare.bind(db);
      let failed = false;
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        if (!failed && sql.includes("FROM tape_events INDEXED BY idx_tape_type_ts")) {
          failed = true;
          throw error;
        }
        return prepare(sql);
      });
    } else {
      vi.spyOn(db, "batch").mockRejectedValueOnce(error);
    }

    expect(await projectFreezeBlocked(db)).toEqual({ projected: 1, advanced: SEC });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key)).toEqual({ value: cursorValue });
    expect(sqlite.prepare("SELECT chain FROM tape_events WHERE source_row_id = ?").get("legacy-pending-repair"))
      .toEqual({ chain: "Ethereum" });
    expect(sqlite.prepare("SELECT chain FROM tape_events WHERE source_row_id = ?").get("fresh-during-repair-failure"))
      .toEqual({ chain: "ethereum" });
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({
        event: "freeze-chain-repair-failed",
        level: "error",
        errorMessage: error.message,
        metadata: { type: "freeze.blocked", reason: "freeze-chain-repair-failed" },
      }),
    ]);
    // The failed page is still retryable; its successful replay heals only
    // the old chain and cannot insert the already-projected fresh identity.
    expect(await projectFreezeBlocked(db)).toEqual({ projected: 0, advanced: null });
    expect(sqlite.prepare("SELECT chain FROM tape_events WHERE source_row_id = ?").get("legacy-pending-repair"))
      .toEqual({ chain: "ethereum" });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key)).toBeUndefined();
  });

  it("expands a full batch through same-timestamp freeze rows before advancing the watermark", async () => {
    const limitedRows = [
      blacklistRow({ id: "freeze-a", rowid: 1 }),
      blacklistRow({ id: "freeze-b", rowid: 2 }),
    ];
    const expandedRows = [
      ...limitedRows,
      blacklistRow({ id: "freeze-c", rowid: 3 }),
    ];
    const db = mockTapeD1([
      { match: "FROM cache WHERE key", rows: [] },
      { match: "FROM tape_events INDEXED BY idx_tape_type_ts", rows: [] },
      { match: MATCH_BLACKLIST_EVENTS, matchBinds: [RECONCILIATION_SINCE, "blacklist", "opened", 2], rows: limitedRows },
      { match: MATCH_BLACKLIST_EVENTS, matchBinds: [RECONCILIATION_SINCE, SEC, "blacklist", "opened"], rows: expandedRows },
    ]) as MockD1Database;

    const result = await projectFreezeBlocked(db, { maxRows: 2 });

    expect(result).toEqual({ projected: 3, advanced: SEC });
    expect(tapeInsertBinds(db).map((binds) => binds[13])).toEqual([
      "freeze-a",
      "freeze-b",
      "freeze-c",
    ]);
    expect(tapeCacheWriteBinds(db, "freeze.blocked")[0]?.[1]).toBe(String(SEC));
  });

  it.each([
    { eventType: "blacklist" as const, type: "freeze.blocked", project: projectFreezeBlocked },
    { eventType: "unblacklist" as const, type: "freeze.unblocked", project: projectFreezeUnblocked },
    { eventType: "destroy" as const, type: "freeze.destroyed", project: projectFreezeDestroyed },
  ])("projects old reconciled $type rows without alerts and alerts recent outage-window rows exactly once", async ({ eventType, type, project }) => {
    const { db, sqlite } = fixtures.open();
    const prepare = vi.spyOn(db, "prepare");
    const oldTime = SEC - 365 * 86400;
    const recoveredConfig = CONTRACT_CONFIGS.find(
      (config) => config.stablecoinId === "usdt-tether" && config.chain.chainId === "arbitrum",
    )!;
    const insert = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number,
       timestamp, explorer_tx_url, explorer_address_url, amount_usd_at_event, config_key,
       suppression_reason, reconciliation_manifest_id, reconciliation_run_id, provenance_source)
      VALUES (?, 'USDT', ?, ?, ?, '0xabc', '0xdef', 1, ?, 'https://example.com',
              'https://example.com', 1500000, ?, ?, ?, ?, ?)`);
    await insertBlacklistRows(db, [makeBlacklistRow({ id: "healthy-newer", event_type: eventType, timestamp: SEC })]);
    expect(await project(db)).toEqual({ projected: 1, advanced: SEC });
    const sourceSql = prepare.mock.calls.map(([sql]) => sql).find((sql) => sql.includes("FROM blacklist_events INDEXED BY"));
    expect(sourceSql).toBeDefined();
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sourceSql!}`)
      .all(RECONCILIATION_SINCE, eventType, eventType === "unblacklist" ? "resolved" : "opened", 500)
      .map((row) => row.detail).join("\n");
    expect(plan).toContain("idx_blacklist_events_public_event_page");
    expect(plan).toContain("timestamp>?");
    expect(plan).not.toContain("SCAN blacklist_events");
    const existing = sqlite.prepare("SELECT id, event_id, source_row_id, ts FROM tape_events ORDER BY id").all();
    const healthy = existing[0] as { id: number };

    // A resumed independent config contributes an older event; reconciliation
    // can independently insert a still older identity with manifest provenance.
    await insertBlacklistRows(db, [makeBlacklistRow({
      id: "recovered-older",
      event_type: eventType,
      timestamp: SEC - 30 * 86400,
      chain_id: recoveredConfig.chain.chainId,
      chain_name: recoveredConfig.chain.chainName,
      contract_address: recoveredConfig.contractAddress,
      config_key: recoveredConfig.configKey,
    })]);
    insert.run("reconciled-oldest", recoveredConfig.chain.chainId, recoveredConfig.chain.chainName, eventType, oldTime, recoveredConfig.configKey,
      null, "historical-manifest", "historical-run", "historical-reconciliation");
    insert.run("suppressed", recoveredConfig.chain.chainId, recoveredConfig.chain.chainName, eventType, oldTime - 1, recoveredConfig.configKey,
      "duplicate-source", "historical-manifest", "historical-run", "historical-reconciliation");
    insert.run("recent-outage", recoveredConfig.chain.chainId, recoveredConfig.chain.chainName, eventType, SEC - 12 * 3600, recoveredConfig.configKey,
      null, "outage-manifest", "outage-run", "historical-reconciliation");
    insert.run("recovery-boundary", recoveredConfig.chain.chainId, recoveredConfig.chain.chainName, eventType, SEC - FREEZE_RECOVERY_WINDOW_SEC, recoveredConfig.configKey,
      null, "outage-manifest", "outage-run", "historical-reconciliation");
    insert.run("expired-recovery", recoveredConfig.chain.chainId, recoveredConfig.chain.chainName, eventType, SEC - FREEZE_RECOVERY_WINDOW_SEC - 1, recoveredConfig.configKey,
      null, "outage-manifest", "outage-run", "historical-reconciliation");

    expect(await project(db, { since: SEC - 1 })).toEqual({ projected: 0, advanced: null });
    expect(await project(db, { dryRun: true })).toEqual({ projected: 4, advanced: null });
    expect(sqlite.prepare("SELECT id, event_id, source_row_id, ts FROM tape_events ORDER BY id").all()).toEqual(existing);
    expect(await project(db, { maxRows: 1 })).toEqual({ projected: 1, advanced: SEC });
    expect(await project(db, { maxRows: 1 })).toEqual({ projected: 1, advanced: SEC });
    expect(await project(db, { maxRows: 1 })).toEqual({ projected: 1, advanced: SEC });
    expect(await project(db, { maxRows: 1 })).toEqual({ projected: 1, advanced: SEC });
    // Scheduled reconciliation does not scan year-old history; admin backfill does.
    expect(await project(db)).toEqual({ projected: 0, advanced: null });
    expect(await project(db, { since: 0, dryRun: true })).toEqual({ projected: 1, advanced: null });
    expect(await project(db, { since: 0 })).toEqual({ projected: 1, advanced: oldTime });
    const events = sqlite.prepare("SELECT id, event_id, source_row_id, ts FROM tape_events ORDER BY id").all();
    expect(events).toEqual([
      ...existing,
      { id: expect.any(Number), event_id: expect.any(String), source_row_id: "recovered-older", ts: (SEC - 30 * 86400) * 1000 },
      { id: expect.any(Number), event_id: expect.any(String), source_row_id: "expired-recovery", ts: (SEC - FREEZE_RECOVERY_WINDOW_SEC - 1) * 1000 },
      { id: expect.any(Number), event_id: expect.any(String), source_row_id: "recovery-boundary", ts: (SEC - FREEZE_RECOVERY_WINDOW_SEC) * 1000 },
      { id: expect.any(Number), event_id: expect.any(String), source_row_id: "recent-outage", ts: (SEC - 12 * 3600) * 1000 },
      { id: expect.any(Number), event_id: expect.any(String), source_row_id: "reconciled-oldest", ts: oldTime * 1000 },
    ]);
    expect(await project(db)).toEqual({ projected: 0, advanced: null });
    expect(await project(db, { since: 0 })).toEqual({ projected: 0, advanced: null });
    expect(sqlite.prepare("SELECT id, event_id, source_row_id, ts FROM tape_events ORDER BY id").all()).toEqual(events);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(`tape-projector:cursor:${type}`))
      .toEqual({ value: String(SEC) });

    sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')")
      .run(SEC - 5);
    const alerts = await loadFreshFreezeAlerts(db, healthy.id, SEC);
    expect(alerts.state).toBe("ok");
    expect(alerts.alerts.map((alert) => alert.sourceEventId)).toEqual(["recovery-boundary", "recent-outage"]);
    expect(alerts.alerts.map((alert) => alert.eventType)).toEqual([eventType, eventType]);
    expect(alerts.cursor).toBe(events[events.length - 1]!.id);
    expect((await loadFreshFreezeAlerts(db, alerts.cursor, SEC)).alerts).toEqual([]);
  });
});
