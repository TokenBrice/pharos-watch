import { describe, expect, it } from "vitest";
import { getCommodityAllocatedPegMatchIssues, getDependencyReserveOverlapIssues } from "../ci/check-stablecoin-data";

describe("stablecoin dependency/reserve source ownership", () => {
  it("allows manual and reserve-derived relationships to coexist when their keys differ", () => {
    expect(
      getDependencyReserveOverlapIssues({
        dependencies: [{ id: "usdc-circle", weight: 0.2, type: "mechanism" }],
        reserves: [
          {
            name: "USDC collateral",
            pct: 100,
            risk: "very-low",
            coinId: "usdc-circle",
            depType: "collateral",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects a relationship duplicated across dependencies and linked reserves", () => {
    expect(
      getDependencyReserveOverlapIssues({
        dependencies: [{ id: "usdc-circle", weight: 1, type: "collateral" }],
        reserves: [
          {
            name: "USDC collateral",
            pct: 100,
            risk: "very-low",
            coinId: "usdc-circle",
            depType: "collateral",
          },
        ],
      }),
    ).toEqual([
      "usdc-circle::collateral is authored in both dependencies and linked reserves; " +
        "keep reserve-backed relationships only in reserves",
    ]);
  });
});

describe("commodity-allocated peg-match guard", () => {
  const goldRow = {
    name: "Allocated gold bars",
    pct: 100,
    risk: "very-low",
    assetClass: "commodity-allocated",
  } as never;
  const flagsFor = (pegCurrency: string) =>
    ({ backing: "rwa", pegCurrency, governance: "centralized", yieldBearing: false, rwa: true, navToken: false }) as never;

  it("admits commodity-allocated rows only on metal pegs", () => {
    expect(
      getCommodityAllocatedPegMatchIssues({ flags: flagsFor("GOLD"), reserves: [goldRow] }),
    ).toEqual([]);
    expect(
      getCommodityAllocatedPegMatchIssues({ flags: flagsFor("SILVER"), reserves: [goldRow] }),
    ).toEqual([]);
  });

  it("rejects commodity-allocated rows on non-metal pegs (usdkg class)", () => {
    const issues = getCommodityAllocatedPegMatchIssues({ flags: flagsFor("USD"), reserves: [goldRow] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("commodity-allocated");
    expect(issues[0]).toContain("USD");
  });
});
