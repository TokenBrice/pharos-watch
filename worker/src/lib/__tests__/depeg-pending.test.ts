import { describe, expect, it } from "vitest";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import {
  buildUpsertPendingDepegStmt,
  normalizePendingDepegRow,
} from "../depeg-pending";
import {
  buildPendingReason,
  isExtremeMovePending,
  parsePendingReason,
} from "../depeg-helpers";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

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
    return makeNoopD1({
      prepare(sql: string) {
        return {
          sql,
          bind(...boundValues: unknown[]) {
            return { sql, boundValues };
          },
        };
      },
    });
  }

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

    // Anchored to the tolerance: two observations inside it must preserve
    // first_seen_at, and one observation past it must reset the episode.
    const tol = DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC;
    const withinA = 1_700_000_900 + tol - 1;
    const withinB = withinA + tol;
    const afterGapAt = withinB + tol + 1;
    for (const seenAt of [withinA, withinB]) {
      sqlite.prepare(worsenStmt.sql).run(
        "usdt-tether", "USDT", "peggedUSD", "below", -300, seenAt, 0.97,
        -300, seenAt, 0.97, -300, 0.97, 1, "large-cap", seenAt,
      );
    }
    const withinTolerance = sqlite
      .prepare("SELECT first_seen_at, last_seen_at FROM depeg_pending WHERE stablecoin_id = ?")
      .get("usdt-tether") as { first_seen_at: number; last_seen_at: number };
    expect(withinTolerance).toEqual({
      first_seen_at: 1_700_000_000,
      last_seen_at: withinB,
    });

    sqlite.prepare(worsenStmt.sql).run(
      "usdt-tether", "USDT", "peggedUSD", "below", -280, afterGapAt, 0.972,
      -280, afterGapAt, 0.972, -280, 0.972, 1, "large-cap", afterGapAt,
    );
    const afterGap = sqlite
      .prepare("SELECT first_seen_at, last_seen_at, peak_seen_bps FROM depeg_pending WHERE stablecoin_id = ?")
      .get("usdt-tether") as { first_seen_at: number; last_seen_at: number; peak_seen_bps: number };
    expect(afterGap).toEqual({
      first_seen_at: afterGapAt,
      last_seen_at: afterGapAt,
      peak_seen_bps: -280,
    });

    const flipStmt = buildUpsertPendingDepegStmt(d1Recorder, {
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      pegType: "peggedUSD",
      direction: "above",
      bps: 180,
      seenAt: 1_700_003_900,
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
      first_seen_at: 1_700_003_900,
      first_price: 1.018,
      last_seen_bps: 180,
      last_seen_at: 1_700_003_900,
      last_price: 1.018,
      peak_seen_bps: 180,
      peak_price: 1.018,
      reason: "low-confidence",
    });

    sqlite.close();
  });

  it("resets same-direction candidates when their quote domain changes in either direction", () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const recorder = makePreparedStatementRecorder();
    const observations = [
      { price: 0.0125104, pegReference: 0.012274, bps: 193, reason: "confirmation-window" },
      { price: 1.01847, pegReference: 1, bps: 185, reason: "confirmation-window+native-origin" },
      { price: 0.01252, pegReference: 0.012274, bps: 200, reason: "confirmation-window" },
    ];
    try {
      for (const [index, observation] of observations.entries()) {
        const seenAt = 1_700_000_000 + index * 900;
        const stmt = buildUpsertPendingDepegStmt(recorder, {
          stablecoinId: "a7a5-old-vector",
          symbol: "A7A5",
          pegType: "peggedRUB",
          direction: "above",
          seenAt,
          ...observation,
        }) as unknown as { sql: string; boundValues: unknown[] };
        sqlite.prepare(stmt.sql).run(...(stmt.boundValues as never[]));
        expect(sqlite.prepare("SELECT * FROM depeg_pending WHERE stablecoin_id = ?").get("a7a5-old-vector"))
          .toMatchObject({
            first_seen_at: seenAt,
            first_seen_bps: observation.bps,
            first_price: observation.price,
            last_price: observation.price,
            peak_seen_bps: observation.bps,
            peak_price: observation.price,
            peg_reference: observation.pegReference,
            reason: observation.reason,
          });
      }
    } finally {
      sqlite.close();
    }
  });
});
