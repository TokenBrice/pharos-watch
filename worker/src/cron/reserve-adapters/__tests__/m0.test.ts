import { describe, expect, it } from "vitest";
import { adaptM0Current } from "../m0";

describe("adaptM0Current", () => {
  it("converts the current collateral query into reserve slices", () => {
    const slices = adaptM0Current({
      data: {
        CollateralCurrent: {
          totalCash: 27_250_000_000,
          eligibleTreasuries: 137_500_000_000_000,
          nonEligibleTreasuries: 0,
          totalTreasuries: 137_500_000_000_000,
          totalTokenCollateral: 30_000_000_000_000,
          eligibleTokenCollateral: 30_000_000_000_000,
          nonEligibleTokenCollateral: 0,
          remainingTerm: 86,
          yieldToMaturity: 0.036,
        },
      },
    });

    expect(slices).toEqual([
      { name: "Eligible U.S. Treasuries", pct: 70.6, risk: "very-low" },
      { name: "Tokenized treasury collateral", pct: 15.4, risk: "low" },
      { name: "Cash", pct: 14, risk: "very-low" },
    ]);
  });
});
