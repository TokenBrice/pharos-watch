import { describe, expect, it, vi } from "vitest";
import {
  collectDexProtocolCorroborations,
  createDexPriceSourceLoadTelemetry,
  loadDexPrices,
  rowPriceCoverage,
  serializeDepegPriceCoverage,
  rowToDepegEvent,
  type DepegRow,
} from "../depeg-helpers";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { getDexAggregateRejectionReason, isAffirmativeDexPriceRow } from "../depeg-trust-policy";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { buildUpsertPendingDepegStmt, normalizePendingDepegRow, type PendingDepegUpsertParams } from "../depeg-pending";
import { isExtremeMovePending, parsePendingReason } from "../depeg-helpers";
import { computePegScore } from "@shared/lib/peg-score";
import { mergeDepegSeconds, mergeUnknownDepegSeconds } from "@shared/lib/peg-utils";

describe("buildInsertDepegEventStmt + rowToDepegEvent provenance", () => {
  const baseDepegRow = {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below",
    peak_deviation_bps: -120,
    started_at: 100,
    ended_at: null,
    start_price: 0.988,
    peak_price: 0.985,
    recovery_price: null,
    peg_reference: 1,
    source: "live",
    close_reason: null,
    confirmation_sources: null,
    pending_reason: null,
  } satisfies DepegRow;

  it.each(["invalid-json", '{"intervals":[[200,100]]}', "null"])("treats malformed stored coverage as unknown: %s", (malformed) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = [
        { ...baseDepegRow, price_coverage_json: malformed },
        { ...baseDepegRow, id: 2, price_coverage_json: '{"intervals":[[100,200]]}', last_trusted_price_at: 200 },
      ].map(rowToDepegEvent);
      expect(events[0]!.priceCoverage).toMatchObject({
        intervals: [], atParIntervals: [], lastTrustedObservationAt: null, gapStartedAt: null,
      });
      expect(events[1]!.priceCoverage?.intervals).toEqual([[100, 200]]);
      expect(rowPriceCoverage({ ...baseDepegRow, price_coverage_json: malformed })).toBeNull();
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line))).some((record) =>
        record.level === "warn" && record.metadata?.eventId === 1,
      )).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  // docs/depeg-detection.md: malformed stored coverage becomes unknown; only
  // closed legacy/replay rows without a coverage column retain their recorded
  // duration. Crediting an unread instrumented episode as observed off-peg time
  // turns a failed read into a positive occupancy claim (R2).
  it("keeps a closed instrumented row's unreadable coverage unknown instead of crediting its duration", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const startedAt = 1_790_000_000;
    const endedAt = startedAt + 48 * 3600;
    const row: DepegRow = {
      ...baseDepegRow,
      id: 7,
      started_at: startedAt,
      ended_at: endedAt,
      price_coverage_json: JSON.stringify({ intervals: [[startedAt, endedAt]] }),
      last_trusted_price_at: startedAt + 2 * 3600,
    };
    try {
      const event = rowToDepegEvent(row);
      expect(mergeDepegSeconds([event], startedAt, endedAt)).toBe(0);
      expect(mergeUnknownDepegSeconds([event], startedAt, endedAt)).toBe(endedAt - startedAt);
      expect(computePegScore([event], startedAt, endedAt).pegPct).toBeNull();

      const legacy = rowToDepegEvent({
        ...row, id: 8, price_coverage_json: null, last_trusted_price_at: null,
      });
      expect(mergeDepegSeconds([legacy], startedAt, endedAt)).toBe(endedAt - startedAt);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects invalid producer coverage on the write path", () => {
    expect(() => serializeDepegPriceCoverage({
      intervals: [[200, 100]], lastTrustedObservationAt: 200, gapStartedAt: null,
    })).toThrow();
  });

  it("rowToDepegEvent exposes confirmation_sources and pending_reason (null-safe)", () => {
    const event = rowToDepegEvent({
      ...baseDepegRow,
      confirmation_sources: "Pool", pending_reason: "large-cap+low-confidence",
    });
    expect(event.confirmationSources).toBe("Pool");
    expect(event.pendingReason).toBe("large-cap+low-confidence");
    expect(event.closeReason).toBeNull();

    const legacy = rowToDepegEvent({
      ...baseDepegRow,
      id: 2,
      close_reason: undefined,
    });
    expect(legacy.confirmationSources).toBeNull();
    expect(legacy.pendingReason).toBeNull();
    expect(legacy.closeReason).toBeNull();
  });

  it("rowToDepegEvent exposes validated close_reason values", () => {
    const event = rowToDepegEvent({
      ...baseDepegRow,
      ended_at: 200,
      recovery_price: 1,
      close_reason: "recovered-primary",
    });
    expect(event.closeReason).toBe("recovered-primary");
  });

  it("rejects invalid stored direction values instead of coercing them", () => {
    expect(() => rowToDepegEvent({ ...baseDepegRow, direction: "sideways" })).toThrow(
      '[depeg-helpers] Invalid direction "sideways" for event 1',
    );
  });

  it("rejects invalid stored source values instead of coercing them", () => {
    expect(() => rowToDepegEvent({ ...baseDepegRow, source: "manual" })).toThrow(
      '[depeg-helpers] Invalid source "manual" for event 1',
    );
  });

  it("rejects invalid stored close_reason values instead of coercing them", () => {
    expect(() => rowToDepegEvent({ ...baseDepegRow, close_reason: "unknown" })).toThrow(
      '[depeg-helpers] Invalid close_reason "unknown" for event 1',
    );
  });
});

