import { describe, expect, it } from "vitest";
import { getDependencyReserveOverlapIssues } from "../ci/check-stablecoin-data";

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
