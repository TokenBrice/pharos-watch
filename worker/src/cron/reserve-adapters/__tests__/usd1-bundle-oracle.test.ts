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
      redemption: {
        capacityKind: "documented-bound",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: 1776154391,
        routeStatus: "unknown",
        holderEligibility: "verified-customer",
      },
    });
  });

  it("does not emit misleading collateralizationRatio when oracle reports fund-wide reserves", () => {
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

    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.fundBackingTotalRatio).toBeCloseTo(
      4_089_230_010.76 / 1_540_271_014.1308322,
      3,
    );
    expect((result.metadata?.details as Record<string, unknown> | undefined)?.fundScope).toBe(
      "WLFI aggregate fund reserves; denominator is USD1 supply only",
    );
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

  it("uses a configured oracleAddress in metadata instead of the hardcoded default", () => {
    const customOracle = "0x2222222222222222222222222222222222222222";
    const result = adaptUsd1BundleOracle({
      bundle: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [1776154391n, 4_089_230_010_760_000_230_000_000_000n],
      ),
      latestBundleTimestamp: 1776154391n,
      bundleDecimals: [18],
      totalSupplyRaw: 1_540_271_014_130_832_212_980_859_451n,
      tokenDecimals: 18,
      oracleAddress: customOracle,
    });

    expect((result.metadata?.details as Record<string, unknown>).oracleAddress).toBe(customOracle);
  });
});
