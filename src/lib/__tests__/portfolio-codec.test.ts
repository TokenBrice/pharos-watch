import { describe, expect, it } from "vitest";
import {
  encodePortfolioHoldings,
  isPortfolioHolding,
  migratePortfolioIds,
  normalizePortfolioAmount,
  normalizePortfolioHolding,
  parsePortfolioUrlParam,
} from "../portfolio-codec";

describe("portfolio codec", () => {
  it("parses and re-encodes canonical holdings", () => {
    const holdings = parsePortfolioUrlParam("usdc-circle:25,usdt-tether:75");

    expect(holdings).toEqual([
      { coinId: "usdc-circle", amount: 25 },
      { coinId: "usdt-tether", amount: 75 },
    ]);
    expect(encodePortfolioHoldings(holdings)).toBe("usdc-circle:25,usdt-tether:75");
  });

  it("accepts unique legacy symbols but rejects ambiguous ones", () => {
    expect(parsePortfolioUrlParam("usdc:25")).toEqual([
      { coinId: "usdc-circle", amount: 25 },
    ]);
    expect(parsePortfolioUrlParam("usdf:25")).toEqual([]);
  });

  it("migrates legacy llama ids and merges duplicates", () => {
    expect(migratePortfolioIds([
      { coinId: "1", amount: 40 },
      { coinId: "usdt-tether", amount: 10 },
      { coinId: "2", amount: 50 },
    ])).toEqual([
      { coinId: "usdt-tether", amount: 50 },
      { coinId: "usdc-circle", amount: 50 },
    ]);
  });

  it("preserves and merges zero-amount legacy draft holdings", () => {
    expect(migratePortfolioIds([
      { coinId: "1", amount: 0 },
      { coinId: "usdt-tether", amount: 10 },
    ])).toEqual([
      { coinId: "usdt-tether", amount: 10 },
    ]);

    expect(encodePortfolioHoldings([{ coinId: "1", amount: 0 }])).toBe("usdt-tether:0");
  });
});

describe("parsePortfolioUrlParam edge cases", () => {
  it("returns empty array for empty string", () => {
    expect(parsePortfolioUrlParam("")).toEqual([]);
  });

  it("filters out entries with non-numeric amounts", () => {
    const result = parsePortfolioUrlParam("usdc-circle:abc");
    expect(result).toEqual([]);
  });

  it("keeps zero amounts and filters invalid amounts", () => {
    const result = parsePortfolioUrlParam(
      "usdc-circle:0,usdt-tether:-5,dai-makerdao:Infinity,frax-frax:NaN,pyusd-paypal:1abc,lusd-liquity:1:2",
    );
    expect(result).toEqual([{ coinId: "usdc-circle", amount: 0 }]);
  });

  it("filters out unknown ids", () => {
    expect(parsePortfolioUrlParam("not-a-coin:25")).toEqual([]);
  });
});

describe("encodePortfolioHoldings edge cases", () => {
  it("returns empty string for empty holdings", () => {
    expect(encodePortfolioHoldings([])).toBe("");
  });
});

describe("isPortfolioHolding", () => {
  it("accepts valid holdings", () => {
    expect(isPortfolioHolding({ coinId: "usdc-circle", amount: 100 })).toBe(true);
    expect(isPortfolioHolding({ coinId: "usdc-circle", amount: 0 })).toBe(true);
  });

  it("rejects missing coinId", () => {
    expect(isPortfolioHolding({ amount: 100 })).toBe(false);
  });

  it("rejects negative and non-finite amounts", () => {
    expect(isPortfolioHolding({ coinId: "usdc-circle", amount: -1 })).toBe(false);
    expect(isPortfolioHolding({ coinId: "usdc-circle", amount: Infinity })).toBe(false);
    expect(isPortfolioHolding({ coinId: "usdc-circle", amount: NaN })).toBe(false);
  });

  it("rejects unknown coin ids", () => {
    expect(isPortfolioHolding({ coinId: "not-a-coin", amount: 1 })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isPortfolioHolding(null)).toBe(false);
    expect(isPortfolioHolding("string")).toBe(false);
    expect(isPortfolioHolding(42)).toBe(false);
  });
});

describe("normalization helpers", () => {
  it("normalizes finite nonnegative amounts only", () => {
    expect(normalizePortfolioAmount(0)).toBe(0);
    expect(normalizePortfolioAmount(25)).toBe(25);
    expect(normalizePortfolioAmount(-1)).toBeNull();
    expect(normalizePortfolioAmount(Infinity)).toBeNull();
    expect(normalizePortfolioAmount("25")).toBeNull();
  });

  it("canonicalizes known legacy ids while rejecting invalid holdings", () => {
    expect(normalizePortfolioHolding({ coinId: "1", amount: 12 })).toEqual({
      coinId: "usdt-tether",
      amount: 12,
    });
    expect(normalizePortfolioHolding({ coinId: "usdc-circle", amount: -1 })).toBeNull();
    expect(normalizePortfolioHolding({ coinId: "not-a-coin", amount: 1 })).toBeNull();
  });
});
