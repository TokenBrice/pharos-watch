import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_STABLECOINS: [
    { id: "eurc-circle", flags: { pegCurrency: "EUR", navToken: false } },
    { id: "xaut-tether", flags: { pegCurrency: "GOLD", navToken: false } },
    { id: "kag-kinesis", flags: { pegCurrency: "SILVER", navToken: false } },
    { id: "jpyc-jpyc", flags: { pegCurrency: "JPY", navToken: false } },
  ],
}));

import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";

describe("isPlausibleDexObservationPrice", () => {
  it("accepts realistic EUR prices and rejects implausible ones", () => {
    expect(isPlausibleDexObservationPrice("eurc-circle", 1.08)).toBe(true); // EURC
    expect(isPlausibleDexObservationPrice("eurc-circle", 0.005)).toBe(false);
  });

  it("accepts commodity peg prices (gold/silver) in their expected ranges", () => {
    expect(isPlausibleDexObservationPrice("xaut-tether", 3000)).toBe(true);
    expect(isPlausibleDexObservationPrice("xaut-tether", 1.2)).toBe(false);
    expect(isPlausibleDexObservationPrice("kag-kinesis", 32)).toBe(true);
  });

  it("accepts low-nominal fiat pegs like JPY and rejects $1-like noise", () => {
    expect(isPlausibleDexObservationPrice("jpyc-jpyc", 0.0067)).toBe(true);
    expect(isPlausibleDexObservationPrice("jpyc-jpyc", 1.0)).toBe(false);
  });
});
