import { describe, expect, it } from "vitest";
import {
  encodePortfolioHoldings,
  isPortfolioHolding,
  migratePortfolioIds,
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
});

describe("parsePortfolioUrlParam edge cases", () => {
  it("returns empty array for empty string", () => {
    expect(parsePortfolioUrlParam("")).toEqual([]);
  });

  it("filters out entries with non-numeric amounts", () => {
    const result = parsePortfolioUrlParam("usdc-circle:abc");
    expect(result).toEqual([]);
  });

  it("filters out entries with zero or negative amounts", () => {
    const result = parsePortfolioUrlParam("usdc-circle:0,usdt-tether:-5");
    expect(result).toEqual([]);
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
  });

  it("rejects missing coinId", () => {
    expect(isPortfolioHolding({ amount: 100 })).toBe(false);
  });

  it("rejects non-positive amount", () => {
    expect(isPortfolioHolding({ coinId: "usdc-circle", amount: 0 })).toBe(false);
    expect(isPortfolioHolding({ coinId: "usdc-circle", amount: -1 })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isPortfolioHolding(null)).toBe(false);
    expect(isPortfolioHolding("string")).toBe(false);
    expect(isPortfolioHolding(42)).toBe(false);
  });
});
