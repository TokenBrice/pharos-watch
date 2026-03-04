import { describe, expect, it } from "vitest";
import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";

describe("isPlausibleDexObservationPrice", () => {
  it("accepts realistic EUR prices and rejects implausible ones", () => {
    expect(isPlausibleDexObservationPrice("50", 1.08)).toBe(true); // EURC
    expect(isPlausibleDexObservationPrice("50", 0.005)).toBe(false);
  });

  it("accepts commodity peg prices (gold/silver) in their expected ranges", () => {
    expect(isPlausibleDexObservationPrice("gold-xaut", 3000)).toBe(true);
    expect(isPlausibleDexObservationPrice("gold-xaut", 1.2)).toBe(false);
    expect(isPlausibleDexObservationPrice("silver-kag", 32)).toBe(true);
  });

  it("accepts low-nominal fiat pegs like JPY and rejects $1-like noise", () => {
    expect(isPlausibleDexObservationPrice("cg-jpyc", 0.0067)).toBe(true);
    expect(isPlausibleDexObservationPrice("cg-jpyc", 1.0)).toBe(false);
  });
});
