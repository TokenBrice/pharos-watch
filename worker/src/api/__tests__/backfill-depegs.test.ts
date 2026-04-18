import { describe, expect, it } from "vitest";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { mockD1 } from "./helpers/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";
import { applyBackfillEvents, handleBackfillDepegs } from "../backfill-depegs";
import type { BackfillReplayWindow } from "../backfill-depegs-window";

stubCryptoForAuth();

describe("handleBackfillDepegs", () => {
  it("requires admin auth", async () => {
    const res = await handleBackfillDepegs(
      mockD1(),
      makeApiUrl("/api/backfill-depegs"),
      undefined,
      makeApiRequest("/api/backfill-depegs"),
    );

    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown stablecoin", async () => {
    const res = await handleBackfillDepegs(
      mockD1(),
      makeApiUrl("/api/backfill-depegs?stablecoin=not-a-real-id"),
      true,
      makeApiRequest("/api/backfill-depegs?stablecoin=not-a-real-id", { adminKey: "secret" }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Stablecoin not found" });
  });

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillDepegs(
      mockD1(),
      makeApiUrl("/api/backfill-depegs?batch=999999"),
      true,
      makeApiRequest("/api/backfill-depegs?batch=999999", { adminKey: "secret" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "No coins in this batch" });
  });

  it("validates bounded replay contextDays", async () => {
    const res = await handleBackfillDepegs(
      mockD1(),
      makeApiUrl("/api/backfill-depegs?stablecoin=usdt-tether&startDay=2025-01-01&endDay=2025-01-02&contextDays=999"),
      true,
      makeApiRequest("/api/backfill-depegs?stablecoin=usdt-tether&startDay=2025-01-01&endDay=2025-01-02&contextDays=999", {
        adminKey: "secret",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
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
      prepare(sql: string) { return { sql, bind() { return this; }, async run() { return {}; } } as unknown as D1PreparedStatement; },
      async batch(stmts: D1PreparedStatement[]) { calls.push({ size: stmts.length }); return []; },
    } as unknown as D1Database;
    await applyBackfillEvents(db, { id: "usdt-tether", symbol: "USDT" }, [], { startDay: 0, endDay: 1e10 } as unknown as BackfillReplayWindow);
    expect(calls).toEqual([{ size: 1 }]);
  });
});
