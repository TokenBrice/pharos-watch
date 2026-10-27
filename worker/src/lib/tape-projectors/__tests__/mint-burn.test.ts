import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});
import { type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { projectMintBurnLargeFlows } from "../mint-burn";
import { mockTapeD1, tapeInsertBinds, tapeInsertBindsForType } from "./test-support";
import { SOURCE_RECONCILIATION_LOOKBACK_SEC } from "../types";

const SEC = 1_700_000_000;
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(SEC * 1000));
const RECONCILIATION_SINCE = SEC - SOURCE_RECONCILIATION_LOOKBACK_SEC;

const MATCH_FETCH_FLOWS = "amount_usd >= ?";
const NO_CHANGED_CLAIMS: MockTableConfig = { match: "JOIN tape_events AS t", rows: [] };

function withRows(rows: Record<string, unknown>[]): MockTableConfig[] {
  return [
    NO_CHANGED_CLAIMS,
    { match: "FROM cache WHERE key", rows: [] },
    { match: MATCH_FETCH_FLOWS, rows },
  ];
}

function makeFlow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "ethereum-0xabc-0",
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    chain_id: "ethereum",
    direction: "mint",
    amount_usd: 15_000_000,
    counterparty: null,
    timestamp: SEC,
    flow_type: "standard",
    burn_type: null,
    ...overrides,
  };
}

