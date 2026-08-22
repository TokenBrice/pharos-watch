import { describe, expect, it } from "vitest";
import {
  fixtureIsReasonablePrice,
  fixtureHasMissingPrice,
  fixturePEG_HARDCODED_PRICE_BOUNDS,
  type PeggedAsset,
} from "./enrich-prices.test-support";

describe("PEG_HARDCODED_PRICE_BOUNDS", () => {
  it("has entries for all major peg types", () => {
    const expected = [
      "USD",
      "EUR",
      "GBP",
      "CHF",
      "BRL",
      "REAL",
      "JPY",
      "IDR",
      "SGD",
      "TRY",
      "AUD",
      "RUB",
      "ZAR",
      "CAD",
      "CNY",
      "CNH",
      "PHP",
      "MXN",
      "UAH",
      "ARS",
      "GOLD",
      "SILVER",
    ];
    for (const key of expected) {
      expect(fixturePEG_HARDCODED_PRICE_BOUNDS[key]).toBeDefined();
      expect(fixturePEG_HARDCODED_PRICE_BOUNDS[key]).toHaveLength(2);
      expect(fixturePEG_HARDCODED_PRICE_BOUNDS[key][0]).toBeLessThan(fixturePEG_HARDCODED_PRICE_BOUNDS[key][1]);
    }
  });
});

