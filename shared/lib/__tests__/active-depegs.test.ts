import { describe, expect, it } from "vitest";
import type { DepegEvent, OpenIncidentSnapshot } from "../../types/peg";
import {
  classifyOpenIncidentCoverage,
  classifyOpenIncidentEvidence,
  classifyOpenIncidentMateriality,
  classifyOpenIncidentTier,
  compareOpenIncidentRows,
  isNearParUnconfirmedOpenIncident,
  partitionActiveDepegRows,
  selectActiveDepegCoins,
  type RankableOpenIncidentRow,
} from "../active-depegs";
import { DEPEG_LONG_RUNNING_AGE_SEC, DEPEG_REESCALATION_WINDOW_SEC } from "../depeg-config";
import { describeHomepageSupplyCoverage, isHomepageSupplyComplete } from "../homepage-hero-snapshot";

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

describe("selectActiveDepegCoins", () => {
  it("counts flagged coins over the active registry only", () => {
    const coins = [{ id: "a", activeDepeg: true }, { id: "b", activeDepeg: false }, { id: "retired", activeDepeg: true }];
    expect(selectActiveDepegCoins(coins, new Set(["a", "b"])).map((coin) => coin.id)).toEqual(["a"]);
  });
});

describe("classifyOpenIncidentEvidence", () => {
  const ev = classifyOpenIncidentEvidence;
  it("reads fresh off-peg as outside and fresh at-par as inside despite an open gap", () => {
    expect(ev([openEvent()], "a", NOW)).toBe("outside");
    const atPar = openEvent({}, { lastObservationKind: "trusted-at-par", gapStartedAt: NOW - 120, atParIntervals: [[NOW - 120, NOW - 60]] });
    expect(ev([atPar], "a", NOW)).toBe("inside");
  });

  it("holds both readings at 1,200s and drops them at 1,201s", () => {
    const offPeg = openEvent({}, { intervals: [[NOW - 3_600, NOW - 1_200]], lastTrustedObservationAt: NOW - 1_200 });
    const atPar = openEvent({}, { lastObservationKind: "trusted-at-par", gapStartedAt: NOW - 1_300, atParIntervals: [[NOW - 1_300, NOW - 1_200]], lastTrustedObservationAt: NOW - 1_200 });
    expect(ev([offPeg], "a", NOW)).toBe("outside");
    expect(ev([atPar], "a", NOW)).toBe("inside");
    expect(ev([offPeg], "a", NOW + 1)).toBe("unconfirmed");
    expect(ev([atPar], "a", NOW + 1)).toBe("unconfirmed");
  });

  it("rejects future, blind, gapped, uninstrumented, non-unique, or zero-clock evidence", () => {
    for (const events of [
      [openEvent({}, { lastTrustedObservationAt: NOW + 60, intervals: [[NOW - 3_600, NOW + 60]] })],
      [openEvent({}, { lastObservationKind: "blind", gapStartedAt: NOW - 30 })],
      [openEvent({}, { gapStartedAt: NOW - 30 })],
      [openEvent({}, null)], undefined, [], [openEvent({ endedAt: NOW - 10 })], [openEvent(), openEvent({ id: 2 })], [openEvent({ stablecoinId: "b" })],
    ]) expect(ev(events, "a", NOW)).toBe("unconfirmed");
    expect(ev([openEvent()], "a", 0)).toBe("unconfirmed");
  });
});

describe("classifyOpenIncidentCoverage & tier & materiality", () => {
  const [L, R] = [DEPEG_LONG_RUNNING_AGE_SEC, DEPEG_REESCALATION_WINDOW_SEC];
  const [O, I, U] = ["outside", "inside", "unconfirmed"] as const;
  const cov = (lastObservationKind: "trusted-off-peg" | "trusted-at-par" | "blind", lastTrustedObservationAt: number, gapStartedAt: number | null = null) =>
    ({ lastObservationKind, lastTrustedObservationAt, gapStartedAt });

  it("classifies coverage continuity, incident tiers, and <=50 USD / <=75 non-USD materiality boundaries", () => {
    for (const [c, clock, expected] of [
      [cov("trusted-off-peg", NOW - 1_200), NOW, O], [cov("trusted-off-peg", NOW - 1_201), NOW, U],
      [cov("trusted-off-peg", NOW - 60, NOW - 120), NOW, U], [cov("trusted-at-par", NOW - 1_200, NOW - 1_300), NOW, I],
      [cov("trusted-at-par", NOW + 1, NOW - 60), NOW, U], [cov("blind", NOW - 60, NOW - 60), NOW, U],
      [null, NOW, U], [cov("trusted-off-peg", NOW - 60), 0, U],
    ] as const) expect(classifyOpenIncidentCoverage(c, clock)).toBe(expected);

    const old = NOW - L - 86_400;
    const s = (startedAt: number, escalatedAt: number | null = null) => ({ startedAt, escalatedAt });
    for (const [inc, clock, expected] of [
      [s(NOW), NOW, "recent"], [s(NOW - L), NOW, "recent"], [s(NOW - L - 1), NOW, "long_running"],
      [s(old, NOW), NOW, "escalating"], [s(old, NOW - R), NOW, "escalating"], [s(old, NOW - R - 1), NOW, "long_running"],
      [s(old, NOW + 1), NOW, "long_running"], [null, NOW, null], [undefined, NOW, null],
      [s(NOW - 60), 0, null], [s(NOW + 1), NOW, null], [s(Number.NaN), NOW, null],
    ] as Array<[Parameters<typeof classifyOpenIncidentTier>[0], number, ReturnType<typeof classifyOpenIncidentTier>]>) {
      expect(classifyOpenIncidentTier(inc, clock)).toBe(expected);
    }

    for (const [ev, bps, ccy, mat, nearPar] of [
      [U, -50, "USD", 0, true], [U, 50, "USD", 0, true], [U, -51, "USD", 1, false], [U, 51, "USD", 1, false],
      [U, -75, "EUR", 0, true], [U, 75, "EUR", 0, true], [U, -76, "EUR", 1, false], [U, 76, "EUR", 1, false],
      [U, null, "USD", 1, false], [U, Number.NaN, "USD", 1, false], [O, 5, "USD", 1, false], [I, -500, "USD", 0, false], [I, 5, "USD", 0, false],
    ] as Array<[typeof O | typeof I | typeof U, number | null, string, 0 | 1, boolean]>) {
      expect(classifyOpenIncidentMateriality(ev, bps, ccy)).toBe(mat);
      expect(isNearParUnconfirmedOpenIncident(ev, bps, ccy)).toBe(nearPar);
    }
  });
});

