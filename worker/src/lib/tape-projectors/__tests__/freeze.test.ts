import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
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
    const migration: string = readFileSync(
      new NodeURL("../../../../migrations/0266_tape_freeze_chain_identity.sql", import.meta.url),
      { encoding: "utf8" },
    );
    sqlite.exec(migration);
    expect(select.all()).toEqual(original);
    sqlite.exec(migration);
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
