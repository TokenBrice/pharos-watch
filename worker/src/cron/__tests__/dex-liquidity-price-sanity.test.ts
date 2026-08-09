import { describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../test-helpers/cron";

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [
    { id: "brz-transfero", flags: { pegCurrency: "BRL", navToken: false } },
    { id: "eurc-circle", flags: { pegCurrency: "EUR", navToken: false } },
    { id: "xaut-tether", flags: { pegCurrency: "GOLD", navToken: false } },
    { id: "kau-kinesis", flags: { pegCurrency: "GOLD", navToken: false }, commodityOunces: 1 / 31.1035 },
    { id: "cgo-comtech", flags: { pegCurrency: "GOLD", navToken: false }, commodityOunces: 1 / 31.1035 },
    { id: "ggbr-goldfish-gold", flags: { pegCurrency: "GOLD", navToken: false }, commodityOunces: 0.001 },
    { id: "kag-kinesis", flags: { pegCurrency: "SILVER", navToken: false } },
    { id: "jpyc-jpyc", flags: { pegCurrency: "JPY", navToken: false } },
    { id: "ousg-ondo-finance", flags: { pegCurrency: "USD", navToken: true } },
    { id: "fpi-frax", flags: { pegCurrency: "VAR", navToken: true } },
  ],
}));

import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";

describe("isPlausibleDexObservationPrice", () => {
  const liveRefs = {
    rates: {
      peggedEUR: 1.08,
      peggedREAL: 0.2,
      peggedGOLD: 2915,
      peggedSILVER: 32,
      peggedJPY: 0.0067,
    },
    type: "fresh" as const,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  it("rejects implausible low-nominal fiat noise", () => {
    expect(isPlausibleDexObservationPrice("jpyc-jpyc", 1.0)).toBe(false);
  });

  it("accepts realistic EUR prices and rejects implausible ones", () => {
    expect(isPlausibleDexObservationPrice("eurc-circle", 1.08, liveRefs)).toBe(true); // EURC
    expect(isPlausibleDexObservationPrice("eurc-circle", 0.005, liveRefs)).toBe(false);
  });

  it("maps BRL-pegged assets through the peggedREAL alias", () => {
    expect(isPlausibleDexObservationPrice("brz-transfero", 0.2, liveRefs)).toBe(true);
    expect(isPlausibleDexObservationPrice("brz-transfero", 0.001, liveRefs)).toBe(false);
  });

  it("accepts commodity peg prices (gold/silver) in their expected ranges", () => {
    expect(isPlausibleDexObservationPrice("xaut-tether", 3000, liveRefs)).toBe(true);
    expect(isPlausibleDexObservationPrice("xaut-tether", 1.2, liveRefs)).toBe(false);
    expect(isPlausibleDexObservationPrice("kau-kinesis", 95, liveRefs)).toBe(true);
    expect(isPlausibleDexObservationPrice("cgo-comtech", 95, liveRefs)).toBe(true);
    expect(isPlausibleDexObservationPrice("ggbr-goldfish-gold", 5.15, liveRefs)).toBe(true);
    expect(isPlausibleDexObservationPrice("kag-kinesis", 32, liveRefs)).toBe(true);
  });

  it("accepts low-nominal fiat pegs like JPY and rejects $1-like noise", () => {
    expect(isPlausibleDexObservationPrice("jpyc-jpyc", 0.0067, liveRefs)).toBe(true);
    expect(isPlausibleDexObservationPrice("jpyc-jpyc", 1.0, liveRefs)).toBe(false);
  });

  it("keeps current broad-positive behavior for NAV and VAR pegged assets", () => {
    expect(isPlausibleDexObservationPrice("ousg-ondo-finance", 110)).toBe(true);
    expect(isPlausibleDexObservationPrice("fpi-frax", 3.5)).toBe(true);
    expect(isPlausibleDexObservationPrice("fpi-frax", 0)).toBe(false);
  });

  it("accepts EUR-pegged price with live FX reference and rejects far outliers", () => {
    expect(isPlausibleDexObservationPrice("eurc-circle", 1.12, liveRefs)).toBe(true);
    expect(isPlausibleDexObservationPrice("eurc-circle", 50, liveRefs)).toBe(false);
  });

  it("handles missing references gracefully for commodity pegs", () => {
    expect(isPlausibleDexObservationPrice("xaut-tether", 2900)).toBe(true);
    expect(isPlausibleDexObservationPrice("xaut-tether", 0.5)).toBe(false);
  });

  it("validates fractional gold tokens with commodityOunces scaling", () => {
    // GGBR has commodityOunces: 0.001 (1 milligram of gold)
    expect(isPlausibleDexObservationPrice("ggbr-goldfish-gold", 2.9, liveRefs)).toBe(true);
    expect(isPlausibleDexObservationPrice("ggbr-goldfish-gold", 0.001, liveRefs)).toBe(false);
    expect(isPlausibleDexObservationPrice("ggbr-goldfish-gold", 3000, liveRefs)).toBe(false);
  });
});
