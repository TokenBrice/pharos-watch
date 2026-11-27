import { describe, expect, it, vi } from "vitest";
import {
  buildInsertDepegEventStmt,
  collectDexProtocolCorroborations,
  createDexPriceSourceLoadTelemetry,
  loadDexPrices,
  rowPriceCoverage,
  serializeDepegPriceCoverage,
  rowToDepegEvent,
  type DepegRow,
} from "../depeg-helpers";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { getDexAggregateRejectionReason, isAffirmativeDexPriceRow, isTrustedDexPriceRow } from "../depeg-trust-policy";
import { DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { makeClockedCurveNavPayload } from "../../api/__tests__/p4-route-response.test-support";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { buildUpsertPendingDepegStmt, normalizePendingDepegRow, type PendingDepegRow, type PendingDepegUpsertParams } from "../depeg-pending";
import { isExtremeMovePending, parsePendingReason } from "../depeg-helpers";
import { computePegScore } from "@shared/lib/peg-score";
import { mergeDepegSeconds, mergeUnknownDepegSeconds } from "@shared/lib/peg-utils";

describe("buildInsertDepegEventStmt + rowToDepegEvent provenance", () => {
  const baseDepegRow = {
    id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD", direction: "below",
    peak_deviation_bps: -120, started_at: 100, ended_at: null, start_price: 0.988, peak_price: 0.985,
    recovery_price: null, peg_reference: 1, source: "live", close_reason: null, confirmation_sources: null, pending_reason: null,
  } satisfies DepegRow;

  it.each(["invalid-json", '{"intervals":[[200,100]]}', "null"])("treats malformed stored coverage as unknown: %s", (malformed) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = [
        { ...baseDepegRow, price_coverage_json: malformed },
        { ...baseDepegRow, id: 2, price_coverage_json: '{"intervals":[[100,200]]}', last_trusted_price_at: 200 },
      ].map(rowToDepegEvent);
      expect(events[0]!.priceCoverage).toMatchObject({ intervals: [], atParIntervals: [], lastTrustedObservationAt: null, gapStartedAt: null });
      expect(events[1]!.priceCoverage?.intervals).toEqual([[100, 200]]);
      expect(rowPriceCoverage({ ...baseDepegRow, price_coverage_json: malformed })).toBeNull();
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line))).some((r) => r.level === "warn" && r.metadata?.eventId === 1)).toBe(true);
    } finally { warn.mockRestore(); }
  });

  // Malformed stored coverage becomes unknown; only closed legacy rows without coverage retain recorded duration (R2).
  it("keeps a closed instrumented row's unreadable coverage unknown instead of crediting its duration", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const startedAt = 1_790_000_000, endedAt = startedAt + 48 * 3600;
    const row: DepegRow = { ...baseDepegRow, id: 7, started_at: startedAt, ended_at: endedAt, price_coverage_json: JSON.stringify({ intervals: [[startedAt, endedAt]] }), last_trusted_price_at: startedAt + 2 * 3600 };
    try {
      const event = rowToDepegEvent(row);
      expect(mergeDepegSeconds([event], startedAt, endedAt)).toBe(0);
      expect(mergeUnknownDepegSeconds([event], startedAt, endedAt)).toBe(endedAt - startedAt);
      expect(computePegScore([event], startedAt, endedAt).pegPct).toBeNull();
      const legacy = rowToDepegEvent({ ...row, id: 8, price_coverage_json: null, last_trusted_price_at: null });
      expect(mergeDepegSeconds([legacy], startedAt, endedAt)).toBe(endedAt - startedAt);
    } finally { warn.mockRestore(); }
  });

  it("keeps absent, empty and invalid admitted coverage distinct from inferred legacy duration", () => {
    const row = { ...baseDepegRow, ended_at: 300, peak_price: 0.988, peak_peg_reference: 1, peak_quote_domain: "usd" as const, recovery_price: 1.005, recovery_peg_reference: 1.004 };
    expect(rowToDepegEvent(row)).not.toHaveProperty("admittedCoverage");
    expect(rowToDepegEvent({ ...row, admitted_coverage_json: '[{"fromSec":104,"toSec":150}]', disposition: "admitted-coverage" }))
      .toMatchObject({ peakQuoteDomain: "usd", peakPegReference: 1, recoveryPegReference: 1.004, admittedCoverage: [{ fromSec: 104, toSec: 150 }], disposition: "admitted-coverage" });
    for (const json of ["[]", '[{"fromSec":90,"toSec":110}]', '[{"fromSec":303,"toSec":301}]']) {
      expect(rowToDepegEvent({ ...row, admitted_coverage_json: json }).admittedCoverage).toEqual([]);
    }
    expect(rowToDepegEvent({ ...row, disposition: "admitted-coverage" }).admittedCoverage).toEqual([]);
    expect(rowToDepegEvent({ ...row, disposition: "unrecognized" }).admittedCoverage).toEqual([]);
  });

  it("rejects invalid producer coverage on the write path", () => {
    expect(() => serializeDepegPriceCoverage({ intervals: [[200, 100]], lastTrustedObservationAt: 200, gapStartedAt: null })).toThrow();
  });

  it("rowToDepegEvent exposes confirmation_sources and pending_reason (null-safe)", () => {
    const event = rowToDepegEvent({ ...baseDepegRow, confirmation_sources: "Pool", pending_reason: "large-cap+low-confidence" });
    expect(event.confirmationSources).toBe("Pool");
    expect(event.pendingReason).toBe("large-cap+low-confidence");
    expect(event.closeReason).toBeNull();
    const legacy = rowToDepegEvent({ ...baseDepegRow, id: 2, close_reason: undefined });
    expect(legacy.confirmationSources).toBeNull();
    expect(legacy.pendingReason).toBeNull();
    expect(legacy.closeReason).toBeNull();
  });

  it("rowToDepegEvent exposes validated close_reason values", () => {
    const event = rowToDepegEvent({ ...baseDepegRow, ended_at: 200, recovery_price: 1, close_reason: "recovered-primary" });
    expect(event.closeReason).toBe("recovered-primary");
  });

  it.each([["direction", "sideways"], ["source", "manual"], ["close_reason", "unknown"]])("rejects invalid stored %s values instead of coercing them", (field, value) => {
    expect(() => rowToDepegEvent({ ...baseDepegRow, [field]: value })).toThrow(`[depeg-helpers] Invalid ${field} "${value}" for event 1`);
  });

  it("keeps rowToDepegEvent free of escalation columns while buildInsertDepegEventStmt persists optional carry-forward", async () => {
    const event = rowToDepegEvent({ ...baseDepegRow, peak_escalated_at: 1_700_000_500, peak_escalation_anchor_bps: 450, peak_escalation_candidate_at: 1_700_000_900, peak_escalation_candidate_seen_at: 1_700_000_900 });
    for (const k of ["peakEscalatedAt", "peakEscalationAnchorBps", "peakEscalationCandidateAt", "peakEscalationCandidateSeenAt"]) expect(event).not.toHaveProperty(k);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      await buildInsertDepegEventStmt(db, { ...event, startedAt: 1_700_000_000 }).run();
      await buildInsertDepegEventStmt(db, { ...event, stablecoinId: "usdc-circle", symbol: "USDC", startedAt: 1_700_000_100 }, null, { peakEscalatedAt: 1_700_000_050, peakEscalationAnchorBps: 520 }).run();
      expect(sqlite.prepare("SELECT stablecoin_id, peak_escalated_at, peak_escalation_anchor_bps, peak_escalation_candidate_at FROM depeg_events ORDER BY id").all()).toEqual([
        { stablecoin_id: "usdt-tether", peak_escalated_at: null, peak_escalation_anchor_bps: null, peak_escalation_candidate_at: null },
        { stablecoin_id: "usdc-circle", peak_escalated_at: 1_700_000_050, peak_escalation_anchor_bps: 520, peak_escalation_candidate_at: null },
      ]);
    } finally { sqlite.close(); }
  });
});

