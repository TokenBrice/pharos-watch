import { describe, expect, it } from "vitest";
import { adaptInfiniFi, type InfiniFiProtocolData } from "../infinifi";

const SAMPLE_RESPONSE: InfiniFiProtocolData = {
  code: "OK",
  data: {
    stats: {
      asset: { totalTVLAssetNormalized: 100 },
    },
    farms: [
      {
        name: "fasanara-gdaf",
        label: "Fasanara mGLOBAL",
        assetsNormalized: 40,
        type: "ILLIQUID",
        underlyingAssetSymbol: "USDC",
      },
      {
        name: "spark-sUSDC-refcode",
        label: "Spark sUSDC",
        assetsNormalized: 30,
        type: "LIQUID",
        underlyingAssetSymbol: "sUSDC",
      },
      {
        name: "fluid-fUSDC",
        label: "Fluid USDC",
        assetsNormalized: 30,
        type: "LIQUID",
        underlyingAssetSymbol: "USDC",
      },
      {
        name: "MintController",
        label: "Mint Controller",
        assetsNormalized: 0,
        type: "PROTOCOL",
        underlyingAssetSymbol: "USDC",
      },
    ],
  },
};

describe("adaptInfiniFi", () => {
  it("converts farm data to ReserveSlice[], skips PROTOCOL and zero-asset farms", () => {
    const { slices } = adaptInfiniFi(SAMPLE_RESPONSE);
    expect(slices).toHaveLength(3);
    expect(slices.find((s) => s.name.includes("Fasanara"))).toMatchObject({
      pct: 40,
      risk: "high",
    });
    expect(slices.find((s) => s.name.includes("Spark"))).toMatchObject({
      pct: 30,
      risk: "low",
      coinId: "usdc-circle",
      depType: "wrapper",
    });
  });

  it("sums to 100 after rounding", () => {
    const total = adaptInfiniFi(SAMPLE_RESPONSE).slices.reduce((acc, s) => acc + s.pct, 0);
    expect(total).toBe(100);
  });

  it("drops farms where assetsNormalized is 0", () => {
    const { slices } = adaptInfiniFi(SAMPLE_RESPONSE);
    expect(slices.every((s) => s.pct > 0)).toBe(true);
  });

  it("returns unknown farm names in a separate list", () => {
    const response: InfiniFiProtocolData = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        farms: [
          ...SAMPLE_RESPONSE.data.farms,
          { name: "brand-new-farm", label: "Brand New", assetsNormalized: 10, type: "LIQUID", underlyingAssetSymbol: "USDC" },
        ],
        stats: { asset: { totalTVLAssetNormalized: 110 } },
      },
    };
    const result = adaptInfiniFi(response);
    expect(result.unknownFarms).toContain("brand-new-farm");
  });

  it("flags dust unknown farms but excludes them from final slices after rounding", () => {
    const response: InfiniFiProtocolData = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        farms: [
          ...SAMPLE_RESPONSE.data.farms,
          { name: "dust-farm", label: "Dust Farm", assetsNormalized: 0.4, type: "LIQUID", underlyingAssetSymbol: "USDC" },
        ],
        stats: { asset: { totalTVLAssetNormalized: 100.4 } },
      },
    };

    const result = adaptInfiniFi(response);
    // Farm is detected as unknown (above 0.05% threshold)
    expect(result.unknownFarms).toContain("dust-farm");
    // But normalizeSlices rounds 0.4% to 0 and filters it out
    expect(result.slices.some((slice) => slice.name === "Dust Farm")).toBe(false);
  });

  it("preserves small farms above 0.05% before normalizeSlices rounding", () => {
    // A farm with 0.5% of TVL should pass the pct threshold and reach normalizeSlices
    const response: InfiniFiProtocolData = {
      code: "OK",
      data: {
        stats: { asset: { totalTVLAssetNormalized: 1000 } },
        farms: [
          { name: "fasanara-gdaf", label: "Fasanara mGLOBAL", assetsNormalized: 995, type: "ILLIQUID", underlyingAssetSymbol: "USDC" },
          { name: "spark-sUSDC-refcode", label: "Spark sUSDC", assetsNormalized: 5, type: "LIQUID", underlyingAssetSymbol: "sUSDC" },
        ],
      },
    };

    const { slices } = adaptInfiniFi(response);
    // Both farms should be present (0.5% passes the >=0.05 threshold)
    expect(slices).toHaveLength(2);
    expect(slices.reduce((acc, s) => acc + s.pct, 0)).toBe(100);
  });
});
