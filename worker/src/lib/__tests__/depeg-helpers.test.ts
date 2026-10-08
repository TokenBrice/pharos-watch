import { describe, expect, it, vi } from "vitest";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { makePythDepegPrice, makeSoftAgreementDepegPrice } from "./depeg-price.test-support";
import {
  classifyPrimaryDepegTrust,
  hasFreshMultiSourcePrimaryAgreement,
  isAuthoritativeDepegPegReference,
} from "../depeg-trust-policy";
import {
  buildInsertDepegEventStmt,
  collectDexProtocolCorroborations,
  rowPriceCoverage,
  serializeDepegPriceCoverage,
  rowToDepegEvent,
  type DepegRow,
} from "../depeg-helpers";

describe("classifyPrimaryDepegTrust", () => {
  const nowSec = 1_700_000_000;

  it("requires confirmation for fresh soft single-source prices", () => {
    expect(classifyPrimaryDepegTrust({
      price: 1.01,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko"],
    }, nowSec)).toBe("confirm_required");
  });

  it("allows fresh hard single-source prices to remain authoritative", () => {
    expect(classifyPrimaryDepegTrust(makePythDepegPrice(nowSec, {
      price: 0.998,
      priceObservedAtMode: "upstream",
    }), nowSec)).toBe("authoritative");
  });

  it("requires confirmation for hard single-source prices with local-fetch freshness", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.999,
      priceSource: "kraken",
      priceConfidence: "single-source",
      priceObservedAt: nowSec - 60,
      priceObservedAtMode: "local_fetch",
      agreeSources: ["kraken"],
    }, nowSec)).toBe("confirm_required");
  });

  it("requires confirmation for soft-only high-confidence agreement", () => {
    expect(classifyPrimaryDepegTrust(makeSoftAgreementDepegPrice(nowSec, {
      price: 1.0,
    }), nowSec)).toBe("confirm_required");
  });

  it("treats an upstream-capable hard source plus soft corroboration as authoritative", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.998,
      priceSource: "coingecko+pyth",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko", "pyth"],
    }, nowSec)).toBe("authoritative");
  });

  it("requires confirmation for a lone local-fetch hard source plus soft corroboration", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.999,
      priceSource: "coingecko+kraken",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      agreeSources: ["coingecko", "kraken"],
    }, nowSec)).toBe("confirm_required");
  });

  it("accepts two authoritative local-fetch hard sources in agreement", () => {
    expect(classifyPrimaryDepegTrust({
      price: 0.999,
      priceSource: "binance+kraken",
      priceConfidence: "high",
      priceObservedAt: nowSec - 60,
      agreeSources: ["binance", "kraken"],
    }, nowSec)).toBe("authoritative");
  });

  it("uses source observation time rather than sync-write time for freshness", () => {
    expect(classifyPrimaryDepegTrust(makePythDepegPrice(nowSec, {
      price: 1.0,
      priceObservedAt: nowSec - (31 * 60),
      priceUpdatedAt: nowSec - 30,
    }), nowSec)).toBe("confirm_required");
  });

  it("keeps legacy null freshness mode backward-compatible for upstream-capable hard sources", () => {
    expect(classifyPrimaryDepegTrust(makePythDepegPrice(nowSec), nowSec)).toBe("authoritative");
  });
});

describe("hasFreshMultiSourcePrimaryAgreement", () => {
  const nowSec = 1_700_000_000;

  it("accepts fresh corroborated soft-source agreement for recovery handling", () => {
    expect(hasFreshMultiSourcePrimaryAgreement(makeSoftAgreementDepegPrice(nowSec), nowSec)).toBe(true);
  });

  it("rejects stale or low-confidence price clusters", () => {
    expect(hasFreshMultiSourcePrimaryAgreement(makeSoftAgreementDepegPrice(nowSec, {
      priceConfidence: "low",
    }), nowSec)).toBe(false);

    expect(hasFreshMultiSourcePrimaryAgreement(makeSoftAgreementDepegPrice(nowSec, {
      priceObservedAt: nowSec - (31 * 60),
    }), nowSec)).toBe(false);
  });
});

describe("isAuthoritativeDepegPegReference", () => {
  it("rejects thin fiat peer medians without an FX fallback", () => {
    expect(isAuthoritativeDepegPegReference({
      pegCurrency: "BRL",
      pegType: "peggedREAL",
      pegRateSource: "median",
      pegRateContributorCount: 2,
    })).toBe(false);
  });

  it("accepts fallback-backed thin fiat references and robust medians", () => {
    expect(isAuthoritativeDepegPegReference({
      pegCurrency: "BRL",
      pegType: "peggedREAL",
      pegRateSource: "fallback",
      pegRateContributorCount: 2,
    })).toBe(true);

    expect(isAuthoritativeDepegPegReference({
      pegCurrency: "EUR",
      pegType: "peggedEUR",
      pegRateSource: "median",
      pegRateContributorCount: 4,
    })).toBe(true);
  });

  it("leaves USD and commodity references unchanged", () => {
    expect(isAuthoritativeDepegPegReference({
      pegCurrency: "USD",
      pegType: "peggedUSD",
      pegRateSource: "median",
      pegRateContributorCount: 1,
    })).toBe(true);

    expect(isAuthoritativeDepegPegReference({
      pegCurrency: "GOLD",
      pegType: "peggedGOLD",
      pegRateSource: "median",
      pegRateContributorCount: 1,
    })).toBe(true);
  });
});

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
