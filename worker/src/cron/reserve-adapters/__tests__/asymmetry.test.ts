import { describe, expect, it } from "vitest";
import { adaptAsymmetry } from "../asymmetry";

describe("adaptAsymmetry", () => {
  it("maps branch collateral values into normalized reserve slices", () => {
    const slices = adaptAsymmetry({
      usdaf: {
        branch: {
          ysyBOLD: { coll_value: "650" },
          scrvUSD: { coll_value: "225" },
          sUSDS: { coll_value: "74" },
          tBTC: { coll_value: "23" },
          sfrxUSD: { coll_value: "19" },
          WBTC: { coll_value: "5" },
        },
      },
    });

    expect(slices).toEqual([
      { name: "ysyBOLD", pct: 65, risk: "medium", coinId: "bold-liquity", depType: "wrapper" },
      { name: "scrvUSD", pct: 23, risk: "medium", coinId: "crvusd-curve", depType: "wrapper" },
      { name: "sUSDS", pct: 7, risk: "low", coinId: "usds-sky", depType: "wrapper" },
      { name: "tBTC", pct: 2, risk: "medium" },
      { name: "sfrxUSD", pct: 2, risk: "medium", coinId: "frax-frax", depType: "wrapper" },
      { name: "WBTC", pct: 1, risk: "medium" },
    ]);
  });
});