describe("collectDexProtocolCorroborations", () => {
  const src = (protocol: string, price: number, extra: Record<string, unknown> = {}) => ({ protocol, chain: "ethereum", price, tvl: 2_000_000, updatedAt: 1, ...extra });

  it("counts DEX corroboration by source family instead of protocol labels", () => {
    const groups = collectDexProtocolCorroborations([src("curve", 0.96, { sourceFamily: "poisoned-provider" }), src("uniswap", 0.955, { sourceFamily: "poisoned-provider" }), src("balancer", 0.958, { sourceFamily: "independent-provider" })], 1, 200, "below", "confirm");
    expect(groups.map((g) => g.key).sort()).toEqual(["independent-provider", "poisoned-provider"]);
  });

  it("counts two families sharing a price-forming pool once, retaining the deeper raw price", () => {
    const pool = "ethereum:0x0000000000000000000000000000000000000001";
    const sources = ["curve", "uniswap"].map((sourceFamily, i) => src(sourceFamily, i ? 0.97996 : 0.97999, { sourceFamily, pricePoolKeys: [pool] }));
    expect(collectDexProtocolCorroborations(sources, 1, 100, "below", "confirm").map((item) => item.source.price)).toEqual([0.97996]);
  });

  it("admits recovery groups at the documented raw recovery-band boundary", () => {
    const groups = collectDexProtocolCorroborations(["curve", "uniswap-v3"].map((sourceFamily) => src(sourceFamily, 0.99503, { sourceFamily, tvl: 2_500_000 })), 1, 50, "below", "recover");
    expect(groups.map((g) => g.key).sort()).toEqual(["curve", "uniswap-v3"]);
  });

  it("does not treat source-family-free legacy protocol rows as independent", () => {
    const groups = collectDexProtocolCorroborations([src("curve", 0.96), src("uniswap", 0.955)], 1, 200, "below", "confirm");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("unknown");
  });
});

