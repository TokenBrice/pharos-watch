import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { formatComparisonPrice, isCurrentDeviationHeld, readPublishedDeviation, resolveCurrentDeviation, resolveCurrentDeviationBps, resolveDisplayPegReference } from "@/lib/current-peg";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { attentionScore } from "@/lib/depeg-sort";
import { bucketByDeviationBps } from "@/lib/home-alt-aggregates";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import type { ReferenceAdmission } from "@shared/types/reference-admission";

const SUNDAY = 1_794_758_400; // 2026-11-15 16:00 UTC: FX and metals shut
const MONDAY = 1_794_844_800; // 2026-11-16 16:00 UTC: reopened
const EASTER_MONDAY = Date.UTC(2027, 2, 29, 16) / 1000;

afterEach(() => vi.restoreAllMocks());

describe("isCurrentDeviationHeld", () => {
  it.each([
    { peg: "GOLD", at: SUNDAY, bps: 300, held: true },
    { peg: "EUR", at: SUNDAY, bps: -300, held: true },
    { peg: "GOLD", at: SUNDAY, bps: null, held: false },
    { peg: "USD", at: SUNDAY, bps: 300, held: false },
    { peg: "GOLD", at: MONDAY, bps: 300, held: false },
    { peg: "GOLD", at: SUNDAY, bps: -2_500, held: false },
    { peg: "GOLD", at: null, bps: 300, held: false },
  ])("$peg at $at for $bps bps is held=$held", ({ peg, at, bps, held }) => {
    expect(isCurrentDeviationHeld(peg, at, bps)).toBe(held);
  });

  it("withholds a held published deviation", () => {
    const row = makeStablecoin({ id: "xaut-tether", pegType: "peggedGOLD", price: 3_030, priceSource: "coingecko", priceObservedAt: SUNDAY });
    row.currentPeg = {
      currentDeviationBps: 300, pegReference: null, pegReferenceUnavailable: false,
      currentPriceUnavailable: false, primaryTrust: "unusable", dexPriceCheck: null,
    };
    expect(resolveCurrentDeviationBps(row, null, "GOLD")).toBeNull();
  });

  it("holds legacy EUR deviations at both UTC weekend edges", () => {
    for (const time of ["2026-11-20T21:15:00Z", "2026-11-22T22:15:00Z"]) {
      const coin = makePegSummaryCoin({ pegCurrency: "EUR", price: 1.067,
        priceObservedAt: Date.parse(time) / 1000, currentDeviationBps: -300,
        pegReference: { valueUsd: 1.1, source: "fx", contributorCount: 0, asOf: SUNDAY },
      });
      expect(resolveCurrentDeviation(undefined, coin, "EUR")).toEqual({
        deviationBps: null, referenceNote: "Reference market closed",
      });
      expect(bucketByDeviationBps([coin]).moderate).toBe(0);
    }
  });

  it.each([2499.6, -2499.6, 2500.4, -2500.4])("uses the same quote pair before rounding %s bps at closure", (bps) => {
    const row = makeStablecoin({
      id: "eurc-circle", pegType: "peggedEUR", price: 1.1 * (1 + bps / 10000),
      priceSource: "coingecko", priceObservedAt: SUNDAY,
      currentPeg: {
        currentDeviationBps: Math.round(bps), pegReference: { valueUsd: 1.1, source: "fx", contributorCount: 0, asOf: SUNDAY - 60 },
        pegReferenceUnavailable: false, currentPriceUnavailable: false, primaryTrust: "unusable", dexPriceCheck: null,
      },
    });
    const held = Math.abs(bps) < 2500;
    expect(resolveCurrentDeviation(row, null, "EUR")).toEqual({
      deviationBps: held ? null : Math.round(bps), referenceNote: held ? "Reference market closed" : null,
    });
  });
});

