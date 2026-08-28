import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, expect, it } from "vitest";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { applyBackfillEvents, buildBackfillEventsFingerprint, handleBackfillDepegsTrusted } from "../backfill-depegs";
import type { BackfillReplayWindow } from "../backfill-depegs-window";

stubCryptoForAuth();

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
    const db = {
      prepare(sql: string) {
        return {
          sql,
          bind(..._args: unknown[]) { return this; },
          async all() { return { results: [], success: true, meta: {} }; },
          async run() { /* test helper only */ return {}; },
        } as unknown as D1PreparedStatement;
      },
      async batch(stmts: D1PreparedStatement[]) {
        calls.push({
          kind: "batch",
          size: stmts.length,
          firstSql: ((stmts[0] as unknown) as { sql: string }).sql.trim().split("\n")[0],
        });
        return [];
      },
    } as unknown as D1Database;
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
    const db = {
      prepare(sql: string) {
        return {
          sql,
          bind() { return this; },
          async all() { return { results: [], success: true, meta: {} }; },
          async run() { return {}; },
        } as unknown as D1PreparedStatement;
      },
      async batch(stmts: D1PreparedStatement[]) { calls.push({ size: stmts.length }); return []; },
    } as unknown as D1Database;
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

  it("marks replay runs incomplete when chunked inserts fail", async () => {
    const db = mockD1([
      { match: "FROM depeg_events e", rows: [] },
      { match: "INSERT INTO depeg_backfill_runs", rows: [] },
      { match: "DELETE FROM depeg_events", rows: [] },
      { match: "INSERT INTO depeg_events", rows: [], throwError: new Error("chunk failed") },
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
    }];

    await expect(applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, events, null, {
      runId: "run-2",
      sourceType: "market",
      expectedEventCount: events.length,
      expectedFingerprint: buildBackfillEventsFingerprint(events),
      removedCount: 0,
      addedCount: 1,
      replayWindow: null,
    })).rejects.toThrow("chunk failed");

    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO depeg_backfill_runs") && entry.binds.includes("incomplete"))).toBe(true);
  });
});