describe("original DEX source observation admission", () => {
  const now = 1_700_000_000;
  const database = (row: Record<string, unknown>) => makeNoopD1({ prepare: () => ({ all: async () => ({ results: [row] }) }) });
  const dexRow = (overrides: Record<string, unknown>) => ({ stablecoin_id: "usdt-tether", updated_at: now, source_total_tvl: 4_000_000, dex_price_usd: 1, ...overrides });

  it.each([[null, "aggregate-clock-unavailable"], [0, "aggregate-clock-invalid"], [now + 30, "aggregate-clock-future"]] as const)("preserves rejection reason for aggregate clock %s", async (clock, reason) => {
    for (const payload of [[{ aggregateObservedAt: clock }], { aggregateObservedAt: clock, sources: [] }]) {
      const loaded = await loadDexPrices(database(dexRow({ price_sources_json: JSON.stringify(payload) })), now);
      const row = loaded.dexPriceRows.get("usdt-tether")!;
      expect(row).toMatchObject({ aggregateObservedAt: null, aggregateClockReason: reason });
      expect(getDexAggregateRejectionReason(row, now, "depeg")).toBe(reason);
      expect(isAffirmativeDexPriceRow(row, now, "depeg")).toBe(false);
      expect(loaded.dexPriceSources.size).toBe(0);
    }
  });
  it("preserves clocked Curve NAV pricePayload in loadDexPrices so veto lanes reject stale-mark rows at >=4500s", async () => {
    const stalePayload = makeClockedCurveNavPayload({ poolRatioObservedAt: now - 120, quoteMarkObservedAt: now - DEX_FRESHNESS_SEC, captureEvaluatedAtSec: now - 60, quotePublishedAtSec: now - 60 });
    const loaded = await loadDexPrices(database(dexRow({ stablecoin_id: "stusds-sky", updated_at: now - 60, source_total_tvl: 2_500_000, dex_price_usd: 1.07, price_sources_json: JSON.stringify(stalePayload) })), now);
    const row = loaded.dexPriceRows.get("stusds-sky")!;
    expect(row.pricePayload).toBeDefined();
    expect(isTrustedDexPriceRow(row, now, "depeg")).toBe(false);
    expect(isAffirmativeDexPriceRow(row, now, "depeg")).toBe(false);
    expect(getDexAggregateRejectionReason(row, now, "depeg")).toBe("aggregate-clock-stale");
    expect(loaded.dexPriceSources.has("stusds-sky")).toBe(false);
  });
  it.each(["confirm", "recover"] as const)("admits %s groups using their original clock, never a compatibility clock", async (mode) => {
    const observedAt = now - 60, price = mode === "confirm" ? 0.98 : 1;
    const sources = ["curve", "uniswap"].map((protocol) => ({ protocol, sourceFamily: protocol, chain: "ethereum", price, tvl: 2_000_000, observedAt, aggregateObservedAt: observedAt, updatedAt: now + 100 }));
    const loaded = await loadDexPrices(database(dexRow({ dex_price_usd: price, source_pool_count: 2, deviation_from_primary_bps: 0, price_sources_json: JSON.stringify(sources) })), now);
    const admitted = loaded.dexPriceSources.get("usdt-tether");
    expect(admitted?.map((s) => s.updatedAt)).toEqual([observedAt, observedAt]);
    expect(collectDexProtocolCorroborations(admitted, 1, 100, "below", mode)).toHaveLength(2);
  });
  it.each(["confirm", "recover"] as const)("admits %s at original-clock boundaries despite an expired run-start row", async (mode) => {
    const observedAt = now - 35 * 60, aggregateObservedAt = now - 75 * 60, price = mode === "confirm" ? 0.98 : 1;
    const sources = ["curve", "uniswap"].map((protocol) => ({ protocol, sourceFamily: protocol, chain: "ethereum", price, tvl: 2_000_000, observedAt, aggregateObservedAt, updatedAt: now }));
    const telemetry = { staleRows: [], malformedRows: [] };
    const loaded = await loadDexPrices(database(dexRow({ dex_price_usd: price, source_pool_count: 2, deviation_from_primary_bps: 0, updated_at: observedAt - 1, price_sources_json: JSON.stringify(sources) })), now, 35 * 60, telemetry);
    expect(telemetry.staleRows).toEqual([{ stablecoinId: "usdt-tether", updatedAt: observedAt - 1, ageSec: 35 * 60 + 1, maxAgeSec: 35 * 60 }]);
    expect(collectDexProtocolCorroborations(loaded.dexPriceSources.get("usdt-tether"), 1, 100, "below", mode)).toHaveLength(2);
    expect(loaded.dexPriceRows.get("usdt-tether")?.updated_at).toBe(observedAt - 1);
    expect(loaded.dexPriceRows.get("usdt-tether")?.aggregateObservedAt).toBe(aggregateObservedAt);
  });
  it.each([60, 21_600, null])("retains aggregate clock %s without surviving protocol lanes", async (age) => {
    const clock = age == null ? null : now - age;
    const loaded = await loadDexPrices(database(dexRow({ price_sources_json: JSON.stringify([0, 1].map((i) => ({ observedAt: now - 21_600, aggregateObservedAt: clock == null ? undefined : clock + i }))) })), now);
    expect(loaded.dexPriceRows.get("usdt-tether")?.aggregateObservedAt).toBe(clock);
    expect(loaded.dexPriceSources.size).toBe(0);
  });
});

