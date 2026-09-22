import { describe, expect, it } from "vitest";
import { isReasonablePrice } from "../../lib/price-validation";
import { hasMissingPrice } from "../sync-stablecoins/enrich-prices-shared";
import type { PeggedAsset } from "../sync-stablecoins/enrich-prices-shared";


describe("isReasonablePrice", () => {
  // --- USD peg ---

  it.each([
    [1, true],
    [0.009, false],
    [1.2, false],
    [1.18, true],
    [-1, false],
    [0, false],
    [NaN, false],
    [Infinity, false],
  ])("validates USD price %s as %s", (price, expected) => {
    expect(isReasonablePrice(price, "peggedUSD")).toBe(expected);
  });

  describe("NAV token override", () => {
    it("accepts high USD-denominated prices for NAV tokens", () => {
      expect(isReasonablePrice(11.02, "peggedUSD", undefined, { navToken: true })).toBe(true);
      expect(isReasonablePrice(113.4, "peggedUSD", undefined, { navToken: true })).toBe(true);
    });

    it("still rejects invalid NAV token prices", () => {
      expect(isReasonablePrice(0, "peggedUSD", undefined, { navToken: true })).toBe(false);
      expect(isReasonablePrice(100_000, "peggedUSD", undefined, { navToken: true })).toBe(false);
    });
  });

  // --- Non-USD pegs (hardcoded fallback) ---

  it.each([
    ["EUR", 1.08, true], ["EUR", 0.005, false], ["EUR", 3, false],
    ["JPY", 0.0067, true], ["JPY", 0.0005, false], ["JPY", 0.1, false],
    ["IDR", 0.000062, true], ["IDR", 0.000001, false], ["IDR", 0.01, false],
  ])("validates %s price %s as %s", (currency, price, expected) => {
    expect(isReasonablePrice(price, `pegged${currency}`)).toBe(expected);
  });

  describe("GOLD peg", () => {
    it("accepts gold price ~2900", () => {
      expect(isReasonablePrice(2900, "peggedGOLD")).toBe(true);
    });

    it("accepts fractional-ounce gold tokens when commodityOunces is provided", () => {
      expect(isReasonablePrice(5.15, "peggedGOLD", { peggedGOLD: 2_915 }, { commodityOunces: 0.001 })).toBe(
        true,
      );
    });

    it("rejects fractional-ounce gold prices when commodityOunces is missing", () => {
      expect(isReasonablePrice(5.15, "peggedGOLD", { peggedGOLD: 2_915 })).toBe(false);
    });

    it("rejects 50 (too low)", () => {
      expect(isReasonablePrice(50, "peggedGOLD")).toBe(false);
    });

    it("rejects 200000 (too high)", () => {
      expect(isReasonablePrice(200000, "peggedGOLD")).toBe(false);
    });
  });

  describe("SILVER peg", () => {
    it("accepts silver price ~32", () => {
      expect(isReasonablePrice(32, "peggedSILVER")).toBe(true);
    });

    it("accepts fractional-ounce silver tokens when commodityOunces is provided", () => {
      expect(isReasonablePrice(0.4, "peggedSILVER", { peggedSILVER: 32 }, { commodityOunces: 0.01 })).toBe(true);
    });

    it("rejects 2 (too low)", () => {
      expect(isReasonablePrice(2, "peggedSILVER")).toBe(false);
    });

    it("rejects 1000 (too high)", () => {
      expect(isReasonablePrice(1000, "peggedSILVER")).toBe(false);
    });
  });

  it.each([
    ["SGD", 0.74, true], ["TRY", 0.028, true], ["AUD", 0.63, true],
    ["RUB", 0.011, true], ["ARS", 0.0009, true], ["ARS", 0.0000001, false],
  ])("validates %s price %s as %s", (currency, price, expected) => {
    expect(isReasonablePrice(price, `pegged${currency}`)).toBe(expected);
  });

  // --- FX-rate-aware bounds ---

  describe("FX-rate-aware bounds", () => {
    it("uses dynamic bounds when fxRates provided for EUR", () => {
      // FX rate for EUR is ~1.08, so bounds are 0.0108–1.2852.
      expect(isReasonablePrice(1.08, "peggedEUR", { peggedEUR: 1.08 })).toBe(true);
      expect(isReasonablePrice(1.28, "peggedEUR", { peggedEUR: 1.08 })).toBe(true);
      expect(isReasonablePrice(1.29, "peggedEUR", { peggedEUR: 1.08 })).toBe(false);
      expect(isReasonablePrice(0.005, "peggedEUR", { peggedEUR: 1.08 })).toBe(false);
      expect(isReasonablePrice(2.5, "peggedEUR", { peggedEUR: 1.08 })).toBe(false);
    });

    it("keeps commodity reference bounds on the broader 2x band", () => {
      expect(isReasonablePrice(5_700, "peggedGOLD", { peggedGOLD: 2_915 })).toBe(true);
      expect(isReasonablePrice(5_900, "peggedGOLD", { peggedGOLD: 2_915 })).toBe(false);
    });

    it("uses dynamic bounds for GBP", () => {
      expect(isReasonablePrice(1.25, "peggedGBP", { peggedGBP: 1.26 })).toBe(true);
    });

    it("falls back to hardcoded when fxRate is zero", () => {
      expect(isReasonablePrice(1.08, "peggedEUR", { peggedEUR: 0 })).toBe(true);
    });

    it("falls back to hardcoded when peg type not in fxRates", () => {
      expect(isReasonablePrice(1.08, "peggedEUR", { peggedJPY: 0.0067 })).toBe(true);
    });
  });

  // --- Edge cases ---

  describe("edge cases", () => {
    it("accepts any positive price for undefined pegType (up to 100k)", () => {
      expect(isReasonablePrice(50000, undefined)).toBe(true);
      expect(isReasonablePrice(0.001, undefined)).toBe(true);
    });

    it("rejects zero for undefined pegType", () => {
      expect(isReasonablePrice(0, undefined)).toBe(false);
    });

    it("rejects negative for undefined pegType", () => {
      expect(isReasonablePrice(-5, undefined)).toBe(false);
    });

    it("rejects >= 100k for undefined pegType", () => {
      expect(isReasonablePrice(100_000, undefined)).toBe(false);
    });

    it("accepts any positive price for unknown pegType (default bounds)", () => {
      expect(isReasonablePrice(500, "peggedXYZ")).toBe(true);
    });

    it("rejects 100k for unknown pegType", () => {
      expect(isReasonablePrice(100_000, "peggedXYZ")).toBe(false);
    });

    it("handles empty string pegType (like undefined → default)", () => {
      expect(isReasonablePrice(50, "")).toBe(true);
    });
  });
});

describe("hasMissingPrice", () => {
  it.each([
    [null, true], [undefined, true], [0, true], ["1.0", true],
    [1, false], [0.0001, false],
  ])("classifies price %s as missing: %s", (price, expected) => {
    expect(hasMissingPrice({ price } as PeggedAsset)).toBe(expected);
  });
});
