import { describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import { adaptUsd1BundleOracle } from "../usd1-bundle-oracle";

describe("adaptUsd1BundleOracle", () => {
  it("decodes the Chainlink bundle oracle payload into a live reserve proof", () => {
    const result = adaptUsd1BundleOracle({
      bundle: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [1776154391n, 4_089_230_010_760_000_230_000_000_000n],
      ),
      latestBundleTimestamp: 1776154391n,
      bundleDecimals: [18],
      totalSupplyRaw: 1_540_271_014_130_832_212_980_859_451n,
      tokenDecimals: 18,
    });

    expect(result.slices).toEqual([
      {
        name: "U.S. Treasury Bills, Money Market Funds & Cash",
        pct: 100,
        risk: "very-low",
      },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1776154391,
      totalReserveUsd: 4_089_230_010.76,
      supplyUsd: 1_540_271_014.1308322,
      reserveDecimals: 18,
      tokenDecimals: 18,
    });
  });

  it("rejects mismatched bundle timestamps", () => {
    expect(() =>
      adaptUsd1BundleOracle({
        bundle: encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }],
          [1776154391n, 4_089_230_010_760_000_230_000_000_000n],
        ),
        latestBundleTimestamp: 1776154000n,
        bundleDecimals: [18],
        totalSupplyRaw: 1_540_271_014_130_832_212_980_859_451n,
        tokenDecimals: 18,
      }),
    ).toThrow("timestamp mismatch");
  });
});
