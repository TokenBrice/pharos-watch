import { describe, expect, it } from "vitest";
import { adaptAsymmetry } from "../asymmetry";

describe("adaptAsymmetry", () => {
  it("maps branch collateral values into normalized reserve slices", () => {
    const slices = adaptAsymmetry({
      timestamp: 1776239429591,
      usdaf: {
        total_bold_supply: "996",
        branch: {
          ysyBOLD: { coll_value: "650" },
          scrvUSD: { coll_value: "225" },
          sUSDS: { coll_value: "74" },
          tBTC: { coll_value: "23" },
          sfrxUSD: { coll_value: "19" },
          wBTC: { coll_value: "5" },
        },
      },
    });

    expect(slices.slices).toEqual([
      { name: "ysyBOLD", pct: 65.3, risk: "medium", coinId: "bold-liquity", depType: "wrapper" },
      { name: "scrvUSD", pct: 22.6, risk: "medium", coinId: "crvusd-curve", depType: "wrapper" },
      { name: "sUSDS", pct: 7.4, risk: "low", coinId: "usds-sky", depType: "wrapper" },
      { name: "tBTC", pct: 2.3, risk: "medium" },
      { name: "sfrxUSD", pct: 1.9, risk: "medium", coinId: "frax-frax", depType: "wrapper" },
      { name: "wBTC", pct: 0.5, risk: "medium" },
    ]);
    expect(slices.metadata).toMatchObject({
      branchCount: 6,
      activeBranchCount: 6,
      unknownBranchCount: 0,
      freshnessMode: "verified",
      sourceTimestamp: 1776239429,
      immediateRedeemableUsd: 996,
      redemption: {
        capacityUsd: 996,
        capacityKind: "live-direct-bounded",
        freshnessKind: "verified-source-timestamp",
        routeStatus: "open",
      },
    });
    expect(slices.warnings).toBeUndefined();
  });
});
