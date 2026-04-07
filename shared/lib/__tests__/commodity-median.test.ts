import { describe, expect, it } from "vitest";
import { buildCommodityPeerMedianSeries } from "../commodity-median";

describe("buildCommodityPeerMedianSeries", () => {
  it("builds a per-day peer median after normalizing to per-ounce prices", () => {
    const day = 86_400;
    const result = buildCommodityPeerMedianSeries([
      {
        peg: "GOLD",
        commodityOunces: 1,
        prices: [
          { timestamp: day + 10, price: 100 },
          { timestamp: day + 100, price: 120 },
        ],
      },
      {
        peg: "GOLD",
        commodityOunces: 0.5,
        prices: [
          { timestamp: day + 20, price: 60 },
          { timestamp: day + 200, price: 70 },
        ],
      },
      {
        peg: "SILVER",
        commodityOunces: 1,
        prices: [
          { timestamp: day + 50, price: 25 },
        ],
      },
    ]);

    expect(result.GOLD).toEqual([
      {
        timestamp: day,
        rate: 120,
      },
    ]);
    expect(result.SILVER).toEqual([
      {
        timestamp: day,
        rate: 25,
      },
    ]);
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