describe("DEX source element admission", () => {
  it("quarantines a source list with a null element and still loads other assets", async () => {
    const now = 1_700_000_000, observedAt = now - 30;
    const validSources = ["curve", "uniswap"].map((protocol) => ({ protocol, chain: "ethereum", price: 1, tvl: 2_000_000, observedAt, aggregateObservedAt: observedAt }));
    const row = (stablecoin_id: string, price_sources_json: string) => ({ stablecoin_id, dex_price_usd: 1, source_total_tvl: 4_000_000, source_pool_count: 2, deviation_from_primary_bps: 0, updated_at: now, price_sources_json });
    const db = makeNoopD1({ prepare: () => ({ all: async () => ({ results: [row("usdt-tether", "[null]"), row("usdc-circle", JSON.stringify(validSources))] }) }) });
    const telemetry = createDexPriceSourceLoadTelemetry();
    const loaded = await loadDexPrices(db, now, 35 * 60, telemetry);
    expect([...loaded.dexPriceRows.keys()].sort()).toEqual(["usdc-circle", "usdt-tether"]);
    expect(loaded.dexPriceSources.get("usdt-tether")).toBeUndefined();
    expect(loaded.dexPriceSources.get("usdc-circle")).toHaveLength(2);
    expect(telemetry.malformedRows).toEqual([{ stablecoinId: "usdt-tether", updatedAt: now, reason: "invalid-shape" }]);
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
      id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD", direction: "below",
      first_seen_bps: -220, first_seen_at: 1_700_000_000, first_price: 0.978,
      last_seen_bps: null, last_seen_at: null, last_price: null, peak_seen_bps: null, peak_price: null,
      peg_reference: 1, reason: "large-cap", updated_at: null,
    });
    expect(normalized).toMatchObject({ direction: "below", firstSeenBps: -220, firstSeenAt: 1_700_000_000, firstPrice: 0.978, lastSeenBps: -220, lastSeenAt: 1_700_000_000, lastPrice: 0.978, peakSeenBps: -220, peakPrice: 0.978 });
  });
});

