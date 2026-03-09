import { describe, expect, it } from "vitest";
import {
  encodePortfolioHoldings,
  migratePortfolioIds,
  parsePortfolioUrlParam,
} from "../portfolio-codec";

describe("portfolio codec", () => {
  it("parses and re-encodes canonical holdings", () => {
    const holdings = parsePortfolioUrlParam("usdc:25,usdt:75");

    expect(holdings).toEqual([
      { coinId: "usdc-circle", amount: 25 },
      { coinId: "usdt-tether", amount: 75 },
    ]);
    expect(encodePortfolioHoldings(holdings)).toBe("usdc:25,usdt:75");
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
