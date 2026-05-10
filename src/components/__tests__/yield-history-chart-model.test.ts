import { describe, expect, it } from "vitest";
import { getYieldHistorySourceDisplayLabel } from "@/components/yield-history-chart-model";

describe("yield history chart source display", () => {
  it("disambiguates duplicate source names with source identity", () => {
    const sources = [
      { sourceKey: "aave-v3:ethereum:usdc", yieldSource: "Aave V3" },
      { sourceKey: "aave-v3:base:usdc", yieldSource: "Aave V3" },
      { sourceKey: "compound-v3:base:usdc", yieldSource: "Compound V3" },
    ];

    expect(getYieldHistorySourceDisplayLabel(sources[0], sources)).toBe("Aave V3 (...thereum:usdc)");
    expect(getYieldHistorySourceDisplayLabel(sources[1], sources)).toBe("Aave V3 (...v3:base:usdc)");
    expect(getYieldHistorySourceDisplayLabel(sources[2], sources)).toBe("Compound V3");
  });
});
