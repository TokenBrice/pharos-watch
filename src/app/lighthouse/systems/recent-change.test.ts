import { describe, expect, it } from "vitest";
import { makeAsset } from "../__fixtures__/pharosville-world";
import { getRecentChange } from "./recent-change";

describe("getRecentChange", () => {
  it("derives 24h, 7d, and 30d changes without multiplying by price", () => {
    const change = getRecentChange(makeAsset({
      id: "usdc-circle",
      symbol: "USDC",
      price: 2,
      circulating: { peggedUSD: 120 },
      circulatingPrevDay: { peggedUSD: 100 },
      circulatingPrevWeek: { peggedUSD: 80 },
      circulatingPrevMonth: { peggedUSD: 60 },
    }));

    expect(change.change24hUsd).toBe(20);
    expect(change.change24hPct).toBe(20);
    expect(change.change7dUsd).toBe(40);
    expect(change.change30dUsd).toBe(60);
  });
});
