import { readJsonResponse } from "../../../src/test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { makeApiUrl, stubCryptoForAuth } from "../../../src/test-helpers/__shared/auth";
import { makeNoopD1 } from "../../../src/test-helpers/noop-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { registerStablecoinParameterContract } from "../../../src/test-helpers/__shared/endpoint-contracts";
import { applyBackfillEvents, buildBackfillEventsFingerprint, handleBackfillDepegsTrusted } from "../backfill-depegs";
import { loadExistingReplayRows } from "../backfill-depegs-preview";
import { loadIncompleteBackfillReplayWindow } from "../backfill-depegs-window";
import { buildReplayWindow, type BackfillReplayWindow } from "../../../src/lib/backfill-day-window";
import { createBackfillDatabase } from "../../lib/backfill-d1";
import * as history from "../../../src/lib/historical-market-prices";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { executeBackfillForCoin, type ApplyBackfillEventsFn } from "../backfill-depegs/execution";

stubCryptoForAuth();
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

describe("handleBackfillDepegs", () => {
  registerStablecoinParameterContract({
    name: "depeg backfill",
    path: "/api/backfill-depegs",
    invoke: (db, url) => handleBackfillDepegsTrusted({ db, url }),
    cases: [{ kind: "unknown", stablecoin: "not-a-real-id", error: "Stablecoin not found" }],
  });

  it("validates bounded replay contextDays", async () => {
    const res = await handleBackfillDepegsTrusted({ db: mockD1(), url: makeApiUrl("/api/backfill-depegs?stablecoin=usdt-tether&startDay=2025-01-01&endDay=2025-01-02&contextDays=999") });

    expect(await readJsonResponse(res, 400)).toEqual({
      error: "Invalid contextDays. Use an integer between 0 and 90.",
    });
  });

  it.each([false, true])("uses hourly evidence for coverage and never completes a padding-only window (%s)", async (paddingOnly) => {
    const { db, sqlite } = fixtures.open();
    const day = Date.parse("2026-03-05T00:00:00Z") / 1000;
    const ts = (hours: number) => day + (hours - (paddingOnly ? 48 : 0)) * 3600;
    const prices = [0, 1, 2, 25, 26, 27].map((hour, index) => ({
      timestamp: ts(hour), price: index === 0 || index === 5 ? 1 : 0.97,
    }));
    vi.spyOn(history, "fetchMarketBackfillPriceSeries").mockResolvedValue({
      prices, diagnostics: {
        granularity: "hourly", quoteMode: "usd", quoteCurrency: "usd", sourcesUsed: ["coingecko"],
        mergeReasons: [], perSourceStats: [], policyAdjustments: [], finalPointCount: prices.length,
      },
    });
    const apply = vi.fn<ApplyBackfillEventsFn>(async (...args) => { await applyBackfillEvents(db, ...args); });
    const outcome = await executeBackfillForCoin({
      db, prepared: { meta: TRACKED_META_BY_ID.get("usdt-tether")!, geckoId: "tether",
        supplyTokens: [{ date: String(ts(0)), totalCirculatingUSD: { peggedUSD: 2_000_000 } }] },
      fxSeries: {}, commodityPeers: {}, replayWindow: buildReplayWindow(day, day + 86400, 2),
      coingeckoApiKey: null, dryRun: false, applyBackfillEvents: apply,
    });
    if (paddingOnly) {
      expect(outcome).toMatchObject({ status: "skipped", reason: "no-admitted-observations-in-comparison-window" });
      expect(apply).not.toHaveBeenCalled();
      expect(sqlite.prepare("SELECT count(*) AS count FROM depeg_backfill_runs").get()).toEqual({ count: 0 });
    } else {
      expect(outcome).toMatchObject({ status: "applied", eventCount: 1 });
      const row = sqlite.prepare("SELECT admitted_coverage_json FROM depeg_events").get()!;
      expect(JSON.parse(String(row.admitted_coverage_json))).toEqual([
        { fromSec: ts(1), toSec: ts(2) }, { fromSec: ts(25), toSec: ts(26) },
      ]);
    }
  });

  it("combines delete and first insert chunk into a single batch (total <= D1 100-statement limit)", async () => {
    const calls: Array<{ kind: "batch"; size: number; firstSql: string }> = [];
    const db = makeNoopD1({
      prepare(sql: string) {
        return {
          sql,
          bind(..._args: unknown[]) { return this; },
          async all() { return { results: [], success: true, meta: {} }; },
          async run() { /* test helper only */ return {}; },
        } as unknown as D1PreparedStatement;
      },
      async batch(stmts: D1PreparedStatement[]) {
        const firstStatement = stmts[0] as D1PreparedStatement & { sql: string };
        calls.push({
          kind: "batch",
          size: stmts.length,
          firstSql: firstStatement.sql.trim(),
        });
        return [];
      },
    });
    const events = new Array(150).fill(null).map((_, i) => ({
      pegType: "peggedUSD",
      direction: "below" as const,
      peakDeviationBps: -120,
      startedAt: 1_700_000_000 + i * 86_400,
      endedAt: 1_700_000_000 + i * 86_400 + 3600,
      startPrice: 0.988,
      peakPrice: 0.984,
      recoveryPrice: 0.999,
      pegRef: 1,
    }));
    await applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, events, { startDay: 0, endDay: 1e10 } as unknown as BackfillReplayWindow);
    expect(calls[0].firstSql).toContain("id NOT IN");
    // No standalone "DELETE" batch; delete is in the first batch alongside inserts.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].firstSql.startsWith("DELETE")).toBe(true);
    // Each batch is bounded by D1's 100-statement limit. First batch: delete + 99 inserts = 100.
    // Remaining 51 inserts ship in the second batch.
    expect(calls[0].size).toBeLessThanOrEqual(100);
    expect(calls[0].size).toBe(100);
    expect(calls[1]?.size).toBe(51);
  });

  it("issues a lone delete when events.length === 0 and never crashes mid-loop", async () => {
    const calls: Array<{ size: number }> = [];
    const db = makeNoopD1({
      prepare(sql: string) {
        return {
          sql,
          bind() { return this; },
          async all() { return { results: [], success: true, meta: {} }; },
          async run() { return {}; },
        } as unknown as D1PreparedStatement;
      },
      async batch(stmts: D1PreparedStatement[]) { calls.push({ size: stmts.length }); return []; },
    });
    await applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, [], { startDay: 0, endDay: 1e10 } as unknown as BackfillReplayWindow);
    expect(calls).toEqual([{ size: 1 }]);
  });

  it.each([
    { id: 24994, stablecoinId: "paxg-paxos", disposition: "restored-evidenced" },
    { id: 89169, stablecoinId: "brz-transfero", disposition: null },
  ])("retains reviewed event $id during a replay swap", async ({ id, stablecoinId, disposition }) => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction,
      peak_deviation_bps, started_at, ended_at, start_price, peg_reference, source, disposition)
      VALUES (?, ?, 'TEST', 'peggedGOLD', 'above', 400, 1000, 2000, 1.04, 1, 'backfill', ?)`)
      .run(id, stablecoinId, disposition);
    await applyBackfillEvents(db, { id: stablecoinId, symbol: "TEST" }, [], null);
    expect(sqlite.prepare("SELECT id, disposition FROM depeg_events").all()).toEqual([{ id, disposition }]);
  });

  it.each(["reviewed", "changed", "inserted"])("aborts an inspected swap when history is %s before apply", async (change) => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
      started_at, ended_at, start_price, peg_reference, source)
      VALUES (1, 'usdt-tether', 'USDT', 'peggedUSD', 'below', -200, 1000, 2000, 0.98, 1, 'backfill')`);
    const rows = await loadExistingReplayRows(db, "usdt-tether", null);
    const row = rows.existingBackfillRows[0]!;
    if (change === "reviewed") sqlite.exec(`INSERT INTO depeg_event_provenance
      (event_id, source_kind, audit_verdict, public_json, created_at, updated_at)
      VALUES (1, 'market', 'confirmed', '{"auditVerdict":"disputed"}', 1, 1)`);
    if (change === "changed") sqlite.exec("UPDATE depeg_events SET peak_deviation_bps = -300 WHERE id = 1");
    if (change === "inserted") sqlite.exec(`INSERT INTO depeg_events
      (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference)
      VALUES ('usdt-tether', 'USDT', 'peggedUSD', 'below', -200, 1100, 2200, 0.98, 1)`);
    await expect(applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, [{
      startedAt: 1200, endedAt: 2400, direction: "below", pegType: "peggedUSD", pegRef: 1,
      startPrice: 0.98, peakPrice: 0.97, peakDeviationBps: -300, recoveryPrice: 1,
    }], null, {
      runId: "race", sourceType: "market", expectedEventCount: 1, expectedFingerprint: "race",
      removedCount: 1, addedCount: 1, replayWindow: null, replacePreimages: [{ id: 1, preimage: row.replay_preimage! }],
    })).rejects.toThrow();
    expect(sqlite.prepare("SELECT id FROM depeg_events ORDER BY id").all()).toEqual(change === "inserted" ? [{ id: 1 }, { id: 2 }] : [{ id: 1 }]);
    if (change === "reviewed") expect((await loadExistingReplayRows(db, "usdt-tether", null)).protectedBackfillRows)
      .toEqual([expect.objectContaining({ id: 1 })]);
  });

  it.each([0, 1, 2, "linked"] as const)("checks deletion identities through atomic imports (%s)", async (count) => {
    const { sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction,
      peak_deviation_bps, started_at, ended_at, start_price, peg_reference, source)
      VALUES (?, 'usdt-tether', 'USDT', 'peggedUSD', 'below', -200, ?, ?, 0.98, 1, 'backfill')`);
    for (let id = 1; id <= (count === "linked" ? 1 : count); id++) insert.run(id, id * 1000, id * 1000 + 500);
    const envelope = (results: unknown[] = [], changes = 0) => ({ success: true, results, meta: { changes, duration: 0 } });
    const db = createBackfillDatabase({
      queryRaw(sql) {
        return JSON.stringify(sql.split(";").filter((part) => part.trim()).map((part) => {
          const stmt = sqlite.prepare(part);
          return stmt.columns().length ? envelope(stmt.all()) : envelope([], Number(stmt.run().changes));
        }));
      },
      executeStatementsRaw(statements) {
        if (count === "linked") sqlite.exec(`INSERT INTO depeg_resolver_incident_event_links
          (incident_key, event_id, relation, linked_at) VALUES ('test-link', 1, 'observed', 1001)`);
        sqlite.exec("BEGIN");
        try {
          for (const sql of statements) sqlite.prepare(sql).run();
          sqlite.exec("COMMIT");
          return JSON.stringify([envelope([{ "Total queries executed": statements.length }])]);
        } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      },
    }, { atomicImports: true });
    const { existingBackfillRows } = await loadExistingReplayRows(db, "usdt-tether", null);
    const swap = applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, [{
      startedAt: 3000, endedAt: 4000, direction: "below", pegType: "peggedUSD",
      pegRef: 1, startPrice: 0.98, peakPrice: 0.98, peakDeviationBps: -200, recoveryPrice: 1,
    }], null, { runId: "test-import", sourceType: "market", expectedEventCount: 1, expectedFingerprint: "test",
      removedCount: existingBackfillRows.length, addedCount: 1, replayWindow: null,
      replacePreimages: existingBackfillRows.map((row) => ({ id: row.id, preimage: row.replay_preimage! })) });
    if (count === "linked") await expect(swap).rejects.toThrow();
    else await expect(swap).resolves.toMatchObject({ provenanceMismatchCount: 0 });
    expect(sqlite.prepare("SELECT started_at FROM depeg_events").all()).toEqual([{ started_at: count === "linked" ? 1000 : 3000 }]);
  });

  it("blocks backfill replays that would delete sealed DDRv2 backfill events", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events e",
        rows: [{
          event_id: 101,
          incident_key: "ddr2:1234567890abcdef1234567890ab",
          public_prediction_id: 80,
        }],
      },
    ]) as MockD1Database;

    await expect(
      applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, [], null),
    ).rejects.toThrow("DDRv2 sealed repair required");

    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM depeg_events"))).toBe(false);
  });

  it("blocks backfill replays that would delete unsealed DDR incident members", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events e",
        rows: [{
          event_id: 102,
          incident_key: "ddr2:1234567890abcdef1234567890ab",
          public_prediction_id: null,
        }],
      },
    ]) as MockD1Database;

    await expect(
      applyBackfillEvents(db, { id: "brla-brla-digital", symbol: "BRLA" }, [], null),
    ).rejects.toThrow("DDR incident member replay refused");

    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM depeg_events"))).toBe(false);
  });

  it("records complete replay runs and inserts provenance for backfill rows", async () => {
    const db = mockD1([
      { match: "FROM depeg_events e", rows: [] },
      { match: "INSERT INTO depeg_backfill_runs", rows: [] },
      { match: "DELETE FROM depeg_events", rows: [] },
      { match: "INSERT INTO depeg_events", rows: [] },
      { match: "INSERT OR REPLACE INTO depeg_event_provenance", rows: [] },
    ]) as MockD1Database;
    const events = [{
      pegType: "peggedUSD",
      direction: "below" as const,
      peakDeviationBps: -120,
      startedAt: 1_700_000_000,
      endedAt: 1_700_003_600,
      startPrice: 0.988,
      peakPrice: 0.984,
      recoveryPrice: 0.999,
      pegRef: 1,
      provenance: {
        replayRunId: "run-1",
        replayVersion: "test",
        sourceKind: "market" as const,
        sourcePriceProviders: ["coingecko"],
        quoteMode: "usd",
        pegReferenceSource: "fixed-usd",
        supplySource: "defillama-history",
        confirmationPolicy: "threshold-crossing",
        confirmationPointCount: 1,
        marketDiagnostics: null,
        policyAdjustments: [],
        confidenceTier: "medium" as const,
        auditVerdict: "confirmed" as const,
      },
    }];

    await applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, events, null, {
      runId: "run-1",
      sourceType: "market",
      expectedEventCount: events.length,
      expectedFingerprint: buildBackfillEventsFingerprint(events),
      removedCount: 0,
      addedCount: 1,
      replayWindow: null,
    });

    const history = db.getHistory();
    expect(history.filter((entry) => entry.sql.includes("INSERT INTO depeg_backfill_runs"))).toHaveLength(2);
    expect(history.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO depeg_event_provenance"))).toBe(true);
    expect(history.some((entry) => entry.binds.includes("complete"))).toBe(true);
  });

  it("surfaces provenance write misses and marks the replay incomplete", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = mockD1([
      { match: "FROM depeg_events e", rows: [] },
      { match: "INSERT INTO depeg_backfill_runs", rows: [] },
      { match: "DELETE FROM depeg_events", rows: [] },
      { match: "INSERT INTO depeg_events", rows: [] },
      { match: "INSERT OR REPLACE INTO depeg_event_provenance", rows: [], runMeta: { changes: 0 } },
    ]) as MockD1Database;
    const events = [{
      pegType: "peggedUSD",
      direction: "below" as const,
      peakDeviationBps: -120,
      startedAt: 1_700_000_000,
      endedAt: 1_700_003_600,
      startPrice: 0.988,
      peakPrice: 0.984,
      recoveryPrice: 0.999,
      pegRef: 1,
      provenance: {
        replayRunId: "run-mismatch",
        replayVersion: "test",
        sourceKind: "market" as const,
        sourcePriceProviders: ["coingecko"],
        quoteMode: "usd",
        pegReferenceSource: "fixed-usd",
        supplySource: "defillama-history",
        confirmationPolicy: "threshold-crossing",
        confirmationPointCount: 1,
        marketDiagnostics: null,
        policyAdjustments: [],
        confidenceTier: "medium" as const,
        auditVerdict: "confirmed" as const,
      },
    }];

    const result = await applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, events, null, {
      runId: "run-mismatch",
      sourceType: "market",
      expectedEventCount: 1,
      expectedFingerprint: buildBackfillEventsFingerprint(events),
      removedCount: 0,
      addedCount: 1,
      replayWindow: null,
    });

    expect(result).toEqual({ provenanceMismatchCount: 1 });
    expect(db.getHistory().some((entry) =>
      entry.sql.includes("INSERT INTO depeg_backfill_runs") && entry.binds.includes("incomplete")
    )).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("backfill_depegs_provenance_mismatch"));
  });

  it("retries an incomplete chunked replay window and replaces partial history", async () => {
    const { db, sqlite } = fixtures.open();
    const replayWindow: BackfillReplayWindow = {
      contextDays: 7,
      startDay: 1_700_000_000,
      endDay: 1_800_000_000,
      compareStartSec: 1_700_000_000,
      compareEndSec: 1_800_086_399,
      replayStartSec: 1_699_395_200,
      replayEndSec: 1_800_691_199,
    };
    const events = new Array(150).fill(null).map((_, i) => ({
      pegType: "peggedUSD",
      direction: "below" as const,
      peakDeviationBps: -120,
      startedAt: 1_700_000_000 + i * 86_400,
      endedAt: 1_700_003_600 + i * 86_400,
      startPrice: 0.988,
      peakPrice: 0.984,
      recoveryPrice: 0.999,
      pegRef: 1,
    }));
    let batchCount = 0;
    const flakyDb = {
      ...db,
      batch: async <T>(statements: D1PreparedStatement[]) => {
        batchCount += 1;
        if (batchCount === 2) throw new Error("forced mid-loop failure");
        return db.batch<T>(statements);
      },
    } as D1Database;

    await expect(applyBackfillEvents(
      flakyDb,
      { id: "usdt-tether", symbol: "USDT" },
      events,
      replayWindow,
      {
        runId: "run-chunk-failed",
        sourceType: "market",
        expectedEventCount: events.length,
        expectedFingerprint: buildBackfillEventsFingerprint(events),
        removedCount: 0,
        addedCount: events.length,
        replayWindow,
      },
    )).rejects.toThrow("forced mid-loop failure");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_events WHERE stablecoin_id = ?").get("usdt-tether"))
      .toEqual({ count: 99 });
    expect(await loadIncompleteBackfillReplayWindow(db, "usdt-tether")).toEqual(replayWindow);

    await applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, events, replayWindow, {
      runId: "run-chunk-retry",
      sourceType: "market",
      expectedEventCount: events.length,
      expectedFingerprint: buildBackfillEventsFingerprint(events),
      removedCount: 99,
      addedCount: events.length,
      replayWindow,
    });

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_events WHERE stablecoin_id = ?").get("usdt-tether"))
      .toEqual({ count: 150 });
    expect(sqlite.prepare(
      "SELECT status FROM depeg_backfill_runs WHERE stablecoin_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    ).get("usdt-tether")).toEqual({ status: "complete" });
    expect(await loadIncompleteBackfillReplayWindow(db, "usdt-tether")).toBeNull();
  });
});