describe("compareOpenIncidentRows & partitionActiveDepegRows", () => {
  const row = (id: string, bps: number | null, exposureUsd: number | null, evidence: RankableOpenIncidentRow["evidence"]): RankableOpenIncidentRow =>
    ({ id, bps, exposureUsd, evidence, pegCurrency: "USD" });

  it("ranks Tier 1 above Tier 0, partitions recent/escalating/>30d on one clock, and fails closed on missing/invalid tiers", () => {
    const ranked = [
      row("near-par-huge", -7, 50e6, "unconfirmed"), row("inside-large", -300, 20e6, "inside"),
      row("unpriced-blind", null, null, "unconfirmed"), row("unconfirmed-tied", -400, 1e6, "unconfirmed"),
      row("outside-tied", -400, 1e6, "outside"), row("outside-biggest", -600, 5e6, "outside"),
      row("unconfirmed-no-exp-wide", -800, null, "unconfirmed"),
    ];
    expect([...ranked].sort(compareOpenIncidentRows).map((r) => r.id)).toEqual([
      "outside-biggest", "outside-tied", "unconfirmed-tied", "unconfirmed-no-exp-wide", "unpriced-blind", "near-par-huge", "inside-large",
    ]);

    const snap = (eventId: number, startedAt: number, escalatedAt: number | null = null): OpenIncidentSnapshot => ({ eventId, startedAt, escalatedAt, coverage: null });
    const rows = [row("old", -900, 2e6, "outside"), row("esc", -500, 3e6, "outside"), row("fresh", -200, 1e6, "outside")];
    const inc = { old: snap(1, NOW - DEPEG_LONG_RUNNING_AGE_SEC - 10_000), esc: snap(2, NOW - DEPEG_LONG_RUNNING_AGE_SEC - 20_000, NOW - 3_600) };
    const res = partitionActiveDepegRows(rows, { ...inc, fresh: snap(3, NOW - 3_600) }, NOW);
    expect(res).toMatchObject({ splitAvailable: true, recentCount: 2, longRunningCount: 1, escalatedCount: 1 });
    expect(res.recentRows.map((r) => r.id)).toEqual(["esc", "fresh"]);
    expect(res.longRunningRows.map((r) => r.id)).toEqual(["old"]);
    expect(res.allRows.map((r) => r.id)).toEqual(["esc", "old", "fresh"]);
    expect(partitionActiveDepegRows(rows, undefined, NOW).splitAvailable).toBe(false);
    expect(partitionActiveDepegRows(rows, {}, 0).splitAvailable).toBe(false);
    expect(partitionActiveDepegRows(rows, { ...inc, fresh: snap(3, NOW + 60) }, NOW).splitAvailable).toBe(false);
    const missing = partitionActiveDepegRows(rows, inc, NOW);
    expect(missing).toMatchObject({ splitAvailable: false, recentCount: null });
    expect(missing.allRows).toHaveLength(3);
  });
});

describe("homepage supply completeness", () => {
  it("names a known subtotal, stays silent when complete, and keeps unrecorded coverage legacy (K-031)", () => {
    const ok = isHomepageSupplyComplete;
    const desc = describeHomepageSupplyCoverage;
    const rec = { supplyPartialCount: 0, supplyCoverageUnknownCount: 0 };
    expect(ok({ supplyObservedCount: 267, supplyExpectedCount: 267, ...rec })).toBe(true);
    expect(desc({ supplyObservedCount: 267, supplyExpectedCount: 267, ...rec })).toBeNull();
    expect(desc({ supplyObservedCount: 266, supplyExpectedCount: 267, ...rec })).toBe("Partial · 266/267 assets observed");
    const partial = { supplyObservedCount: 267, supplyExpectedCount: 267, supplyPartialCount: 1, supplyCoverageUnknownCount: 0 };
    expect(ok(partial)).toBe(false);
    expect(desc(partial)).toBe("Partial · 266/267 assets observed");
    const unrecorded = { supplyObservedCount: 267, supplyExpectedCount: 267, supplyPartialCount: 0, supplyCoverageUnknownCount: 267 };
    expect(ok(unrecorded)).toBe(true);
    expect(ok({ supplyObservedCount: 267, supplyExpectedCount: 267 })).toBe(true);
  });
});
