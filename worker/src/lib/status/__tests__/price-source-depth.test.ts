import { describe, expect, it } from "vitest";
import {
  bucketSourceDepth,
  buildSourceDepthDistribution,
  createEmptySourceDepthDistribution,
} from "../price-source-depth";

describe("price source depth status helpers", () => {
  it("buckets source counts into the status distribution shape", () => {
    expect(bucketSourceDepth(-1)).toBe("0");
    expect(bucketSourceDepth(0)).toBe("0");
    expect(bucketSourceDepth(1)).toBe("1");
    expect(bucketSourceDepth(4)).toBe("4");
    expect(bucketSourceDepth(5)).toBe("5+");
    expect(bucketSourceDepth(7)).toBe("5+");
  });

  it("counts active canonical assets by raw consensus source depth", () => {
    expect(buildSourceDepthDistribution([
      { id: "usdt-tether", consensusSources: ["coingecko", "defillama-list", "pyth"] },
      { id: "usdc-circle", consensusSources: ["coingecko", "coingecko", " "] },
      { id: "pyusd-paypal", consensusSources: ["coingecko", "defillama-list", "pyth", "binance", "coinbase"] },
      { id: "not-canonical", consensusSources: ["coingecko", "pyth"] },
    ])).toEqual({
      ...createEmptySourceDepthDistribution(),
      "2": 1,
      "3": 1,
      "5+": 1,
    });
  });
});
