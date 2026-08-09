import { describe, expect, it } from "vitest";
import {
  buildUpsertPendingDepegStmt,
  normalizePendingDepegRow,
} from "../depeg-pending";
import {
  buildPendingReason,
  isExtremeMovePending,
  parsePendingReason,
} from "../depeg-helpers";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

describe("pending reason helpers", () => {
  it("buildPendingReason orders flags canonically", () => {
    expect(buildPendingReason(["large-cap", "low-confidence"])).toBe("large-cap+low-confidence");
    expect(buildPendingReason(["low-confidence", "large-cap", "extreme-move"])).toBe("extreme-move+large-cap+low-confidence");
    expect(buildPendingReason(["extreme-move"])).toBe("extreme-move");
  });

  it("parsePendingReason round-trips composite strings", () => {
    const parsed = parsePendingReason("large-cap+low-confidence");
    expect(parsed.has("large-cap")).toBe(true);
    expect(parsed.has("low-confidence")).toBe(true);
    expect(parsePendingReason(null).size).toBe(0);
    expect(parsePendingReason("garbage").size).toBe(0);
  });

  it("isExtremeMovePending detects composite reasons", () => {
    expect(isExtremeMovePending("extreme-move")).toBe(true);
    expect(isExtremeMovePending("extreme-move+large-cap")).toBe(true);
    expect(isExtremeMovePending("large-cap+low-confidence")).toBe(false);
    expect(isExtremeMovePending(null)).toBe(false);
  });
});

describe("normalizePendingDepegRow", () => {
  it("falls back cleanly for legacy rows without additive state columns", () => {
    const normalized = normalizePendingDepegRow({
      id: 1,
      stablecoin_id: "usdt-tether",
      symbol: "USDT",
      peg_type: "peggedUSD",
      direction: "below",
      first_seen_bps: -220,
      first_seen_at: 1_700_000_000,
      first_price: 0.978,
      last_seen_bps: null,
      last_seen_at: null,
      last_price: null,
      peak_seen_bps: null,
      peak_price: null,
      peg_reference: 1,
      reason: "large-cap",
      updated_at: null,
    });

    expect(normalized).toMatchObject({
      direction: "below",
      firstSeenBps: -220,
      firstSeenAt: 1_700_000_000,
      firstPrice: 0.978,
      lastSeenBps: -220,
      lastSeenAt: 1_700_000_000,
      lastPrice: 0.978,
      peakSeenBps: -220,
      peakPrice: 0.978,
    });
  });
});

describe("buildUpsertPendingDepegStmt", () => {
  function makePreparedStatementRecorder() {
    return {
      prepare(sql: string) {
        return {
          sql,
          bind(...boundValues: unknown[]) {
            return { sql, boundValues };
          },
        };
      },
    } as unknown as D1Database;
  }

  it("generates an upsert that refreshes same-direction incidents and resets opposite-direction ones", () => {
    const stmt = buildUpsertPendingDepegStmt(makePreparedStatementRecorder(), {
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      pegType: "peggedUSD",
      direction: "below",
      bps: -350,
      seenAt: 1_700_000_900,
      price: 0.965,
      pegReference: 1,
      reason: "large-cap",
    }) as unknown as { sql: string; boundValues: unknown[] };

    expect(stmt.sql).toContain("ON CONFLICT(stablecoin_id) DO UPDATE SET");
    expect(stmt.sql).toContain("WHEN depeg_pending.direction = excluded.direction THEN depeg_pending.first_seen_at");
    expect(stmt.sql).toContain("ELSE excluded.first_seen_at");
    expect(stmt.sql).toContain("last_seen_bps = excluded.last_seen_bps");
    expect(stmt.sql).toContain("peak_seen_bps = CASE");
    expect(stmt.sql).toContain("WHEN ABS(excluded.peak_seen_bps) > ABS(COALESCE(depeg_pending.peak_seen_bps, depeg_pending.first_seen_bps))");
    expect(stmt.sql).toContain("peg_reference = CASE");
    expect(stmt.boundValues).toEqual([
      "usdt-tether",
      "USDT",
      "peggedUSD",
      "below",
      -350,
      1_700_000_900,
      0.965,
      -350,
      1_700_000_900,
      0.965,
      -350,
      0.965,
      1,
      "large-cap",
      1_700_000_900,
    ]);
  });

  it("refreshes same-direction rows and resets opposite-direction rows when executed", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;

    const d1Recorder = makePreparedStatementRecorder();

    const firstStmt = buildUpsertPendingDepegStmt(d1Recorder, {
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      pegType: "peggedUSD",
      direction: "below",
      bps: -200,
      seenAt: 1_700_000_000,
      price: 0.98,
      pegReference: 1,
      reason: "large-cap",
    }) as unknown as { sql: string; boundValues: unknown[] };
    sqlite.prepare(firstStmt.sql).run(...(firstStmt.boundValues as never[]));

    const worsenStmt = buildUpsertPendingDepegStmt(d1Recorder, {
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      pegType: "peggedUSD",
      direction: "below",
      bps: -350,
      seenAt: 1_700_000_900,
      price: 0.965,
      pegReference: 1,
      reason: "large-cap",
    }) as unknown as { sql: string; boundValues: unknown[] };
    sqlite.prepare(worsenStmt.sql).run(...(worsenStmt.boundValues as never[]));

    const sameDirectionRow = sqlite
      .prepare("SELECT direction, first_seen_bps, first_seen_at, first_price, last_seen_bps, last_seen_at, last_price, peak_seen_bps, peak_price FROM depeg_pending WHERE stablecoin_id = ?")
      .get("usdt-tether") as Record<string, unknown>;

    expect(sameDirectionRow).toMatchObject({
      direction: "below",
      first_seen_bps: -200,
      first_seen_at: 1_700_000_000,
      first_price: 0.98,
      last_seen_bps: -350,
      last_seen_at: 1_700_000_900,
      last_price: 0.965,
      peak_seen_bps: -350,
      peak_price: 0.965,
    });

    const flipStmt = buildUpsertPendingDepegStmt(d1Recorder, {
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      pegType: "peggedUSD",
      direction: "above",
      bps: 180,
      seenAt: 1_700_001_200,
      price: 1.018,
      pegReference: 1,
      reason: "low-confidence",
    }) as unknown as { sql: string; boundValues: unknown[] };
    sqlite.prepare(flipStmt.sql).run(...(flipStmt.boundValues as never[]));

    const flippedRow = sqlite
      .prepare("SELECT direction, first_seen_bps, first_seen_at, first_price, last_seen_bps, last_seen_at, last_price, peak_seen_bps, peak_price, reason FROM depeg_pending WHERE stablecoin_id = ?")
      .get("usdt-tether") as Record<string, unknown>;

    expect(flippedRow).toMatchObject({
      direction: "above",
      first_seen_bps: 180,
      first_seen_at: 1_700_001_200,
      first_price: 1.018,
      last_seen_bps: 180,
      last_seen_at: 1_700_001_200,
      last_price: 1.018,
      peak_seen_bps: 180,
      peak_price: 1.018,
      reason: "low-confidence",
    });

    sqlite.close();
  });
});