describe("resolveCurrentDeviationBps", () => {
  it.each([
    ["legacy calendar fallback", "legacy", {}, 200],
    ["Easter fixing withheld for the same quote", "stale", {}, null],
    ["paired admission for the same quote", "live", {}, 0],
    ["different price", "live", { price: 0.21 }, null],
    ["different quote clock", "live", { priceObservedAt: EASTER_MONDAY - 1 }, null],
    ["different asset", "live", { id: "brlv-crown" }, null],
  ] as const)("handles %s across list and summary versions", (_label, mode, overrides, expected) => {
    vi.spyOn(Date, "now").mockReturnValue(EASTER_MONDAY * 1000);
    const quote = { id: "brz-transfero", price: 0.204, pegType: "peggedREAL", priceSource: "coingecko", priceObservedAt: EASTER_MONDAY };
    const row = makeStablecoin({ ...quote, currentPeg: {
      currentDeviationBps: 200, pegReference: null, pegReferenceUnavailable: false,
      currentPriceUnavailable: false, primaryTrust: "unusable", dexPriceCheck: null,
    } });
    const evidence = { kind: "fx", quoteObservedAtSec: EASTER_MONDAY, decisionAtSec: EASTER_MONDAY, budgetSec: 7200,
      sessionOpenedAtSec: Date.UTC(2027, 2, 28, 21) / 1000, generation: "stablecoins:generation", policyVersion: 1 } as const;
    const referenceAdmission: ReferenceAdmission = mode === "stale"
      ? { ...evidence, status: "stale-reference", reason: "reference-before-reopen", source: "frankfurter",
        cadence: "business-daily", referenceObservedAtSec: Date.UTC(2027, 2, 25, 13, 10) / 1000 }
      : { ...evidence, status: "admitted", reason: "live-reference", source: "openExchangeRates",
        cadence: "intraday", referenceObservedAtSec: EASTER_MONDAY };
    const legacy = makePegSummaryCoin({ ...quote, ...overrides, pegCurrency: "BRL", currentDeviationBps: 200 });
    const summary = mode === "legacy" ? legacy : {
      ...legacy, referenceAdmission, admittedDeviationBps: mode === "live" ? 0 : null,
    };
    expect(resolveCurrentDeviationBps(row, summary, "BRL")).toBe(expected);
  });
});

it("buckets the raw admitted move and requires the same quote clock", () => {
  const coin = {
    ...makePegSummaryCoin({ pegCurrency: "EUR", priceObservedAt: FX_REOPEN_QUOTE_AT }),
    ...makeFxCurrentPeg("admitted", 199.9),
  };
  expect(bucketByDeviationBps([coin])).toEqual({ healthy: 0, mild: 1, moderate: 0, severe: 0 });
  expect(readPublishedDeviation("EUR", { ...coin, priceObservedAt: FX_REOPEN_QUOTE_AT - 1 }).deviationBps).toBeNull();
  expect(readPublishedDeviation("EUR", { admittedDeviationBps: 42 }).deviationBps).toBeNull();
  expect(readPublishedDeviation("USD", { admittedDeviationBps: 0 }).deviationBps).toBe(0);
  expect(readPublishedDeviation("USD", { admittedDeviationBps: -1.875000000000071 }).deviationBps).toBe(-2);
  expect(readPublishedDeviation("USD", { currentDeviationBps: -2 }).deviationBps).toBe(-2);
});

it.each([
  ["held-closed-session", "reference-market-closed", "Reference market closed"],
  ["stale-reference", "reference-before-reopen", "Reference not yet updated"],
] as const)("withholds a %s reading from conversion, buckets and attention sort", (status, reason, referenceNote) => {
  const referenceAdmission = {
    status, reason, kind: "fx", source: "openExchangeRates", cadence: "intraday",
    referenceObservedAtSec: MONDAY - 3600, quoteObservedAtSec: MONDAY,
    decisionAtSec: MONDAY, budgetSec: 7200, sessionOpenedAtSec: MONDAY - 1800,
    generation: "test", policyVersion: 1,
  } as ReferenceAdmission;
  const coin = {
    ...makePegSummaryCoin({ pegCurrency: "EUR", currentDeviationBps: 200, priceObservedAt: MONDAY }),
    referenceAdmission, admittedDeviationBps: null,
  };
  expect(readPublishedDeviation("EUR", coin)).toEqual({ deviationBps: null, referenceNote });
  expect(bucketByDeviationBps([coin])).toEqual({ healthy: 0, mild: 0, moderate: 0, severe: 0 });
  expect(attentionScore({ coin, dews: null })).toBe(0);

  const currentPeg = {
    currentDeviationBps: 200, referenceAdmission, admittedDeviationBps: null,
    pegReference: { valueUsd: 1.1, source: "fx", contributorCount: 0, asOf: MONDAY },
    pegReferenceUnavailable: false, currentPriceUnavailable: false, primaryTrust: "unusable", dexPriceCheck: null,
  } as const;
  const row = { ...makeStablecoin({ price: 1.122, priceSource: "coingecko", priceObservedAt: MONDAY }), currentPeg };
  expect(formatComparisonPrice(row, "EUR")).toBe("$1.1220");
});

const reopenedQuote = { id: "eurc-circle", price: 1.122, priceObservedAt: FX_REOPEN_QUOTE_AT, priceSource: "coingecko" } as const;
const reopenedSummary = makePegSummaryCoin({ id: reopenedQuote.id, price: reopenedQuote.price, priceObservedAt: FX_REOPEN_QUOTE_AT });