describe("collectDexProtocolCorroborations", () => {
  it("counts DEX corroboration by source family instead of protocol labels", () => {
    const groups = collectDexProtocolCorroborations(
      [
        { protocol: "curve", chain: "ethereum", price: 0.96, tvl: 2_000_000, updatedAt: 1, sourceFamily: "poisoned-provider" },
        { protocol: "uniswap", chain: "ethereum", price: 0.955, tvl: 2_000_000, updatedAt: 1, sourceFamily: "poisoned-provider" },
        { protocol: "balancer", chain: "ethereum", price: 0.958, tvl: 2_000_000, updatedAt: 1, sourceFamily: "independent-provider" },
      ],
      1,
      200,
      "below",
      "confirm",
    );

    expect(groups.map((group) => group.key).sort()).toEqual(["independent-provider", "poisoned-provider"]);
  });

  it("admits recovery groups at the documented raw recovery-band boundary", () => {
    // 0.99503 is 49.70 raw bps below peg: inside the 50 bps recovery band even
    // though its rounded deviation is -50 bps.
    const groups = collectDexProtocolCorroborations(
      ["curve", "uniswap-v3"].map((sourceFamily) => ({
        protocol: sourceFamily, chain: "ethereum", sourceFamily, price: 0.99503, tvl: 2_500_000, updatedAt: 1,
      })),
      1,
      50,
      "below",
      "recover",
    );

    expect(groups.map((group) => group.key).sort()).toEqual(["curve", "uniswap-v3"]);
  });

  it("does not treat source-family-free legacy protocol rows as independent", () => {
    const groups = collectDexProtocolCorroborations(
      [
        { protocol: "curve", chain: "ethereum", price: 0.96, tvl: 2_000_000, updatedAt: 1 },
        { protocol: "uniswap", chain: "ethereum", price: 0.955, tvl: 2_000_000, updatedAt: 1 },
      ],
      1,
      200,
      "below",
      "confirm",
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("unknown");
  });
});

describe("original DEX source observation admission", () => {
  const now = 1_700_000_000;
  const database = (row: Record<string, unknown>) =>
    makeNoopD1({ prepare: () => ({ all: async () => ({ results: [row] }) }) });
  it.each([[null, "aggregate-clock-unavailable"], [0, "aggregate-clock-invalid"],
    [now + 30, "aggregate-clock-future"]] as const)("preserves rejection reason for aggregate clock %s", async (clock, reason) => {
    for (const payload of [[{ aggregateObservedAt: clock }], { aggregateObservedAt: clock, sources: [] }]) {
      const loaded = await loadDexPrices(database({
        stablecoin_id: "usdt-tether", updated_at: now, source_total_tvl: 4_000_000, dex_price_usd: 1,
        price_sources_json: JSON.stringify(payload),
      }), now);
      const row = loaded.dexPriceRows.get("usdt-tether")!;
      expect(row).toMatchObject({ aggregateObservedAt: null, aggregateClockReason: reason });
      expect(getDexAggregateRejectionReason(row, now, "depeg")).toBe(reason);
      expect(isAffirmativeDexPriceRow(row, now, "depeg")).toBe(false);
      expect(loaded.dexPriceSources.size).toBe(0);
    }
  });
  it.each(["confirm", "recover"] as const)("admits %s groups using their original clock, never a compatibility clock", async (mode) => {
    const observedAt = now - 60;
    const price = mode === "confirm" ? 0.98 : 1;
    const sources = ["curve", "uniswap"].map((protocol) => ({
      protocol, sourceFamily: protocol, chain: "ethereum", price, tvl: 2_000_000,
      observedAt, aggregateObservedAt: observedAt, updatedAt: now + 100,
    }));
    const db = database({
      stablecoin_id: "usdt-tether", dex_price_usd: price, source_total_tvl: 4_000_000,
      source_pool_count: 2, deviation_from_primary_bps: 0, updated_at: now,
      price_sources_json: JSON.stringify(sources),
    });
    const loaded = await loadDexPrices(db, now);
    const admitted = loaded.dexPriceSources.get("usdt-tether");
    expect(admitted?.map((source) => source.updatedAt)).toEqual([observedAt, observedAt]);
    expect(collectDexProtocolCorroborations(admitted, 1, 100, "below", mode)).toHaveLength(2);
  });
  it.each(["confirm", "recover"] as const)("admits %s at original-clock boundaries despite an expired run-start row", async (mode) => {
    const observedAt = now - 35 * 60;
    const aggregateObservedAt = now - 75 * 60;
    const price = mode === "confirm" ? 0.98 : 1;
    const sources = ["curve", "uniswap"].map((protocol) => ({
      protocol, sourceFamily: protocol, chain: "ethereum", price, tvl: 2_000_000,
      observedAt, aggregateObservedAt, updatedAt: now,
    }));
    const db = database({
      stablecoin_id: "usdt-tether", dex_price_usd: price, source_total_tvl: 4_000_000,
      source_pool_count: 2, deviation_from_primary_bps: 0, updated_at: observedAt - 1,
      price_sources_json: JSON.stringify(sources),
    });
    const telemetry = { staleRows: [], malformedRows: [] };
    const loaded = await loadDexPrices(db, now, 35 * 60, telemetry);
    expect(telemetry.staleRows).toEqual([{ stablecoinId: "usdt-tether", updatedAt: observedAt - 1,
      ageSec: 35 * 60 + 1, maxAgeSec: 35 * 60 }]);
    expect(collectDexProtocolCorroborations(loaded.dexPriceSources.get("usdt-tether"), 1, 100, "below", mode)).toHaveLength(2);
    expect(loaded.dexPriceRows.get("usdt-tether")?.updated_at).toBe(observedAt - 1);
    expect(loaded.dexPriceRows.get("usdt-tether")?.aggregateObservedAt).toBe(aggregateObservedAt);
  });
  it.each([60, 21_600, null])("retains aggregate clock %s without surviving protocol lanes", async (age) => {
    const clock = age == null ? null : now - age;
    const db = database({
      stablecoin_id: "usdt-tether", updated_at: now, dex_price_usd: 1,
      price_sources_json: JSON.stringify([0, 1].map((i) => ({
        observedAt: now - 21_600, aggregateObservedAt: clock == null ? undefined : clock + i,
      }))),
    });
    const loaded = await loadDexPrices(db, now);
    expect(loaded.dexPriceRows.get("usdt-tether")?.aggregateObservedAt).toBe(clock);
    expect(loaded.dexPriceSources.size).toBe(0);
  });
});

describe("DEX source element admission", () => {
  it("quarantines a source list with a null element and still loads other assets", async () => {
    const now = 1_700_000_000;
    const observedAt = now - 30;
    const validSources = ["curve", "uniswap"].map((protocol) => ({
      protocol, chain: "ethereum", price: 1, tvl: 2_000_000, observedAt, aggregateObservedAt: observedAt,
    }));
    const row = (stablecoinId: string, priceSourcesJson: string) => ({
      stablecoin_id: stablecoinId, dex_price_usd: 1, source_total_tvl: 4_000_000,
      source_pool_count: 2, deviation_from_primary_bps: 0, updated_at: now,
      price_sources_json: priceSourcesJson,
    });
    const db = makeNoopD1({ prepare: () => ({ all: async () => ({ results: [
      row("usdt-tether", "[null]"),
      row("usdc-circle", JSON.stringify(validSources)),
    ] }) }) });
    const telemetry = createDexPriceSourceLoadTelemetry();

    const loaded = await loadDexPrices(db, now, 35 * 60, telemetry);

    expect([...loaded.dexPriceRows.keys()].sort()).toEqual(["usdc-circle", "usdt-tether"]);
    expect(loaded.dexPriceSources.get("usdt-tether")).toBeUndefined();
    expect(loaded.dexPriceSources.get("usdc-circle")).toHaveLength(2);
    expect(telemetry.malformedRows).toEqual([
      { stablecoinId: "usdt-tether", updatedAt: now, reason: "invalid-shape" },
    ]);
  });
});

describe("pending reason helpers", () => {
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
  const makePreparedStatementRecorder = () => makeNoopD1({
    prepare: (sql: string) => ({
      sql,
      bind: (...boundValues: unknown[]) => ({ sql, boundValues }),
    }),
  });

  it("refreshes same-direction rows and resets opposite-direction rows when executed", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;

    const d1Recorder = makePreparedStatementRecorder();

    const upsert = (overrides: Partial<PendingDepegUpsertParams>) => {
      const stmt = buildUpsertPendingDepegStmt(d1Recorder, {
        stablecoinId: "usdt-tether", symbol: "USDT", pegType: "peggedUSD",
        direction: "below", bps: -200, seenAt: 1_700_000_000, price: 0.98,
        pegReference: 1, reason: "large-cap", ...overrides,
      }) as unknown as { sql: string; boundValues: unknown[] };
      sqlite.prepare(stmt.sql).run(...(stmt.boundValues as never[]));
      return stmt;
    };
    upsert({});
    const worsenStmt = upsert({ bps: -350, seenAt: 1_700_000_900, price: 0.965 });

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

    upsert({ direction: "above", bps: 180, seenAt: 1_700_003_900, price: 1.018, reason: "low-confidence" });

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
  it("resets native candidates when their fiat currency identity changes", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const initial = {
        stablecoinId: "changing-peg", symbol: "PEG", pegType: "peggedREAL",
        direction: "below" as const, bps: -500, seenAt: 1_700_000_000,
        price: 0.95, pegReference: 1, reason: "confirmation-window+native-origin",
      };
      await buildUpsertPendingDepegStmt(db, initial).run();
      await buildUpsertPendingDepegStmt(db, {
        ...initial, pegType: "peggedEUR", bps: -200, price: 0.98, seenAt: initial.seenAt + 900,
      }).run();
      expect(sqlite.prepare("SELECT peg_type, first_seen_at, first_price, peak_seen_bps, peak_price FROM depeg_pending").get())
        .toEqual({ peg_type: "peggedEUR", first_seen_at: initial.seenAt + 900, first_price: 0.98, peak_seen_bps: -200, peak_price: 0.98 });
    } finally {
      sqlite.close();
    }
  });
});
