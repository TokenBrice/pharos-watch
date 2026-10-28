import { describe, expect, it } from "vitest";
import type { DepegEvent } from "../../types";
import { classifyOpenIncidentEvidence, selectActiveDepegCoins } from "../active-depegs";
import { describeHomepageSupplyCoverage, isHomepageSupplyComplete } from "../homepage-hero-snapshot";

describe("selectActiveDepegCoins", () => {
  it("counts flagged coins over the active registry only", () => {
    const coins = [
      { id: "a", activeDepeg: true },
      { id: "b", activeDepeg: false },
      { id: "retired", activeDepeg: true },
    ];
    expect(selectActiveDepegCoins(coins, new Set(["a", "b"])).map((coin) => coin.id)).toEqual(["a"]);
  });
});

const NOW = 1_800_000_000;

function openEvent(
  overrides: Partial<DepegEvent> = {},
  coverage: Partial<NonNullable<DepegEvent["priceCoverage"]>> | null = {},
): DepegEvent {
  return {
    id: 1, stablecoinId: "a", symbol: "A", pegType: "peggedUSD", direction: "below",
    peakDeviationBps: -400, startedAt: NOW - 3_600, endedAt: null, startPrice: 0.97,
    peakPrice: 0.96, recoveryPrice: null, pegReference: 1, source: "live",
    confirmationSources: null, pendingReason: null, closeReason: null, provenance: null,
    priceCoverage: coverage === null ? null : {
      intervals: [[NOW - 3_600, NOW - 60]], atParIntervals: [], lastObservationKind: "trusted-off-peg",
      lastTrustedObservationAt: NOW - 60, gapStartedAt: null, ...coverage,
    },
    ...overrides,
  };
}

describe("classifyOpenIncidentEvidence", () => {
  it("reads a current gap-free trusted off-peg observation as outside the band", () => {
    expect(classifyOpenIncidentEvidence([openEvent()], "a", NOW)).toBe("outside");
  });

  it("reads a fresh trusted at-par observation as inside the band despite its open gap", () => {
    const event = openEvent({}, { lastObservationKind: "trusted-at-par", gapStartedAt: NOW - 120, atParIntervals: [[NOW - 120, NOW - 60]] });
    expect(classifyOpenIncidentEvidence([event], "a", NOW)).toBe("inside");
  });

  it("holds both readings at exactly 1,200 seconds and drops them one second later", () => {
    const offPeg = openEvent({}, { intervals: [[NOW - 3_600, NOW - 1_200]], lastTrustedObservationAt: NOW - 1_200 });
    const atPar = openEvent({}, { lastObservationKind: "trusted-at-par", gapStartedAt: NOW - 1_300, atParIntervals: [[NOW - 1_300, NOW - 1_200]], lastTrustedObservationAt: NOW - 1_200 });
    expect(classifyOpenIncidentEvidence([offPeg], "a", NOW)).toBe("outside");
    expect(classifyOpenIncidentEvidence([atPar], "a", NOW)).toBe("inside");
    expect(classifyOpenIncidentEvidence([offPeg], "a", NOW + 1)).toBe("unconfirmed");
    expect(classifyOpenIncidentEvidence([atPar], "a", NOW + 1)).toBe("unconfirmed");
  });

  it("never treats future, blind, gapped or uninstrumented evidence as an observation", () => {
    expect(classifyOpenIncidentEvidence([openEvent({}, { lastTrustedObservationAt: NOW + 60, intervals: [[NOW - 3_600, NOW + 60]] })], "a", NOW)).toBe("unconfirmed");
    expect(classifyOpenIncidentEvidence([openEvent({}, { lastObservationKind: "blind", gapStartedAt: NOW - 30 })], "a", NOW)).toBe("unconfirmed");
    expect(classifyOpenIncidentEvidence([openEvent({}, { gapStartedAt: NOW - 30 })], "a", NOW)).toBe("unconfirmed");
    expect(classifyOpenIncidentEvidence([openEvent({}, null)], "a", NOW)).toBe("unconfirmed");
  });

  it("requires a unique open event for the coin", () => {
    expect(classifyOpenIncidentEvidence(undefined, "a", NOW)).toBe("unconfirmed");
    expect(classifyOpenIncidentEvidence([], "a", NOW)).toBe("unconfirmed");
    expect(classifyOpenIncidentEvidence([openEvent({ endedAt: NOW - 10 })], "a", NOW)).toBe("unconfirmed");
    expect(classifyOpenIncidentEvidence([openEvent(), openEvent({ id: 2 })], "a", NOW)).toBe("unconfirmed");
    expect(classifyOpenIncidentEvidence([openEvent({ stablecoinId: "b" })], "a", NOW)).toBe("unconfirmed");
    expect(classifyOpenIncidentEvidence([openEvent()], "a", 0)).toBe("unconfirmed");
  });
});

describe("homepage supply completeness", () => {
  it("names a known subtotal and stays silent when every member is observed", () => {
    const recorded = { supplyPartialCount: 0, supplyCoverageUnknownCount: 0 };
    expect(isHomepageSupplyComplete({ supplyObservedCount: 267, supplyExpectedCount: 267, ...recorded })).toBe(true);
    expect(describeHomepageSupplyCoverage({ supplyObservedCount: 267, supplyExpectedCount: 267, ...recorded })).toBeNull();
    expect(describeHomepageSupplyCoverage({ supplyObservedCount: 266, supplyExpectedCount: 267, ...recorded })).toBe("Partial · 266/267 assets observed");
  });

  it("never certifies a partial-chain remainder as complete; unrecorded coverage is legacy (K-031)", () => {
    // All 267 members numeric, one excluding a chain: still a known subtotal.
    const partial = {
      supplyObservedCount: 267, supplyExpectedCount: 267, supplyPartialCount: 1, supplyCoverageUnknownCount: 0,
    };
    expect(isHomepageSupplyComplete(partial)).toBe(false);
    expect(describeHomepageSupplyCoverage(partial)).toBe("Partial · 266/267 assets observed");
    // Unrecorded coverage (and old payloads without counts) is legacy, never a Partial marker.
    const unrecorded = {
      supplyObservedCount: 267, supplyExpectedCount: 267, supplyPartialCount: 0, supplyCoverageUnknownCount: 267,
    };
    expect(isHomepageSupplyComplete(unrecorded)).toBe(true);
    expect(isHomepageSupplyComplete({ supplyObservedCount: 267, supplyExpectedCount: 267 })).toBe(true);
  });
});
