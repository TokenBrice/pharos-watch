import { describe, expect, it } from "vitest";
import {
  encodePortfolioHoldings,
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
