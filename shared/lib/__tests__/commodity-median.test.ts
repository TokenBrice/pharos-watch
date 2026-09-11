import { describe, expect, it } from "vitest";
import { buildCommodityPeerMedianSeries } from "../commodity-median";

describe("buildCommodityPeerMedianSeries", () => {
  it("takes the median of unequal peer daily means, sorted without imputation", () => {
    const day = 86_400;
    const result = buildCommodityPeerMedianSeries([
      {
        peg: "GOLD", commodityOunces: 1,
        prices: [
          { timestamp: 3 * day + 10, price: 200 },
          { timestamp: day + 10, price: 100 },
          { timestamp: day + 100, price: 120 },
        ],
      },
      {
        peg: "GOLD", commodityOunces: 0.5,
        prices: [
          { timestamp: day + 20, price: 70 },
          { timestamp: 3 * day + 20, price: 150 },
        ],
      },
      {
        peg: "GOLD", commodityOunces: 1,
        prices: [
          { timestamp: day + 30, price: 250 },
          { timestamp: day + 40, price: 300 },
          { timestamp: day + 50, price: 350 },
        ],
      },
      { peg: "SILVER", prices: [{ timestamp: day + 50, price: 25 }] },
    ]);

    // Peer means 110, 140, 300: neither pooled mean (210) nor mean of means.
    expect(result.GOLD).toEqual([
      { timestamp: day, rate: 140 },
      { timestamp: 3 * day, rate: 250 },
    ]);
    expect(result.SILVER).toEqual([{ timestamp: day, rate: 25 }]);
  });

  it("skips excluded or empty source series", () => {
    const result = buildCommodityPeerMedianSeries([
      {
        peg: "GOLD",
        commodityOunces: 1,
        excludeFromMedian: true,
        prices: [{ timestamp: 100, price: 100 }],
      },
      {
        peg: "GOLD",
        commodityOunces: 1,
        prices: [],
      },
    ]);

    expect(result.GOLD).toEqual([]);
    expect(result.SILVER).toEqual([]);
  });
});
