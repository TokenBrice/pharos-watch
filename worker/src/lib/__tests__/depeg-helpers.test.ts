import { describe, expect, it, vi } from "vitest";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import {
  buildInsertDepegEventStmt,
  collectDexProtocolCorroborations,
  rowPriceCoverage,
  serializeDepegPriceCoverage,
  rowToDepegEvent,
  type DepegRow,
} from "../depeg-helpers";

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
      expect(events[0]!.priceCoverage).toBeNull();
      expect(events[1]!.priceCoverage?.intervals).toEqual([[100, 200]]);
      expect(rowPriceCoverage({ ...baseDepegRow, price_coverage_json: malformed })).toBeNull();
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line))).some((record) =>
        record.level === "warn" && record.metadata?.eventId === 1,
      )).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects invalid producer coverage on the write path", () => {
    expect(() => serializeDepegPriceCoverage({
      intervals: [[200, 100]], lastTrustedObservationAt: 200, gapStartedAt: null,
    })).toThrow();
  });

  it("buildInsertDepegEventStmt binds confirmation_sources and pending_reason", () => {
    const bindCalls: unknown[][] = [];
    const db = makeNoopD1({
      prepare(_sql: string) {
        return { bind(...args: unknown[]) { bindCalls.push(args); return this; } } as unknown as D1PreparedStatement;
      },
    });
    buildInsertDepegEventStmt(db, {
      id: 0,
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      pegType: "peggedUSD",
      direction: "below",
      peakDeviationBps: -200,
      startedAt: 1000,
      endedAt: null,
      startPrice: 0.98,
      peakPrice: 0.97,
      recoveryPrice: null,
      pegReference: 1,
      source: "live",
      confirmationSources: "DEX+CEX",
      pendingReason: "large-cap",
      closeReason: null,
      provenance: null,
    });
    expect(bindCalls[0]).toContain("DEX+CEX");
    expect(bindCalls[0]).toContain("large-cap");
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
