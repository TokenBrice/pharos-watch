import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchCurrentNativePegQuotesMock = vi.fn();

vi.mock("../native-peg-quotes", () => ({
  fetchCurrentNativePegQuotes: (...args: unknown[]) => fetchCurrentNativePegQuotesMock(...args),
}));

import {
  computePriceDivergenceBps,
  fetchCurrentNativePegImpliedUsdQuotes,
} from "../native-peg-implied-prices";

describe("native-peg-implied-prices", () => {
  beforeEach(() => {
    fetchCurrentNativePegQuotesMock.mockReset();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ["2026-11-20T21:55:00Z", "2026-11-20T21:50:00Z", "openExchangeRates", "intraday", "live-reference", true, "traded-pair"],
    ["2026-11-21T10:00:00Z", "2026-11-20T14:00:00Z", "frankfurter", "business-daily", "reference-market-closed", false, "traded-pair"],
    ["2026-11-20T17:00:00Z", "2026-11-20T14:00:00Z", "frankfurter", "business-daily", "daily-fixing-only", true, "traded-pair"],
    ["2026-11-20T21:55:00Z", "2026-11-20T21:50:00Z", null, null, "no-reference", true, "traded-pair"],
    ["2026-11-20T21:55:00Z", "2026-11-20T21:50:00Z", "openExchangeRates", "intraday", "live-reference", true, "verified-conversion"],
    ["2026-11-20T21:55:00Z", "2026-11-20T21:50:00Z", "openExchangeRates", "intraday", "live-reference", true, "conversion-fx-unverified"],
    ["2026-11-20T21:55:00Z", "2026-11-20T21:50:00Z", "openExchangeRates", "intraday", "live-reference", true, "native-lineage-unavailable"],
  ] as const)("uses %s and independently evaluates the native leg", async (decided, fx, source, cadence, reason, open, nativeLegReason) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(decided));
    const quoteAt = Date.now() / 1000 - 60;
    const fxAt = Date.parse(fx) / 1000;
    const fxObservedAtSec = nativeLegReason === "verified-conversion" ? fxAt : undefined;
    const derivation = nativeLegReason === "traded-pair"
      ? { kind: "traded-pair", lineage: { venue: "verified-venue", pair: "EURC/EUR" } }
      : nativeLegReason === "native-lineage-unavailable" ? undefined
        : { kind: "conversion", lineage: { fxSource: "openExchangeRates", fxObservedAtSec } };
    fetchCurrentNativePegQuotesMock.mockResolvedValue(new Map([
      ["eurc-circle", {
        stablecoinId: "eurc-circle",
        geckoId: "euro-coin",
        pegCurrency: "EUR",
        vsCurrency: "eur",
        price: 1.0012,
        updatedAt: quoteAt,
        derivation,
      }],
    ]));

    const quotes = await fetchCurrentNativePegImpliedUsdQuotes(
      [{
        stablecoinId: "eurc-circle",
        geckoId: "euro-coin",
        pegCurrency: "EUR",
        pegType: "peggedEUR",
      }],
      {
        rates: { peggedEUR: 1.08 },
        type: "fresh",
        updatedAt: fxAt,
        updatedAtByPeg: { peggedEUR: fxAt },
        typeByPeg: { peggedEUR: "fresh" },
        fxReferenceEvidenceByPeg: source && cadence ? { peggedEUR: {
          observation: { pegKey: "peggedEUR", usdPerUnit: 1.08, source, cadence, observedAtSec: fxAt },
          preCloseUsdPerUnit: 1.07,
          sessionOpenedAtSec: Date.parse("2026-11-15T22:00:00Z") / 1000,
          generation: "fx-generation",
        } } : undefined,
      },
    );

    expect(quotes.get("eurc-circle")).toMatchObject({
      stablecoinId: "eurc-circle",
      pegCurrency: "EUR",
      nativePrice: 1.0012,
      priceUsd: 1.0012 * 1.08,
      referencePriceUsd: 1.08,
      referenceType: "fresh",
      updatedAt: nativeLegReason === "traded-pair" || fxObservedAtSec != null ? fxAt : null,
      nativeObservedAtSec: quoteAt,
      nativeFxObservedAtSec: fxObservedAtSec ?? null,
      nativeLegReason,
      referenceObservedAtSec: fxAt,
      referenceSession: { open },
      referenceAdmission: { reason, generation: source ? "fx-generation" : null },
    });
  });

  it.each(["cny", undefined])("withholds an offshore CNH translation with provider unit %s", async (vsCurrency) => {
    fetchCurrentNativePegQuotesMock.mockResolvedValue(new Map([
      ["axcnh-anchorx", {
        stablecoinId: "axcnh-anchorx", pegCurrency: "CNH", vsCurrency, price: 0.98361, updatedAt: 1_700_000_000,
      }],
    ]));
    const quotes = await fetchCurrentNativePegImpliedUsdQuotes(
      [{ stablecoinId: "axcnh-anchorx", pegCurrency: "CNH", pegType: "peggedCNH" }],
      { rates: { peggedCNH: 1 / 6.71 }, type: "fresh", updatedAt: 1_700_000_000 },
    );
    expect(quotes.size).toBe(0);
  });

  it("skips native-implied USD derivation when the FX reference is stale", async () => {
    fetchCurrentNativePegQuotesMock.mockResolvedValue(new Map([
      ["brz-transfero", {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        vsCurrency: "brl",
        price: 0.998,
        updatedAt: 1_700_000_000,
      }],
    ]));

    const quotes = await fetchCurrentNativePegImpliedUsdQuotes(
      [{
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        pegType: "peggedREAL",
      }],
      {
        rates: { peggedREAL: 0.194 },
        type: "stale",
        updatedAt: null,
        typeByPeg: { peggedREAL: "stale" },
      },
    );

    expect(quotes.size).toBe(0);
  });

  it("computes symmetric divergence in basis points", () => {
    expect(computePriceDivergenceBps(1.08, 1.081)).toBe(9);
    expect(computePriceDivergenceBps(1.081, 1.08)).toBe(9);
    expect(computePriceDivergenceBps(0, 1.08)).toBeNull();
    expect(computePriceDivergenceBps(Number.POSITIVE_INFINITY, 1.08)).toBeNull();
    expect(computePriceDivergenceBps(Number.MAX_VALUE, Number.MAX_VALUE)).toBeNull();
  });
});
