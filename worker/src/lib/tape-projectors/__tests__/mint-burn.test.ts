import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});
import { type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { projectMintBurnLargeFlows } from "../mint-burn";
import { mockTapeD1, tapeCacheWriteBinds, tapeInsertBinds, tapeInsertBindsForType } from "./test-support";
import { projectPsiBandShifts } from "../psi";
import { projectScoreDowngraded, projectScoreUpgraded } from "../score";
import { SOURCE_RECONCILIATION_LOOKBACK_SEC } from "../types";
import { MINT_BURN_CONFIGS } from "../../mint-burn-contracts";
import { mintBurnConfigKey } from "../../mint-burn-pipeline/sync-state";
import { mintBurnScanFingerprint } from "../../mint-burn-pipeline/scan-coverage";

const SEC = 1_700_000_000;
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(SEC * 1000));
const RECONCILIATION_SINCE = SEC - SOURCE_RECONCILIATION_LOOKBACK_SEC;

const MATCH_FETCH_FLOWS = "mint_burn_events.amount_usd >= 10000000";
const NO_CHANGED_CLAIMS: MockTableConfig = { match: "JOIN tape_events AS t", rows: [] };

function withRows(rows: Record<string, unknown>[]): MockTableConfig[] {
  return [
    NO_CHANGED_CLAIMS,
    { match: "FROM mint_burn_admission", rows: [] },
    { match: "FROM mint_burn_publication_policy", rows: [] },
    { match: "pharos:mint-burn-scan-coverage:read", rows: [] },
    { match: "pharos:mint-burn-legacy-evidence", rows: [] },
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
  it("projects admitted legs only and honors the operator disable policy before limiting rows", async () => {
    const { db, sqlite } = fixtures.open();
    const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "usdt-tether");
    const pending = { ...configs[0], chain: { ...configs[0].chain, chainId: "synthetic-pending" } };
    MINT_BURN_CONFIGS.push(pending);
    try {
      const insert = sqlite.prepare(`INSERT INTO mint_burn_events
        (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, timestamp,
         flow_type, tx_hash, block_number, explorer_tx_url)
        VALUES (?, 'usdt-tether', 'USDT', ?, 'mint', 15000000, 15000000, ?, 'standard', '0xtest', 1, 'https://example.com')`);
      insert.run("pending", pending.chain.chainId, SEC - 1);
      insert.run("admitted", configs[0].chain.chainId, SEC);
      expect(await projectMintBurnLargeFlows(db, { maxRows: 1 })).toEqual({ projected: 1, advanced: SEC });
      expect(sqlite.prepare("SELECT source_row_id FROM tape_events").all()).toEqual([{ source_row_id: "admitted" }]);
      insert.run("disabled", configs[0].chain.chainId, SEC + 1);
      sqlite.prepare("INSERT INTO mint_burn_publication_policy (id, disabled_keys, updated_at) VALUES (1, ?, ?)")
        .run(JSON.stringify(configs.map(mintBurnConfigKey)), SEC);
      expect(await projectMintBurnLargeFlows(db)).toEqual({ projected: 0, advanced: null });
      expect(sqlite.prepare("SELECT source_row_id FROM tape_events").all()).toEqual([{ source_row_id: "admitted" }]);
      sqlite.prepare(`INSERT INTO mint_burn_admission
        (config_key, config_fingerprint, admitted_at, baseline_from, baseline_to) VALUES (?, ?, ?, ?, ?)`)
        .run(mintBurnConfigKey(pending), mintBurnScanFingerprint(pending), SEC, SEC - 90 * 86400, SEC);
      // Admission enables current events without announcing the completed backfill.
      expect(await projectMintBurnLargeFlows(db)).toEqual({ projected: 0, advanced: null });
      insert.run("newly-admitted", pending.chain.chainId, SEC + 1);
      expect(await projectMintBurnLargeFlows(db)).toEqual({ projected: 1, advanced: SEC + 1 });
      expect(sqlite.prepare("SELECT source_row_id FROM tape_events ORDER BY source_row_id").all())
        .toEqual([{ source_row_id: "admitted" }, { source_row_id: "newly-admitted" }]);
    } finally { MINT_BURN_CONFIGS.splice(MINT_BURN_CONFIGS.indexOf(pending), 1); }
  });

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
      makeFlow({ id: "mint-review", burn_type: "review_required" }),
      makeFlow({ id: "burn-null", direction: "burn", burn_type: null }),
      makeFlow({ id: "burn-unknown", direction: "burn", burn_type: "legacy-unknown" }),
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
    const sourceSql = prepare.mock.calls.map(([sql]) => sql).find((sql) => sql.includes(MATCH_FETCH_FLOWS));
    expect(sourceSql).toBeDefined();
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sourceSql!}`)
      .all(RECONCILIATION_SINCE, JSON.stringify([["usdt-tether", "ethereum"]]), "[]", 500)
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

  it("still publishes newly eligible flows when one stored claim payload is not valid JSON", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, timestamp,
       flow_type, tx_hash, block_number, explorer_tx_url)
      VALUES (?, 'usdt-tether', 'USDT', 'ethereum', 'mint', 20000000, 20000000, ?,
              'standard', '0xtest', 1, 'https://example.com')`);
    insert.run("damaged-claim", SEC - 100);
    expect(await projectMintBurnLargeFlows(db)).toEqual({ projected: 1, advanced: SEC - 100 });

    // The read boundary models an unparsable stored payload as
    // `payload-json-invalid`; one such row must not halt the rest of the class.
    sqlite.prepare("UPDATE tape_events SET payload_json = 'not json' WHERE source_row_id = 'damaged-claim'").run();

    insert.run("fresh-flow", SEC);
    const result = await projectMintBurnLargeFlows(db);

    expect(result.advanced).toBe(SEC);
    expect(sqlite.prepare(
      "SELECT type, coin_id, severity FROM tape_events WHERE source_row_id = 'fresh-flow'",
    ).get()).toEqual({ type: "mint_burn.large_mint", coin_id: "usdt-tether", severity: "notice" });
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
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, timestamp,
       flow_type, tx_hash, block_number, explorer_tx_url)
      VALUES (?, 'usdt-tether', 'USDT', ?, 'mint', 15000000, 15000000, ?,
              'standard', '0xtest', 1, 'https://example.com')`);
    for (const id of ["ethereum-0xa-0", "ethereum-0xb-0", "ethereum-0xc-0"]) {
      insert.run(id, "ethereum", SEC);
    }
    insert.run("tron-pending", "tron", SEC);

    const result = await projectMintBurnLargeFlows(db, { maxRows: 2 });

    expect(result).toEqual({ projected: 3, advanced: SEC });
    expect(sqlite.prepare("SELECT source_row_id FROM tape_events ORDER BY source_row_id").all()).toEqual([
      { source_row_id: "ethereum-0xa-0" }, { source_row_id: "ethereum-0xb-0" }, { source_row_id: "ethereum-0xc-0" },
    ]);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'tape-projector:cursor:mint_burn.large_flow'").get())
      .toEqual({ value: String(SEC) });
  });

  it("emits nothing on an empty source", async () => {
    const db = mockTapeD1(withRows([])) as MockD1Database;
    await projectMintBurnLargeFlows(db);
    expect(tapeInsertBinds(db)).toHaveLength(0);
  });
});

const MATCH_FETCH_SAMPLES = "WHERE stored_at > ?";
const MATCH_PRIOR_BAND = "WHERE stored_at <= ?";

function tables(samples: Record<string, unknown>[], priors: Record<string, unknown>[] = []): MockTableConfig[] {
  return [
    { match: "FROM cache WHERE key", rows: [] },
    // Prior-band lookup must match BEFORE the samples query (substring tie).
    { match: MATCH_PRIOR_BAND, rows: priors, first: priors[0] ?? null },
    { match: MATCH_FETCH_SAMPLES, rows: samples },
  ];
}

describe("psi projector", () => {
  it("scales severity to critical for MELTDOWN transitions", async () => {
    const db = mockTapeD1(
      tables([
        { stored_at: SEC,       score: 96, band: "BEDROCK",  methodology_version: "3.3" },
        { stored_at: SEC + 900, score: 5,  band: "MELTDOWN", methodology_version: "3.3" },
      ]),
    ) as MockD1Database;

    await projectPsiBandShifts(db);
    const inserts = tapeInsertBindsForType(db, "psi.shifted_down");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("critical");
  });

  it("emits psi.shifted_up at info regardless of magnitude", async () => {
    const db = mockTapeD1(
      tables([
        { stored_at: SEC,       score: 50, band: "CRISIS",  methodology_version: "3.3" },
        { stored_at: SEC + 900, score: 96, band: "BEDROCK", methodology_version: "3.3" },
      ]),
    ) as MockD1Database;

    await projectPsiBandShifts(db);
    const ups = tapeInsertBindsForType(db, "psi.shifted_up");
    const downs = tapeInsertBindsForType(db, "psi.shifted_down");
    expect(ups).toHaveLength(1);
    expect(downs).toHaveLength(0);
    expect(ups[0]![2]).toBe("info");
  });

  it("uses the immediately preceding same-band score and keeps payloads identical across split scans", async () => {
    const scan = async (split: boolean) => {
      const { db, sqlite } = fixtures.open();
      const insert = sqlite.prepare("INSERT INTO stability_index_samples (stored_at, score, band, methodology_version, components, input_snapshot) VALUES (?, ?, ?, '3.3', '{}', '{}')");
      insert.run(SEC, 99, "BEDROCK");
      insert.run(SEC + 900, 95, "BEDROCK");
      insert.run(SEC + 1800, 90, "STEADY");
      if (split) {
        expect(await projectPsiBandShifts(db, { maxRows: 2 })).toEqual({ projected: 0, advanced: SEC + 900 });
      }
      expect(await projectPsiBandShifts(db)).toEqual({ projected: 1, advanced: SEC + 1800 });
      return sqlite.prepare("SELECT event_id, source_row_id, payload_json FROM tape_events").get()!;
    };

    const oneShot = await scan(false);
    expect(JSON.parse(String(oneShot.payload_json))).toEqual({
      prevBand: "BEDROCK", newBand: "STEADY", prevScore: 95, newScore: 90, sampleAt: SEC + 1800,
    });
    expect(await scan(true)).toEqual(oneShot);
  });

  it("uses prior-batch band when only one sample appears in the new batch", async () => {
    const db = mockTapeD1([
      { match: "FROM cache WHERE key", rows: [{ key: "tape-projector:cursor:psi.band_changed", value: String(SEC - 1) }] },
      { match: MATCH_PRIOR_BAND, rows: [], first: { stored_at: SEC - 900, score: 96, band: "BEDROCK", methodology_version: "3.3" } },
      { match: MATCH_FETCH_SAMPLES, rows: [{ stored_at: SEC + 900, score: 70, band: "FRACTURE", methodology_version: "3.3" }] },
    ]) as MockD1Database;

    await projectPsiBandShifts(db);
    const inserts = tapeInsertBindsForType(db, "psi.shifted_down");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("warning"); // BEDROCK → FRACTURE
  });

  it("persists one shift across cursor reruns and forced source replay", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO stability_index_samples (stored_at, score, band, methodology_version, components, input_snapshot) VALUES (?, ?, ?, '3.3', '{}', '{}')");
    insert.run(SEC, 96, "BEDROCK");
    insert.run(SEC + 900, 70, "FRACTURE");
    await projectPsiBandShifts(db);
    const select = sqlite.prepare("SELECT event_id, source_row_id, type, severity FROM tape_events");
    const events = select.all();
    expect(events).toEqual([{
      event_id: expect.any(String), source_row_id: `${SEC + 900}:FRACTURE`, type: "psi.shifted_down", severity: "warning",
    }]);
    const cursor = sqlite.prepare("SELECT value FROM cache WHERE key = 'tape-projector:cursor:psi.band_changed'");
    expect(cursor.get()).toEqual({ value: String(SEC + 900) });
    await projectPsiBandShifts(db);
    await projectPsiBandShifts(db, { since: 0 });
    expect(select.all()).toEqual(events);
    expect(cursor.get()).toEqual({ value: String(SEC + 900) });
  });

  it("derives the same nonempty shift identity independently of persistence", async () => {
    const samples = [
      { stored_at: SEC, score: 96, band: "BEDROCK", methodology_version: "3.3" },
      { stored_at: SEC + 900, score: 70, band: "FRACTURE", methodology_version: "3.3" },
    ];
    const first = mockTapeD1(tables(samples)) as MockD1Database;
    const second = mockTapeD1(tables(samples)) as MockD1Database;
    await projectPsiBandShifts(first);
    await projectPsiBandShifts(second);
    const firstIds = tapeInsertBindsForType(first, "psi.shifted_down").map((binds) => binds[0]);
    expect(firstIds).toEqual([expect.stringMatching(/\S+/)]);
    expect(tapeInsertBindsForType(second, "psi.shifted_down").map((binds) => binds[0])).toEqual(firstIds);
  });
});

const MATCH_GRADE_HISTORY = "FROM safety_grade_history";

function gradeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stablecoin_id: "usdt-tether",
    recorded_at: SEC,
    grade: "A",
    score: 90,
    prev_grade: "B",
    prev_score: 75,
    methodology_version: "8.11",
    model: "v8",
    identity_schema_version: 1,
    policy_id: null,
    policy_digest: null,
    evaluation_build_digest: null,
    base_input_generation_id: null,
    model_publication_generation_id: null,
    transition_kind: "organic-grade-change",
    source_table: "safety_grade_history",
    source_row_id: `usdt-tether:${SEC}`,
    row_sort_id: `legacy:usdt-tether:${SEC}`,
    ...overrides,
  };
}

function scoreTables(rows: Record<string, unknown>[], cursor?: number): MockTableConfig[] {
  return [
    {
      match: "FROM cache WHERE key",
      rows: cursor == null ? [] : [{ key: "tape-projector:cursor:score.upgraded", value: String(cursor) }],
    },
    { match: MATCH_GRADE_HISTORY, rows },
  ];
}

describe("score projector", () => {
  it("routes grade upgrades to score.upgraded with info severity", async () => {
    const db = mockTapeD1(scoreTables([gradeRow()])) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result).toEqual({ projected: 1, advanced: SEC });
    const inserts = tapeInsertBinds(db);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toBe("score.upgraded");
    expect(inserts[0]![2]).toBe("info");
    expect(inserts[0]![13]).toBe("usdt-tether:1700000000");
  });

  it("routes grade downgrades and scales severity by rank delta", async () => {
    const db = mockTapeD1(
      scoreTables([gradeRow({ grade: "B-", score: 65, prev_grade: "A", prev_score: 85 })]),
    ) as MockD1Database;

    const result = await projectScoreDowngraded(db);

    expect(result).toEqual({ projected: 1, advanced: SEC });
    const inserts = tapeInsertBinds(db);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toBe("score.downgraded");
    expect(inserts[0]![2]).toBe("severe");
  });

  it("skips equal-rank rows but advances the watermark past them", async () => {
    const db = mockTapeD1(scoreTables([gradeRow({ grade: "B", prev_grade: "B" })])) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result).toEqual({ projected: 0, advanced: SEC });
    expect(tapeInsertBinds(db)).toHaveLength(0);
    expect(tapeCacheWriteBinds(db, "score.upgraded")[0]?.[1]).toBe(String(SEC));
  });

  it("expands a full batch through same-timestamp grade rows before advancing the watermark", async () => {
    const limitedRows = [
      gradeRow({ stablecoin_id: "usdt-tether", source_row_id: `usdt-tether:${SEC}`, row_sort_id: "1" }),
      gradeRow({ stablecoin_id: "usdc-circle", source_row_id: `usdc-circle:${SEC}`, row_sort_id: "2" }),
    ];
    const expandedRows = [
      ...limitedRows,
      gradeRow({ stablecoin_id: "dai-makerdao", source_row_id: `dai-makerdao:${SEC}`, row_sort_id: "3" }),
    ];
    const db = mockTapeD1([
      { match: "FROM cache WHERE key", rows: [] },
      { match: MATCH_GRADE_HISTORY, matchBinds: [0, 2], rows: limitedRows },
      { match: MATCH_GRADE_HISTORY, matchBinds: [0, SEC], rows: expandedRows },
    ]) as MockD1Database;

    const result = await projectScoreUpgraded(db, { maxRows: 2 });

    expect(result).toEqual({ projected: 3, advanced: SEC });
    expect(tapeInsertBinds(db).map((binds) => binds[13])).toEqual([
      "usdt-tether:1700000000",
      "usdc-circle:1700000000",
      "dai-makerdao:1700000000",
    ]);
    expect(tapeCacheWriteBinds(db, "score.upgraded")[0]?.[1]).toBe(String(SEC));
  });

  it("treats unknown grades as lower than NR for guarded fallback ordering", async () => {
    const db = mockTapeD1(
      scoreTables([gradeRow({ grade: "NR", score: null, prev_grade: "UNKNOWN", prev_score: null })]),
    ) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result.projected).toBe(1);
    const inserts = tapeInsertBinds(db);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toBe("score.upgraded");
  });

  it("preserves V2 source identity for organic rows", async () => {
    const db = mockTapeD1(
      scoreTables([
        gradeRow({
          source_table: "safety_score_history_v2",
          source_row_id: "safety-score-history:v2:event:123",
          row_sort_id: "v2:safety-score-history:v2:event:123",
          evaluation_build_digest: "a".repeat(64),
          base_input_generation_id: `report-cards-input:v1:${"b".repeat(64)}`,
          model_publication_generation_id: "report-cards:8.11:123",
        }),
      ]),
    ) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result.projected).toBe(1);
    const inserts = tapeInsertBinds(db);
    expect(inserts[0]?.[12]).toBe("safety_score_history_v2");
    expect(inserts[0]?.[13]).toBe("safety-score-history:v2:event:123");
    expect(JSON.parse(String(inserts[0]?.[11]))).toMatchObject({
      safetyScore: {
        identityStatus: "complete",
        identity: { model: "v8", evaluationBuildDigest: "a".repeat(64) },
      },
    });
  });

  it("retains V8 identity for dual-written legacy rows while marking true legacy rows unidentified", async () => {
    const dualWrittenSourceRowId = `usdt-tether:${SEC}`;
    const trueLegacySourceRowId = `usdc-circle:${SEC}`;
    const db = mockTapeD1(
      scoreTables([
        gradeRow({
          source_table: "safety_grade_history",
          source_row_id: dualWrittenSourceRowId,
          row_sort_id: "v2:safety-score-history:v2:usdt-tether:1700000000",
          evaluation_build_digest: "a".repeat(64),
          base_input_generation_id: `report-cards-input:v1:${"b".repeat(64)}`,
          model_publication_generation_id: "report-cards:8.11:1700000000",
        }),
        gradeRow({
          stablecoin_id: "usdc-circle",
          source_table: "safety_grade_history",
          source_row_id: trueLegacySourceRowId,
          row_sort_id: `legacy:${trueLegacySourceRowId}`,
        }),
      ]),
    ) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result).toEqual({ projected: 2, advanced: SEC });
    const provenanceBySourceRowId = Object.fromEntries(
      tapeInsertBinds(db).map((binds) => [
        String(binds[13]),
        (JSON.parse(String(binds[11])) as { safetyScore: unknown }).safetyScore,
      ]),
    );
    expect(provenanceBySourceRowId[dualWrittenSourceRowId]).toEqual({
      identityStatus: "complete",
      identity: {
        model: "v8",
        schemaVersion: 1,
        methodologyVersion: "8.11",
        evaluationBuildDigest: "a".repeat(64),
        baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
        publicationGenerationId: "report-cards:8.11:1700000000",
      },
    });
    expect(provenanceBySourceRowId[trueLegacySourceRowId]).toEqual({
      identityStatus: "legacy-v8-unidentified",
      identity: null,
    });
  });

  it("projects an organic V9 row with complete policy provenance", async () => {
    const db = mockTapeD1(
      scoreTables([
        gradeRow({
          source_table: "safety_score_history_v2",
          source_row_id: "safety-score-history:v2:v9:123",
          row_sort_id: "v2:safety-score-history:v2:v9:123",
          methodology_version: "9.0",
          model: "v9",
          policy_id: "safety-score-v9-policy",
          policy_digest: "c".repeat(64),
          evaluation_build_digest: "a".repeat(64),
          base_input_generation_id: `report-cards-input:v1:${"b".repeat(64)}`,
          model_publication_generation_id: "safety-score-v9:123",
        }),
      ]),
    ) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result).toEqual({ projected: 1, advanced: SEC });
    expect(JSON.parse(String(tapeInsertBinds(db)[0]?.[11]))).toMatchObject({
      safetyScore: {
        identityStatus: "complete",
        identity: {
          model: "v9",
          schemaVersion: 1,
          methodologyVersion: "9.0",
          policyId: "safety-score-v9-policy",
          policyDigest: "c".repeat(64),
          evaluationBuildDigest: "a".repeat(64),
          baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
          publicationGenerationId: "safety-score-v9:123",
        },
      },
    });
  });

  it.each([
    {
      name: "skips a V9 row whose policy identity is incomplete",
      overrides: {
        source_table: "safety_score_history_v2",
        source_row_id: "safety-score-history:v2:v9:123",
        row_sort_id: "v2:safety-score-history:v2:v9:123",
        model: "v9",
        policy_id: null,
        policy_digest: null,
        evaluation_build_digest: "a".repeat(64),
        base_input_generation_id: `report-cards-input:v1:${"b".repeat(64)}`,
        model_publication_generation_id: "safety-score-v9:123",
      },
    },
    {
      name: "does not project methodology-boundary baselines as organic movements",
      overrides: {
        transition_kind: "methodology-boundary-baseline",
        prev_grade: null,
        prev_score: null,
      },
    },
  ])("$name", async ({ overrides }) => {
    const db = mockTapeD1(scoreTables([gradeRow(overrides)])) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result).toEqual({ projected: 0, advanced: SEC });
    expect(tapeInsertBinds(db)).toHaveLength(0);
  });

  it("does not insert events or advance the cursor during dry runs", async () => {
    const db = mockTapeD1(scoreTables([gradeRow()])) as MockD1Database;

    const result = await projectScoreUpgraded(db, { dryRun: true });

    expect(result).toEqual({ projected: 1, advanced: null });
    expect(tapeInsertBinds(db)).toHaveLength(0);
    expect(tapeCacheWriteBinds(db, "score.upgraded")).toHaveLength(0);
  });

  it("does not publish a not-rated coin becoming rated as a grade upgrade", async () => {
    const db = mockTapeD1(
      scoreTables([gradeRow({ grade: "F", score: 20, prev_grade: "NR", prev_score: null })]),
    ) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    // NR is the explicit not-rated outcome, not a grade below F.
    expect(result).toEqual({ projected: 0, advanced: SEC });
    expect(tapeInsertBinds(db)).toHaveLength(0);
  });

  it("does not publish a rated coin losing its rating as a severe grade downgrade", async () => {
    const db = mockTapeD1(
      scoreTables([gradeRow({ grade: "NR", score: null, prev_grade: "A", prev_score: 85 })]),
    ) as MockD1Database;

    const result = await projectScoreDowngraded(db);

    expect(result).toEqual({ projected: 0, advanced: SEC });
    expect(tapeInsertBinds(db)).toHaveLength(0);
  });
});