describe("mint_burn projector", () => {

  it.each([
    { timestamp: 1777636800, version: "6.0" },
    { timestamp: 1792497600, version: "6.28" },
    { timestamp: 1792540799, version: "6.28" },
    { timestamp: 1792540800, version: "6.29" },
  ])("persists the flow methodology at source time $timestamp under later replay clocks", async ({ timestamp, version }) => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, timestamp,
       flow_type, tx_hash, block_number, explorer_tx_url)
      VALUES ('historical', 'usdt-tether', 'USDT', 'ethereum', 'mint', 15000000, 15000000, ?,
              'standard', '0xtest', 1, 'https://example.com')`).run(timestamp);
    for (const clock of [1792497600, 1824033600]) {
      vi.spyOn(Date, "now").mockReturnValue(clock * 1000);
      await projectMintBurnLargeFlows(db, { since: timestamp - 1, until: timestamp });
      expect(sqlite.prepare("SELECT methodology_version FROM tape_events").get())
        .toEqual({ methodology_version: version });
    }
  });

  it("persists only economic flows at exact severity boundaries and keeps reruns durable", async () => {
    const { db, sqlite } = fixtures.open();
    const rows = [
      makeFlow({ id: "below", amount_usd: 9_999_999 }),
      makeFlow({ id: "notice", amount_usd: 10_000_000 }),
      makeFlow({ id: "warning", amount_usd: 25_000_000 }),
      makeFlow({ id: "severe", amount_usd: 100_000_000, direction: "burn", burn_type: "effective_burn" }),
      makeFlow({ id: "bridge", amount_usd: 100_000_000, flow_type: "bridge_transfer" }),
      makeFlow({ id: "review", amount_usd: 100_000_000, direction: "burn", burn_type: "review_required" }),
      makeFlow({ id: "unpriced", amount_usd: null }),
    ];
    for (const row of rows) {
      sqlite.prepare(`INSERT INTO mint_burn_events
        (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, counterparty, timestamp, flow_type, burn_type, tx_hash, block_number, explorer_tx_url)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, '0xtest', 1, 'https://example.com')`)
        .run(row.id as string, row.stablecoin_id as string, row.symbol as string, row.chain_id as string,
          row.direction as string, row.amount_usd as number | null, row.counterparty as null,
          row.timestamp as number, row.flow_type as string, row.burn_type as string | null);
    }
    await projectMintBurnLargeFlows(db);
    const select = sqlite.prepare("SELECT event_id, source_row_id, type, severity FROM tape_events ORDER BY source_row_id");
    const events = select.all();
    expect(events).toEqual([
      { event_id: expect.any(String), source_row_id: "notice", type: "mint_burn.large_mint", severity: "notice" },
      { event_id: expect.any(String), source_row_id: "severe", type: "mint_burn.large_burn", severity: "severe" },
      { event_id: expect.any(String), source_row_id: "warning", type: "mint_burn.large_mint", severity: "warning" },
    ]);
    const cursor = sqlite.prepare("SELECT value FROM cache WHERE key = 'tape-projector:cursor:mint_burn.large_flow'");
    expect(cursor.get()).toEqual({ value: String(SEC) });
    await projectMintBurnLargeFlows(db);
    await projectMintBurnLargeFlows(db, { since: 0 });
    expect(select.all()).toEqual(events);
    expect(cursor.get()).toEqual({ value: String(SEC) });
  });

  it("reconciles recent healed prices and reviewed burns while reserving year-old repairs for admin backfill", async () => {
    const { db, sqlite } = fixtures.open();
    const prepare = vi.spyOn(db, "prepare");
    const oldTime = SEC - 365 * 86400;
    const recentTime = SEC - 30 * 86400;
    const insert = sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, timestamp,
       flow_type, burn_type, tx_hash, block_number, explorer_tx_url)
      VALUES (?, 'usdt-tether', 'USDT', 'ethereum', ?, 20000000, ?, ?, 'standard', ?, '0xtest', 1, 'https://example.com')`);
    insert.run("old-unpriced", "mint", null, oldTime, null);
    insert.run("old-review", "burn", 20_000_000, oldTime + 1, "review_required");
    insert.run("recent-unpriced", "mint", null, recentTime, null);
    insert.run("recent-review", "burn", 20_000_000, recentTime + 1, "review_required");
    insert.run("newer-priced", "mint", 20_000_000, SEC, null);

    expect(await projectMintBurnLargeFlows(db)).toEqual({ projected: 1, advanced: SEC });
    const sourceSql = prepare.mock.calls.map(([sql]) => sql).find((sql) => sql.includes("amount_usd >= ?"));
    expect(sourceSql).toBeDefined();
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sourceSql!}`)
      .all(RECONCILIATION_SINCE, 10_000_000, 500)
      .map((row) => row.detail).join("\n");
    expect(plan).toContain("idx_mbe2_ts");
    expect(plan).toContain("timestamp>?");
    expect(plan).not.toContain("SCAN mint_burn_events");
    sqlite.prepare("UPDATE mint_burn_events SET amount_usd = ? WHERE amount_usd IS NULL")
      .run(20_000_000);
    sqlite.prepare("UPDATE mint_burn_events SET burn_type = ? WHERE burn_type = 'review_required'")
      .run("effective_burn");

    // Regular reconciliation includes late changes only inside its bounded window.
    expect(await projectMintBurnLargeFlows(db, { since: SEC - 1 })).toEqual({ projected: 0, advanced: null });
    expect(await projectMintBurnLargeFlows(db, { dryRun: true })).toEqual({ projected: 2, advanced: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM tape_events").get()).toEqual({ n: 1 });
    expect(await projectMintBurnLargeFlows(db, { maxRows: 1 })).toEqual({ projected: 1, advanced: SEC });
    expect(await projectMintBurnLargeFlows(db, { maxRows: 1 })).toEqual({ projected: 1, advanced: SEC });
    expect(await projectMintBurnLargeFlows(db)).toEqual({ projected: 0, advanced: null });
    expect(await projectMintBurnLargeFlows(db, { since: 0, dryRun: true })).toEqual({ projected: 2, advanced: null });
    expect(await projectMintBurnLargeFlows(db, { since: 0, maxRows: 1 })).toEqual({ projected: 1, advanced: oldTime });
    expect(await projectMintBurnLargeFlows(db, { since: 0, maxRows: 1 })).toEqual({ projected: 1, advanced: oldTime + 1 });

    const events = sqlite.prepare("SELECT event_id, source_row_id, ts, type FROM tape_events ORDER BY source_row_id");
    const projected = events.all();
    expect(projected).toEqual([
      { event_id: expect.any(String), source_row_id: "newer-priced", ts: SEC * 1000, type: "mint_burn.large_mint" },
      { event_id: expect.any(String), source_row_id: "old-review", ts: (oldTime + 1) * 1000, type: "mint_burn.large_burn" },
      { event_id: expect.any(String), source_row_id: "old-unpriced", ts: oldTime * 1000, type: "mint_burn.large_mint" },
      { event_id: expect.any(String), source_row_id: "recent-review", ts: (recentTime + 1) * 1000, type: "mint_burn.large_burn" },
      { event_id: expect.any(String), source_row_id: "recent-unpriced", ts: recentTime * 1000, type: "mint_burn.large_mint" },
    ]);
    expect(await projectMintBurnLargeFlows(db)).toEqual({ projected: 0, advanced: null });
    expect(await projectMintBurnLargeFlows(db, { since: 0 })).toEqual({ projected: 0, advanced: null });
    expect(events.all()).toEqual(projected);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'tape-projector:cursor:mint_burn.large_flow'").get())
      .toEqual({ value: String(SEC) });
  });

  it("retracts claims whose source became ineligible and republishes eligible corrections in place", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, timestamp,
       flow_type, burn_type, tx_hash, block_number, explorer_tx_url)
      VALUES (?, 'usdt-tether', 'USDT', 'ethereum', ?, 1, 20000000, ?, 'standard', ?, '0xtest', 1, 'https://example.com')`);
    for (const id of ["internal", "small", "unpriced", "review", "bridge", "amount", "same", "pruned"]) {
      insert.run(id, id === "review" ? "burn" : "mint", SEC - 100, id === "review" ? "effective_burn" : null);
    }
    await projectMintBurnLargeFlows(db);
    const claim = (id: string) => sqlite.prepare(
      "SELECT id, event_id, created_at, title, suppressed_at, suppression_reason FROM tape_events WHERE source_row_id = ?",
    ).get(id)!;
    const before = Object.fromEntries(["amount", "same", "pruned", "internal"].map((id) => [id, claim(id)]));

    const update = (set: string, id: string) => sqlite.prepare(`UPDATE mint_burn_events SET ${set} WHERE id = ?`).run(id);
    update("flow_type = 'protocol_internal'", "internal");
    update("amount_usd = 5000000", "small");
    update("amount_usd = NULL", "unpriced");
    update("burn_type = 'review_required'", "review");
    update("flow_type = 'bridge_transfer'", "bridge");
    update("amount_usd = 30000000", "amount");
    sqlite.prepare("DELETE FROM mint_burn_events WHERE id = 'pruned'").run();

    // Dry-run reports without mutating.
    await projectMintBurnLargeFlows(db, { dryRun: true });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM tape_events WHERE suppressed_at IS NOT NULL").get()).toEqual({ n: 0 });

    await projectMintBurnLargeFlows(db);
    for (const id of ["internal", "small", "unpriced", "review", "bridge"]) {
      expect(claim(id)).toMatchObject({ suppressed_at: SEC, suppression_reason: "flow-claim-retracted" });
    }
    // Eligible correction keeps identity and clocks; only presentation fields change.
    expect(claim("amount")).toMatchObject({
      id: before.amount.id, event_id: before.amount.event_id, created_at: before.amount.created_at,
      suppressed_at: null, title: expect.stringContaining("$30"),
    });
    expect(JSON.parse((sqlite.prepare("SELECT payload_json FROM tape_events WHERE source_row_id = 'amount'").get() as { payload_json: string }).payload_json).amountUsd)
      .toBe(30_000_000);
    expect(claim("same")).toEqual(before.same);
    // A pruned source is never a retraction.
    expect(claim("pruned")).toEqual(before.pruned);

    // A retracted identity is never revived, even when the source becomes eligible again.
    update("flow_type = 'standard'", "internal");
    await projectMintBurnLargeFlows(db);
    await projectMintBurnLargeFlows(db, { since: 0 });
    expect(claim("internal")).toEqual({ ...before.internal, suppressed_at: SEC, suppression_reason: "flow-claim-retracted" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM tape_events WHERE source_row_id = 'internal'").get()).toEqual({ n: 1 });
  });

  it("derives the same nonempty event identity independently of persistence", async () => {
    const first = mockTapeD1(withRows([makeFlow()])) as MockD1Database;
    const second = mockTapeD1(withRows([makeFlow()])) as MockD1Database;
    await projectMintBurnLargeFlows(first);
    await projectMintBurnLargeFlows(second);
    const firstIds = tapeInsertBindsForType(first, "mint_burn.large_mint").map((binds) => binds[0]);
    expect(firstIds).toEqual([expect.stringMatching(/\S+/)]);
    expect(tapeInsertBindsForType(second, "mint_burn.large_mint").map((binds) => binds[0])).toEqual(firstIds);
  });

  it("expands a full batch to include all rows at the cutoff timestamp before advancing", async () => {
    const rows = [
      makeFlow({ id: "ethereum-0xa-0", timestamp: SEC }),
      makeFlow({ id: "ethereum-0xb-0", timestamp: SEC }),
      makeFlow({ id: "ethereum-0xc-0", timestamp: SEC }),
    ];
    const db = mockTapeD1([
      NO_CHANGED_CLAIMS,
      { match: "FROM cache WHERE key", rows: [] },
      { match: MATCH_FETCH_FLOWS, matchBinds: [RECONCILIATION_SINCE, 10_000_000, 2], rows: rows.slice(0, 2) },
      { match: MATCH_FETCH_FLOWS, matchBinds: [RECONCILIATION_SINCE, SEC, 10_000_000], rows },
    ]) as MockD1Database;

    const result = await projectMintBurnLargeFlows(db, { maxRows: 2 });

    expect(result.advanced).toBe(SEC);
    expect(tapeInsertBindsForType(db, "mint_burn.large_mint")).toHaveLength(3);
  });

  it("emits nothing on an empty source", async () => {
    const db = mockTapeD1(withRows([])) as MockD1Database;
    await projectMintBurnLargeFlows(db);
    expect(tapeInsertBinds(db)).toHaveLength(0);
  });
});
