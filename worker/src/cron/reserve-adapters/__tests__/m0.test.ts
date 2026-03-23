import { describe, expect, it } from "vitest";
import { adaptM0Collateral, adaptM0Current } from "../m0";

const SAMPLE_PAYLOAD = {
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
};

describe("adaptM0Current", () => {
  it("converts the current collateral query into reserve slices", () => {
    const slices = adaptM0Current(SAMPLE_PAYLOAD);

    expect(slices).toEqual([
      { name: "Eligible U.S. Treasuries", pct: 70.6, risk: "very-low" },
      { name: "Tokenized treasury collateral", pct: 15.4, risk: "low" },
      { name: "Cash", pct: 14, risk: "very-low" },
    ]);
  });

  it("keeps the cash scaling assumption explicit in adapter metadata", async () => {
    const result = adaptM0Collateral(SAMPLE_PAYLOAD);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "dashboard-graphql",
      },
      cashScaleApplied: 1_000,
      cashUnits: "milli-usd-to-micro-usd",
      totalCashScaled: 27_250_000_000_000,
      normalizedReserveTotal: 194_750_000_000_000,
    });
  });
});