it.each([
  ["matched", 1.122, FX_REOPEN_QUOTE_AT, 1.1],
  ["different clock", 1.122, FX_REOPEN_QUOTE_AT - 60, null],
  ["different price", 1.10, FX_REOPEN_QUOTE_AT, null],
] as const)("requires the same quote before borrowing a modern reference (%s)", (_label, price, priceObservedAt, expected) => {
  vi.spyOn(Date, "now").mockReturnValue(FX_REOPEN_QUOTE_AT * 1000);
  const row = makeStablecoin({ ...reopenedQuote, price, priceObservedAt });
  const legacy = {
    ...reopenedSummary,
    ...makeFxCurrentPeg("admitted", 200),
  };
  expect(resolveDisplayPegReference(row, legacy, "EUR")).toBe(expected);
  expect(resolveCurrentDeviationBps(row, legacy, "EUR")).toBe(expected == null ? null : 200);
  const own = { ...row, currentPeg: makeFxCurrentPeg("stale-reference", null, priceObservedAt) };
  expect(resolveDisplayPegReference(own, legacy, "EUR")).toBeNull();
});

it.each([
  ["same quote", FX_REOPEN_QUOTE_AT, "Reference not yet updated"],
  ["mismatched clock", FX_REOPEN_QUOTE_AT - 3600, null],
] as const)("withholds a legacy row's deviation and conversion when modern summary is stale (%s)", (_label, priceObservedAt, referenceNote) => {
  vi.spyOn(Date, "now").mockReturnValue(FX_REOPEN_QUOTE_AT * 1000);
  const { referenceAdmission: _admission, admittedDeviationBps: _admitted, ...currentPeg } = makeFxCurrentPeg("admitted", 200);
  const row = makeStablecoin({ ...reopenedQuote, priceObservedAt, currentPeg });
  const summary = {
    ...reopenedSummary,
    ...makeFxCurrentPeg("stale-reference", null),
  };
  expect(resolveCurrentDeviation(row, summary, "EUR")).toEqual({ deviationBps: null, referenceNote });
  expect(resolveDisplayPegReference(row, summary, "EUR")).toBeNull();

  const own = { ...row, currentPeg: makeFxCurrentPeg("admitted", 125, priceObservedAt) };
  expect(resolveCurrentDeviation(own, summary, "EUR")).toEqual({ deviationBps: 125, referenceNote: null });
  expect(resolveDisplayPegReference(own, summary, "EUR")).toBe(1.1);
});

it("expires clocked list comparisons and honors a newer refusal for the same quote", () => {
  const now = Date.parse("2026-11-18T16:00:00Z") / 1000;
  const quoteAt = now - 21_600;
  const refAt = now - 18_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const evidence = {
    kind: "fx", source: "openExchangeRates", cadence: "intraday", quoteObservedAtSec: quoteAt,
    referenceObservedAtSec: refAt, decisionAtSec: now - 1, budgetSec: 21_600,
    sessionOpenedAtSec: Date.parse("2026-11-15T22:00:00Z") / 1000, generation: "stablecoins:test", policyVersion: 1,
  } as const;
  const row = makeStablecoin({
    id: "eurc-circle", pegType: "peggedEUR", price: 1.078, priceSource: "coingecko", priceObservedAt: quoteAt,
    currentPeg: { ...makeFxCurrentPeg("admitted", -200, quoteAt), currentDeviationBps: -200,
      pegReference: { valueUsd: 1.1, source: "fx", contributorCount: 0, asOf: refAt },
      referenceAdmission: { ...evidence, status: "admitted", reason: "live-reference" } },
  });
  const refusal = makePegSummaryCoin({
    id: row.id, price: row.price, priceObservedAt: quoteAt, pegCurrency: "EUR", currentDeviationBps: null,
    admittedDeviationBps: null, pegReferenceUnavailable: true,
    referenceAdmission: { ...evidence, decisionAtSec: now, status: "stale-reference", reason: "reference-not-repriced" },
  });
  expect(resolveCurrentDeviationBps(row, null, "EUR")).toBe(-200);
  expect(resolveDisplayPegReference(row, null, "EUR")).toBe(1.1);
  expect(resolveCurrentDeviationBps(row, { ...refusal, price: 1.079 }, "EUR")).toBe(-200);
  expect(resolveCurrentDeviationBps(row, refusal, "EUR")).toBeNull();
  clock.mockReturnValue((now + 1) * 1000);
  expect(resolveCurrentDeviationBps(row, null, "EUR")).toBeNull();
  expect(resolveDisplayPegReference(row, null, "EUR")).toBeNull();
});
