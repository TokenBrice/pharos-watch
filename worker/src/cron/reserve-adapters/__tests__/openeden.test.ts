import { describe, expect, it } from "vitest";
import { adaptOpenEdenUsdo } from "../openeden";

describe("adaptOpenEdenUsdo", () => {
  it("maps reserve composition fields into reserve slices", () => {
    const result = adaptOpenEdenUsdo({
      date: "2026-03-25T08:00:17.600Z",
      usdoAmount: 62_283_070,
      totalTbillAmountInUsd: 46_831_981.32,
      usdcAmount: 4_767_161.22,
      buidlAmount: 4_568_146.14,
      vbillAmount: 6_372_155.86,
      usycAmountInUsd: 0,
      benjiAmount: 0,
      reserveAssetsInUsd: 62_539_444.54,
      ratio: 100.4116,
    });

    expect(result.slices).toEqual([
      { name: "OpenEden TBILL", pct: 74.9, risk: "very-low", coinId: "tbill-openeden" },
      { name: "OpenEden VBILL", pct: 10.2, risk: "low" },
      { name: "USDC buffer", pct: 7.6, risk: "low", coinId: "usdc-circle" },
      { name: "BlackRock BUIDL", pct: 7.3, risk: "low", coinId: "buidl-blackrock" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 2, 25, 8, 0, 17) / 1000,
      reserveAssetsInUsd: 62_539_444.54,
      supplyUsd: 62_283_070,
      immediateRedeemableUsd: 4_767_161.22,
    });
  });

  it("includes the RLUSD component in component-total validation and slices", () => {
    const result = adaptOpenEdenUsdo({
      date: "2026-03-25T08:00:17.600Z",
      usdoAmount: 100,
      totalTbillAmountInUsd: 70,
      usdcAmount: 10,
      rlusdAmount: 5,
      buidlAmount: 5,
      vbillAmount: 10,
      usycAmountInUsd: 0,
      benjiAmount: 0,
      reserveAssetsInUsd: 100,
      ratio: 1,
    });

    expect(result.slices).toContainEqual({
      name: "RLUSD buffer",
      pct: 5,
      risk: "low",
      coinId: "rlusd-ripple",
    });
  });
});