describe("buildUpsertPendingDepegStmt", () => {
  it("withholds a pending peak reference after an old writer changes the price and FX basis", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    await buildUpsertPendingDepegStmt(db, { stablecoinId: "eurc-circle", symbol: "EURC", pegType: "peggedEUR", direction: "below", bps: -200, seenAt: 1_700_000_000, price: 1.078, pegReference: 1.10, reason: "confirmation-window" }).run();
    const read = () => normalizePendingDepegRow(sqlite.prepare("SELECT * FROM depeg_pending").get() as unknown as PendingDepegRow);
    expect(read().peakPegReference).toBe(1.10);
    sqlite.prepare("UPDATE depeg_pending SET peak_price = ?, peak_seen_bps = -400").run(1.12 * 0.96);
    expect(read().peakPegReference).toBeNull();
    sqlite.close();
  });

  it("refreshes same-direction rows and resets opposite-direction rows when executed", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const upsert = async (overrides: Partial<PendingDepegUpsertParams>) => {
      await buildUpsertPendingDepegStmt(db, { stablecoinId: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", direction: "below", bps: -200, seenAt: 1_700_000_000, price: 0.98, pegReference: 1, reason: "large-cap", ...overrides }).run();
    };
    await upsert({ rawBps: -200.00000000000017 });
    await upsert({ bps: -350, rawBps: -350.01, seenAt: 1_700_000_899, price: 0.964999 });
    sqlite.exec("UPDATE depeg_pending SET first_seen_bps = -200.5, last_seen_bps = -350.01, peak_seen_bps = -350.01");
    expect(normalizePendingDepegRow(sqlite.prepare("SELECT * FROM depeg_pending").get() as unknown as PendingDepegRow)).toMatchObject({ firstSeenBps: -200, lastSeenBps: -350, peakSeenBps: -350 });
    await upsert({ bps: -350, rawBps: -350.02, seenAt: 1_700_000_900, price: 0.964998 });
    expect(sqlite.prepare("SELECT * FROM depeg_pending").get()).toMatchObject({ direction: "below", first_seen_bps: -200, first_seen_at: 1_700_000_000, first_price: 0.98, last_seen_bps: -350, last_seen_at: 1_700_000_900, last_price: 0.964998, peak_seen_bps: -350, peak_price: 0.964998 });

    const tol = DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC, withinA = 1_700_000_900 + tol - 1, withinB = withinA + tol, afterGapAt = withinB + tol + 1;
    for (const seenAt of [withinA, withinB]) await upsert({ bps: -300, seenAt, price: 0.97 });
    expect(sqlite.prepare("SELECT first_seen_at, last_seen_at FROM depeg_pending WHERE stablecoin_id = ?").get("usdt-tether")).toEqual({ first_seen_at: 1_700_000_000, last_seen_at: withinB });
    await upsert({ bps: -280, seenAt: afterGapAt, price: 0.972 });
    expect(sqlite.prepare("SELECT first_seen_at, last_seen_at, peak_seen_bps FROM depeg_pending WHERE stablecoin_id = ?").get("usdt-tether")).toEqual({ first_seen_at: afterGapAt, last_seen_at: afterGapAt, peak_seen_bps: -280 });
    await upsert({ direction: "above", bps: 180, seenAt: afterGapAt + 1, price: 1.018, reason: "low-confidence" });
    expect(sqlite.prepare("SELECT * FROM depeg_pending").get()).toMatchObject({ direction: "above", first_seen_bps: 180, first_seen_at: afterGapAt + 1, first_price: 1.018, last_seen_bps: 180, last_seen_at: afterGapAt + 1, last_price: 1.018, peak_seen_bps: 180, peak_price: 1.018, reason: "low-confidence" });
    sqlite.close();
  });

  it("resets same-direction candidates when their quote domain changes in either direction", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const observations = [
      { price: 0.0125104, pegReference: 0.012274, bps: 193, reason: "confirmation-window" },
      { price: 1.01847, pegReference: 1, bps: 185, reason: "confirmation-window+native-origin" },
      { price: 0.01252, pegReference: 0.012274, bps: 200, reason: "confirmation-window" },
    ];
    try {
      for (const [index, o] of observations.entries()) {
        const seenAt = 1_700_000_000 + index * 900;
        await buildUpsertPendingDepegStmt(db, { stablecoinId: "a7a5-old-vector", symbol: "A7A5", pegType: "peggedRUB", direction: "above", seenAt, ...o }).run();
        expect(sqlite.prepare("SELECT * FROM depeg_pending WHERE stablecoin_id = ?").get("a7a5-old-vector"))
          .toMatchObject({ first_seen_at: seenAt, first_seen_bps: o.bps, first_price: o.price, last_price: o.price, peak_seen_bps: o.bps, peak_price: o.price, peg_reference: o.pegReference, reason: o.reason });
      }
    } finally { sqlite.close(); }
  });
  it("resets native candidates when their fiat currency identity changes", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const initial = { stablecoinId: "changing-peg", symbol: "PEG", pegType: "peggedREAL", direction: "below" as const, bps: -500, seenAt: 1_700_000_000, price: 0.95, pegReference: 1, reason: "confirmation-window+native-origin" };
      await buildUpsertPendingDepegStmt(db, initial).run();
      await buildUpsertPendingDepegStmt(db, { ...initial, pegType: "peggedEUR", bps: -200, price: 0.98, seenAt: initial.seenAt + 900 }).run();
      expect(sqlite.prepare("SELECT peg_type, first_seen_at, first_price, peak_seen_bps, peak_price FROM depeg_pending").get())
        .toEqual({ peg_type: "peggedEUR", first_seen_at: initial.seenAt + 900, first_price: 0.98, peak_seen_bps: -200, peak_price: 0.98 });
    } finally { sqlite.close(); }
  });
});