describe("isReasonablePrice", () => {
  // --- USD peg ---

  describe("USD peg", () => {
    it("accepts 0.99", () => {
      expect(fixtureIsReasonablePrice(0.99, "peggedUSD")).toBe(true);
    });

    it("accepts 1.01", () => {
      expect(fixtureIsReasonablePrice(1.01, "peggedUSD")).toBe(true);
    });

    it("accepts 1.00", () => {
      expect(fixtureIsReasonablePrice(1.0, "peggedUSD")).toBe(true);
    });

    it("rejects 0.009 (too low)", () => {
      expect(fixtureIsReasonablePrice(0.009, "peggedUSD")).toBe(false);
    });

    it("rejects 1.20 (too high — CG artifact territory)", () => {
      expect(fixtureIsReasonablePrice(1.2, "peggedUSD")).toBe(false);
    });

    it("accepts 1.18 (just within upper bound)", () => {
      expect(fixtureIsReasonablePrice(1.18, "peggedUSD")).toBe(true);
    });

    it("rejects negative price", () => {
      expect(fixtureIsReasonablePrice(-1, "peggedUSD")).toBe(false);
    });

    it("rejects zero", () => {
      expect(fixtureIsReasonablePrice(0, "peggedUSD")).toBe(false);
    });

    it("rejects NaN", () => {
      expect(fixtureIsReasonablePrice(NaN, "peggedUSD")).toBe(false);
    });

    it("rejects Infinity", () => {
      expect(fixtureIsReasonablePrice(Infinity, "peggedUSD")).toBe(false);
    });
  });

  describe("NAV token override", () => {
    it("accepts high USD-denominated prices for NAV tokens", () => {
      expect(fixtureIsReasonablePrice(11.02, "peggedUSD", undefined, { navToken: true })).toBe(true);
      expect(fixtureIsReasonablePrice(113.4, "peggedUSD", undefined, { navToken: true })).toBe(true);
    });

    it("still rejects invalid NAV token prices", () => {
      expect(fixtureIsReasonablePrice(0, "peggedUSD", undefined, { navToken: true })).toBe(false);
      expect(fixtureIsReasonablePrice(100_000, "peggedUSD", undefined, { navToken: true })).toBe(false);
    });
  });

  // --- Non-USD pegs (hardcoded fallback) ---

  describe("EUR peg", () => {
    it("accepts typical EUR rate ~1.08", () => {
      expect(fixtureIsReasonablePrice(1.08, "peggedEUR")).toBe(true);
    });

    it("rejects 0.005 (too low)", () => {
      expect(fixtureIsReasonablePrice(0.005, "peggedEUR")).toBe(false);
    });

    it("rejects 3.0 (too high)", () => {
      expect(fixtureIsReasonablePrice(3.0, "peggedEUR")).toBe(false);
    });
  });

  describe("JPY peg", () => {
    it("accepts typical JPY rate ~0.0067", () => {
      expect(fixtureIsReasonablePrice(0.0067, "peggedJPY")).toBe(true);
    });

    it("rejects 0.0005 (too low)", () => {
      expect(fixtureIsReasonablePrice(0.0005, "peggedJPY")).toBe(false);
    });

    it("rejects 0.1 (too high)", () => {
      expect(fixtureIsReasonablePrice(0.1, "peggedJPY")).toBe(false);
    });
  });

  describe("IDR peg", () => {
    it("accepts typical IDR rate ~0.000062", () => {
      expect(fixtureIsReasonablePrice(0.000062, "peggedIDR")).toBe(true);
    });

    it("rejects 0.000001 (too low)", () => {
      expect(fixtureIsReasonablePrice(0.000001, "peggedIDR")).toBe(false);
    });

    it("rejects 0.01 (too high)", () => {
      expect(fixtureIsReasonablePrice(0.01, "peggedIDR")).toBe(false);
    });
  });

  describe("GOLD peg", () => {
    it("accepts gold price ~2900", () => {
      expect(fixtureIsReasonablePrice(2900, "peggedGOLD")).toBe(true);
    });

    it("accepts fractional-ounce gold tokens when commodityOunces is provided", () => {
      expect(fixtureIsReasonablePrice(5.15, "peggedGOLD", { peggedGOLD: 2_915 }, { commodityOunces: 0.001 })).toBe(
        true,
      );
    });

    it("rejects fractional-ounce gold prices when commodityOunces is missing", () => {
      expect(fixtureIsReasonablePrice(5.15, "peggedGOLD", { peggedGOLD: 2_915 })).toBe(false);
    });

    it("rejects 50 (too low)", () => {
      expect(fixtureIsReasonablePrice(50, "peggedGOLD")).toBe(false);
    });

    it("rejects 200000 (too high)", () => {
      expect(fixtureIsReasonablePrice(200000, "peggedGOLD")).toBe(false);
    });
  });

  describe("SILVER peg", () => {
    it("accepts silver price ~32", () => {
      expect(fixtureIsReasonablePrice(32, "peggedSILVER")).toBe(true);
    });

    it("accepts fractional-ounce silver tokens when commodityOunces is provided", () => {
      expect(fixtureIsReasonablePrice(0.4, "peggedSILVER", { peggedSILVER: 32 }, { commodityOunces: 0.01 })).toBe(true);
    });

    it("rejects 2 (too low)", () => {
      expect(fixtureIsReasonablePrice(2, "peggedSILVER")).toBe(false);
    });

    it("rejects 1000 (too high)", () => {
      expect(fixtureIsReasonablePrice(1000, "peggedSILVER")).toBe(false);
    });
  });

  describe("SGD peg", () => {
    it("accepts typical SGD rate ~0.74", () => {
      expect(fixtureIsReasonablePrice(0.74, "peggedSGD")).toBe(true);
    });
  });

  describe("TRY peg", () => {
    it("accepts typical TRY rate ~0.028", () => {
      expect(fixtureIsReasonablePrice(0.028, "peggedTRY")).toBe(true);
    });
  });

  describe("AUD peg", () => {
    it("accepts typical AUD rate ~0.63", () => {
      expect(fixtureIsReasonablePrice(0.63, "peggedAUD")).toBe(true);
    });
  });

  describe("RUB peg", () => {
    it("accepts typical RUB rate ~0.011", () => {
      expect(fixtureIsReasonablePrice(0.011, "peggedRUB")).toBe(true);
    });
  });

  describe("ARS peg", () => {
    it("accepts typical ARS rate ~0.0009", () => {
      expect(fixtureIsReasonablePrice(0.0009, "peggedARS")).toBe(true);
    });

    it("rejects 0.0000001 (too low)", () => {
      expect(fixtureIsReasonablePrice(0.0000001, "peggedARS")).toBe(false);
    });
  });

  // --- FX-rate-aware bounds ---

  describe("FX-rate-aware bounds", () => {
    it("uses dynamic bounds when fxRates provided for EUR", () => {
      // FX rate for EUR is ~1.08, so bounds are 0.0108–1.2852.
      expect(fixtureIsReasonablePrice(1.08, "peggedEUR", { peggedEUR: 1.08 })).toBe(true);
      expect(fixtureIsReasonablePrice(1.28, "peggedEUR", { peggedEUR: 1.08 })).toBe(true);
      expect(fixtureIsReasonablePrice(1.29, "peggedEUR", { peggedEUR: 1.08 })).toBe(false);
      expect(fixtureIsReasonablePrice(0.005, "peggedEUR", { peggedEUR: 1.08 })).toBe(false);
      expect(fixtureIsReasonablePrice(2.5, "peggedEUR", { peggedEUR: 1.08 })).toBe(false);
    });

    it("keeps commodity reference bounds on the broader 2x band", () => {
      expect(fixtureIsReasonablePrice(5_700, "peggedGOLD", { peggedGOLD: 2_915 })).toBe(true);
      expect(fixtureIsReasonablePrice(5_900, "peggedGOLD", { peggedGOLD: 2_915 })).toBe(false);
    });

    it("uses dynamic bounds for GBP", () => {
      expect(fixtureIsReasonablePrice(1.25, "peggedGBP", { peggedGBP: 1.26 })).toBe(true);
    });

    it("falls back to hardcoded when fxRate is zero", () => {
      expect(fixtureIsReasonablePrice(1.08, "peggedEUR", { peggedEUR: 0 })).toBe(true);
    });

    it("falls back to hardcoded when peg type not in fxRates", () => {
      expect(fixtureIsReasonablePrice(1.08, "peggedEUR", { peggedJPY: 0.0067 })).toBe(true);
    });
  });

  // --- Edge cases ---

  describe("edge cases", () => {
    it("accepts any positive price for undefined pegType (up to 100k)", () => {
      expect(fixtureIsReasonablePrice(50000, undefined)).toBe(true);
      expect(fixtureIsReasonablePrice(0.001, undefined)).toBe(true);
    });

    it("rejects zero for undefined pegType", () => {
      expect(fixtureIsReasonablePrice(0, undefined)).toBe(false);
    });

    it("rejects negative for undefined pegType", () => {
      expect(fixtureIsReasonablePrice(-5, undefined)).toBe(false);
    });

    it("rejects >= 100k for undefined pegType", () => {
      expect(fixtureIsReasonablePrice(100_000, undefined)).toBe(false);
    });

    it("accepts any positive price for unknown pegType (default bounds)", () => {
      expect(fixtureIsReasonablePrice(500, "peggedXYZ")).toBe(true);
    });

    it("rejects 100k for unknown pegType", () => {
      expect(fixtureIsReasonablePrice(100_000, "peggedXYZ")).toBe(false);
    });

    it("handles empty string pegType (like undefined → default)", () => {
      expect(fixtureIsReasonablePrice(50, "")).toBe(true);
    });
  });
});

describe("hasMissingPrice", () => {
  it("detects null price", () => {
    expect(fixtureHasMissingPrice({ price: null } as PeggedAsset)).toBe(true);
  });

  it("detects undefined price", () => {
    expect(fixtureHasMissingPrice({ price: undefined } as unknown as PeggedAsset)).toBe(true);
  });

  it("detects zero price", () => {
    expect(fixtureHasMissingPrice({ price: 0 } as PeggedAsset)).toBe(true);
  });

  it("detects non-number price (string)", () => {
    expect(fixtureHasMissingPrice({ price: "1.0" } as unknown as PeggedAsset)).toBe(true);
  });

  it("returns false for valid price", () => {
    expect(fixtureHasMissingPrice({ price: 1.0 } as PeggedAsset)).toBe(false);
  });

  it("returns false for small but valid price", () => {
    expect(fixtureHasMissingPrice({ price: 0.0001 } as PeggedAsset)).toBe(false);
  });
});
