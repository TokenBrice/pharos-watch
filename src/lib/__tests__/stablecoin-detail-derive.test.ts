import { describe, expect, it } from "vitest";
import {
  deriveIndicativeDeviationBps,
  deriveGaugeDeviationBps,
  deriveSupplyFromMarketCap,
} from "../stablecoin-detail-derive";

describe("stablecoin detail derivations", () => {
  describe("deriveIndicativeDeviationBps", () => {
    it("computes basis points from price and peg reference", () => {
      expect(deriveIndicativeDeviationBps(1.0125, 1)).toBe(125);
      expect(deriveIndicativeDeviationBps(0.9975, 1)).toBe(-25);
    });

    it("returns null when price is missing or either input is invalid", () => {
      expect(deriveIndicativeDeviationBps(null, 1)).toBeNull();
      expect(deriveIndicativeDeviationBps(undefined, 1)).toBeNull();
      expect(deriveIndicativeDeviationBps(Number.NaN, 1)).toBeNull();
      expect(deriveIndicativeDeviationBps(1.01, 0)).toBeNull();
      expect(deriveIndicativeDeviationBps(1.01, -1)).toBeNull();
      expect(deriveIndicativeDeviationBps(1.01, Number.NaN)).toBeNull();
    });

    it("forces gauge deviation to zero for NAV tokens", () => {
      expect(deriveGaugeDeviationBps(240, true)).toBe(0);
      expect(deriveGaugeDeviationBps(240, false)).toBe(240);
      expect(deriveGaugeDeviationBps(null, false)).toBe(0);
    });
  });

  describe("deriveSupplyFromMarketCap", () => {
    it("uses marketCap / price when price is positive", () => {
      expect(deriveSupplyFromMarketCap(250_000_000, 2.5)).toBe(100_000_000);
    });

    it("returns null when price is missing or non-positive", () => {
      expect(deriveSupplyFromMarketCap(250_000_000, null)).toBeNull();
      expect(deriveSupplyFromMarketCap(250_000_000, 0)).toBeNull();
    });

    it("returns null when market cap is missing or non-positive", () => {
      expect(deriveSupplyFromMarketCap(null, 1)).toBeNull();
      expect(deriveSupplyFromMarketCap(undefined, 1)).toBeNull();
      expect(deriveSupplyFromMarketCap(0, 1)).toBeNull();
    });
  });
});

describe("deriveSupplyFromMarketCap", () => {
  it("divides market cap by price", () => {
    expect(deriveSupplyFromMarketCap(1_000_000, 1.0)).toBe(1_000_000);
    expect(deriveSupplyFromMarketCap(2_000_000, 0.5)).toBe(4_000_000);
  });

  it("returns null for zero or negative price", () => {
    expect(deriveSupplyFromMarketCap(1_000_000, 0)).toBeNull();
    expect(deriveSupplyFromMarketCap(1_000_000, -1)).toBeNull();
  });

  it("returns null for zero or negative market cap", () => {
    expect(deriveSupplyFromMarketCap(0, 1.0)).toBeNull();
    expect(deriveSupplyFromMarketCap(-100, 1.0)).toBeNull();
  });

  it("returns null for non-number inputs", () => {
    expect(deriveSupplyFromMarketCap(null, 1.0)).toBeNull();
    expect(deriveSupplyFromMarketCap(undefined, 1.0)).toBeNull();
  });
});

describe("deriveIndicativeDeviationBps", () => {
  it("returns 0 bps for exact peg", () => {
    expect(deriveIndicativeDeviationBps(1.0, 1.0)).toBe(0);
  });

  it("returns positive bps for price above peg", () => {
    expect(deriveIndicativeDeviationBps(1.01, 1.0)).toBeCloseTo(100, 0);
  });

  it("returns negative bps for price below peg", () => {
    expect(deriveIndicativeDeviationBps(0.99, 1.0)).toBeCloseTo(-100, 0);
  });

  it("returns null for invalid peg reference", () => {
    expect(deriveIndicativeDeviationBps(1.0, 0)).toBeNull();
    expect(deriveIndicativeDeviationBps(1.0, NaN)).toBeNull();
    expect(deriveIndicativeDeviationBps(3_000, null)).toBeNull();
  });

  it("distinguishes an exact-peg zero from absent and invalid prices", () => {
    expect(deriveIndicativeDeviationBps(null, 1.0)).toBeNull();
    expect(deriveIndicativeDeviationBps(Number.NaN, 1.0)).toBeNull();
    expect(deriveIndicativeDeviationBps(1.0, 1.0)).toBe(0);
  });
});

describe("deriveGaugeDeviationBps", () => {
  it("returns 0 for NAV tokens", () => {
    expect(deriveGaugeDeviationBps(150, true)).toBe(0);
  });

  it("passes through deviation for non-NAV tokens", () => {
    expect(deriveGaugeDeviationBps(50, false)).toBe(50);
    expect(deriveGaugeDeviationBps(-30, false)).toBe(-30);
    expect(deriveGaugeDeviationBps(null, false)).toBe(0);
  });
});
