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
  it.each(["confirm", "recover"] as const)("admits %s groups using their original clock, never a compatibility clock", async (mode) => {
    const now = 1_700_000_000;
    const observedAt = now - 60;
    const price = mode === "confirm" ? 0.98 : 1;
    const sources = ["curve", "uniswap"].map((protocol) => ({
      protocol, sourceFamily: protocol, chain: "ethereum", price, tvl: 2_000_000,
      observedAt, aggregateObservedAt: observedAt, updatedAt: now + 100,
    }));
    const db = makeNoopD1({ prepare: () => ({ all: async () => ({ results: [{
      stablecoin_id: "usdt-tether", dex_price_usd: price, source_total_tvl: 4_000_000,
      source_pool_count: 2, deviation_from_primary_bps: 0, updated_at: now,
      price_sources_json: JSON.stringify(sources),
    }] }) }) });
    const loaded = await loadDexPrices(db, now);
    const admitted = loaded.dexPriceSources.get("usdt-tether");
    expect(admitted?.map((source) => source.updatedAt)).toEqual([observedAt, observedAt]);
    expect(collectDexProtocolCorroborations(admitted, 1, 100, "below", mode)).toHaveLength(2);
  });
  it.each(["confirm", "recover"] as const)("admits %s at original-clock boundaries despite an expired run-start row", async (mode) => {
    const now = 1_700_000_000;
    const observedAt = now - 35 * 60;
    const aggregateObservedAt = now - 75 * 60;
    const price = mode === "confirm" ? 0.98 : 1;
    const sources = ["curve", "uniswap"].map((protocol) => ({
      protocol, sourceFamily: protocol, chain: "ethereum", price, tvl: 2_000_000,
      observedAt, aggregateObservedAt, updatedAt: now,
    }));
    const db = makeNoopD1({ prepare: () => ({ all: async () => ({ results: [{
      stablecoin_id: "usdt-tether", dex_price_usd: price, source_total_tvl: 4_000_000,
      source_pool_count: 2, deviation_from_primary_bps: 0, updated_at: observedAt - 1,
      price_sources_json: JSON.stringify(sources),
    }] }) }) });
    const telemetry = { staleRows: [], malformedRows: [] };
    const loaded = await loadDexPrices(db, now, 35 * 60, telemetry);
    expect(telemetry.staleRows).toEqual([{ stablecoinId: "usdt-tether", updatedAt: observedAt - 1,
      ageSec: 35 * 60 + 1, maxAgeSec: 35 * 60 }]);
    expect(collectDexProtocolCorroborations(loaded.dexPriceSources.get("usdt-tether"), 1, 100, "below", mode)).toHaveLength(2);
    expect(loaded.dexPriceRows.get("usdt-tether")?.updated_at).toBe(observedAt - 1);
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
