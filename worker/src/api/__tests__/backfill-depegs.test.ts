import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { applyBackfillEvents, buildBackfillEventsFingerprint, handleBackfillDepegsTrusted } from "../backfill-depegs";
import { loadIncompleteBackfillReplayWindow, type BackfillReplayWindow } from "../backfill-depegs-window";

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

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillDepegsTrusted({ db: mockD1(), url: makeApiUrl("/api/backfill-depegs?batch=999999") });

    expect(await readJsonResponse(res, 200)).toEqual({ message: "No coins in this batch" });
  });

  it("validates bounded replay contextDays", async () => {
    const res = await handleBackfillDepegsTrusted({ db: mockD1(), url: makeApiUrl("/api/backfill-depegs?stablecoin=usdt-tether&startDay=2025-01-01&endDay=2025-01-02&contextDays=999") });

    expect(await readJsonResponse(res, 400)).toEqual({
      error: "Invalid contextDays. Use an integer between 0 and 90.",
    });
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
