/**
 * Tests for reserve adapter parsing functions.
 *
 * Each adapter has an exported pure "adapt*" function that takes a raw API
 * response and returns an AdapterResult with typed slices. These tests verify
 * correct parsing, bucketing, slice percentage computation, and error handling
 * without any network calls.
 */
import { describe, it, expect } from "vitest";
import {
  adaptTetherTransparency,
  type TetherTransparencyResponse,
} from "../reserve-adapters/tether";
import { adaptCircleTransparency } from "../reserve-adapters/circle-transparency";
import {
  adaptEthenaCollateral,
  listUnexpectedEthenaAssets,
  type EthenaCollateralResponse,
} from "../reserve-adapters/ethena";
import {
  adaptSkyCollateral,
  listUnexpectedTokens,
} from "../reserve-adapters/sky-makercore";
import {
  adaptFraxCombinedData,
  type FraxCombinedDataResponse,
} from "../reserve-adapters/frax";
import {
  adaptGhoFacilitators,
  type GhoFacilitatorData,
} from "../reserve-adapters/gho";

// --- Tether adapter tests ---

describe("adaptTetherTransparency", () => {
  it("parses a valid Tether transparency response", () => {
    const payload: TetherTransparencyResponse = {
      data: {
        usdt: {
          total_assets: "118536043000",
          total_liabilities: "113124739000",
          shareholder_eq: "5411304000",
        },
      },
    };

    const result = adaptTetherTransparency(payload);

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toContain("Treasury Bills");
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0].risk).toBe("very-low");

    expect(result.metadata).toBeDefined();
    expect(result.metadata!.totalAssetsUsd).toBe(118536043000);
    expect(result.metadata!.totalLiabilitiesUsd).toBe(113124739000);
    expect(result.metadata!.shareholderEquityUsd).toBe(5411304000);
    expect(result.metadata!.collateralizationRatio).toBeCloseTo(
      118536043000 / 113124739000,
      4,
    );
  });

  it("handles numeric values (not just strings)", () => {
    const payload: TetherTransparencyResponse = {
      data: {
        usdt: {
          total_assets: 100_000_000_000,
          total_liabilities: 95_000_000_000,
          shareholder_eq: 5_000_000_000,
        },
      },
    };

    const result = adaptTetherTransparency(payload);
    expect(result.slices).toHaveLength(1);
    expect(result.metadata!.totalAssetsUsd).toBe(100_000_000_000);
  });

  it("throws when usdt data is missing", () => {
    const payload = { data: {} } as unknown as TetherTransparencyResponse;
    expect(() => adaptTetherTransparency(payload)).toThrow(
      "missing usdt data",
    );
  });

  it("throws when total_assets is zero", () => {
    const payload: TetherTransparencyResponse = {
      data: {
        usdt: {
          total_assets: 0,
          total_liabilities: 0,
          shareholder_eq: 0,
        },
      },
    };
    expect(() => adaptTetherTransparency(payload)).toThrow(
      "total_assets invalid or zero",
    );
  });

  it("throws when total_assets is NaN string", () => {
    const payload: TetherTransparencyResponse = {
      data: {
        usdt: {
          total_assets: "not-a-number",
          total_liabilities: "1000",
          shareholder_eq: "100",
        },
      },
    };
    expect(() => adaptTetherTransparency(payload)).toThrow(
      "total_assets invalid or zero",
    );
  });

  it("returns null collateralizationRatio when liabilities are zero", () => {
    const payload: TetherTransparencyResponse = {
      data: {
        usdt: {
          total_assets: "1000000",
          total_liabilities: "0",
          shareholder_eq: "1000000",
        },
      },
    };

    const result = adaptTetherTransparency(payload);
    expect(result.metadata!.collateralizationRatio).toBeNull();
  });
});

// --- Circle adapter tests ---

describe("adaptCircleTransparency", () => {
  const mockUsdcHtml = `
    <div class="reserve-wrapper"
      data-usdc-us-treasuries="47.08"
      data-usdc-months="7.51"
      data-usdc-cash="0.11"
      data-usdc-in-circulation="0.19">
    </div>
  `;

  it("parses USDC reserve data from HTML attributes", () => {
    const result = adaptCircleTransparency(mockUsdcHtml, "usdc");

    expect(result.slices.length).toBeGreaterThanOrEqual(1);
    // All USDC slices should be very-low risk
    for (const slice of result.slices) {
      expect(slice.risk).toBe("very-low");
    }

    // The percentages should sum to approximately 100
    const totalPct = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(totalPct).toBeCloseTo(100, 0);

    expect(result.metadata!.coinType).toBe("usdc");
    expect(result.metadata!.sliceCount).toBe(4);
  });

  it("parses EURC reserve data from HTML attributes", () => {
    const eurcHtml = `
      <div data-eurocoin-cash="12.5" data-eurocoin-tokens="87.5"></div>
    `;

    const result = adaptCircleTransparency(eurcHtml, "eurc");

    expect(result.slices.length).toBe(2);
    expect(result.metadata!.coinType).toBe("eurc");
    expect(result.metadata!.sliceCount).toBe(2);

    const totalPct = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it("throws when no reserve data is found in HTML", () => {
    expect(() =>
      adaptCircleTransparency("<div>empty page</div>", "usdc"),
    ).toThrow("no reserve data found");
  });

  it("ignores attributes with zero or invalid values", () => {
    const html = `
      <div data-usdc-us-treasuries="0" data-usdc-months="100"></div>
    `;

    const result = adaptCircleTransparency(html, "usdc");
    // Only the non-zero attribute should be counted
    expect(result.metadata!.sliceCount).toBe(1);
  });

  it("handles partial data (some attributes missing)", () => {
    const html = `<div data-usdc-us-treasuries="95.5"></div>`;

    const result = adaptCircleTransparency(html, "usdc");
    expect(result.slices.length).toBe(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0].name).toContain("Treasuries");
  });
});

// --- Ethena adapter tests ---

describe("adaptEthenaCollateral", () => {
  it("buckets known Ethena collateral into 4 categories", () => {
    const payload: EthenaCollateralResponse = {
      collateral: [
        { asset: "ETH", exchange: "Binance", timestamp: 1700000000, usdAmount: 2_000_000_000 },
        { asset: "stETH", exchange: "Binance", timestamp: 1700000000, usdAmount: 500_000_000 },
        { asset: "BTC", exchange: "Binance", timestamp: 1700000000, usdAmount: 1_500_000_000 },
        { asset: "Liquid Cash", exchange: "Binance", timestamp: 1700000000, usdAmount: 800_000_000 },
        { asset: "SOL", exchange: "Binance", timestamp: 1700000000, usdAmount: 200_000_000 },
      ],
      totalBackingAssetsInUsd: 5_000_000_000,
    };

    const result = adaptEthenaCollateral(payload);

    // Should have exactly 4 slices (one per bucket with values)
    expect(result.slices.length).toBe(4);

    // Find individual slices
    const stableSlice = result.slices.find((s) => s.name.includes("stables"));
    const btcSlice = result.slices.find((s) => s.name.includes("BTC"));
    const ethSlice = result.slices.find((s) => s.name.includes("ETH"));
    const otherSlice = result.slices.find((s) => s.name.includes("Other"));

    expect(stableSlice).toBeDefined();
    expect(stableSlice!.risk).toBe("low");

    expect(btcSlice).toBeDefined();
    expect(btcSlice!.risk).toBe("medium");

    expect(ethSlice).toBeDefined();
    expect(ethSlice!.risk).toBe("medium");
    // ETH + stETH = 2.5B out of 5B = 50%
    expect(ethSlice!.pct).toBeCloseTo(50, 0);

    expect(otherSlice).toBeDefined();
    expect(otherSlice!.risk).toBe("high");

    // Total should be 100%
    const totalPct = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(totalPct).toBeCloseTo(100, 0);

    expect(result.metadata!.assetCount).toBe(5);
    expect(result.metadata!.totalBackingAssetsInUsd).toBe(5_000_000_000);
  });

  it("skips collateral rows with zero or negative usdAmount", () => {
    const payload: EthenaCollateralResponse = {
      collateral: [
        { asset: "ETH", exchange: "Binance", timestamp: 1700000000, usdAmount: 1_000_000 },
        { asset: "BTC", exchange: "Binance", timestamp: 1700000000, usdAmount: 0 },
        { asset: "SOL", exchange: "Binance", timestamp: 1700000000, usdAmount: -500 },
      ],
      totalBackingAssetsInUsd: 1_000_000,
    };

    const result = adaptEthenaCollateral(payload);

    // Only ETH bucket should have a value
    const nonZero = result.slices.filter((s) => s.pct > 0);
    expect(nonZero.length).toBe(1);
    expect(nonZero[0].name).toContain("ETH");
    expect(nonZero[0].pct).toBe(100);
  });

  it("groups all ETH-related assets into the same bucket", () => {
    const payload: EthenaCollateralResponse = {
      collateral: [
        { asset: "ETH", exchange: "Binance", timestamp: 1700000000, usdAmount: 500_000 },
        { asset: "stETH", exchange: "Binance", timestamp: 1700000000, usdAmount: 300_000 },
        { asset: "WBETH", exchange: "Binance", timestamp: 1700000000, usdAmount: 100_000 },
        { asset: "mETH", exchange: "Binance", timestamp: 1700000000, usdAmount: 50_000 },
        { asset: "LsETH", exchange: "Binance", timestamp: 1700000000, usdAmount: 50_000 },
      ],
      totalBackingAssetsInUsd: 1_000_000,
    };

    const result = adaptEthenaCollateral(payload);
    // All ETH assets should land in one "ETH / liquid staking" bucket
    expect(result.slices.length).toBe(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0].name).toContain("ETH");
  });

  it("returns the most recent timestamp in metadata", () => {
    const payload: EthenaCollateralResponse = {
      collateral: [
        { asset: "ETH", exchange: "Binance", timestamp: 1700000000, usdAmount: 100 },
        { asset: "BTC", exchange: "Binance", timestamp: 1700001000, usdAmount: 100 },
        { asset: "Liquid Cash", exchange: "Binance", timestamp: 1700000500, usdAmount: 100 },
      ],
      totalBackingAssetsInUsd: 300,
    };

    const result = adaptEthenaCollateral(payload);
    expect(result.metadata!.lastUpdatedAt).toBe(1700001000);
  });
});

describe("listUnexpectedEthenaAssets", () => {
  it("returns empty array when all assets are known", () => {
    const payload: EthenaCollateralResponse = {
      collateral: [
        { asset: "ETH", exchange: "Binance", timestamp: 0, usdAmount: 100 },
        { asset: "BTC", exchange: "Binance", timestamp: 0, usdAmount: 100 },
        { asset: "Liquid Cash", exchange: "Binance", timestamp: 0, usdAmount: 100 },
        { asset: "SOL", exchange: "Binance", timestamp: 0, usdAmount: 100 },
      ],
      totalBackingAssetsInUsd: 400,
    };

    expect(listUnexpectedEthenaAssets(payload)).toEqual([]);
  });

  it("identifies unknown assets not in any bucket", () => {
    const payload: EthenaCollateralResponse = {
      collateral: [
        { asset: "ETH", exchange: "Binance", timestamp: 0, usdAmount: 100 },
        { asset: "DOGE", exchange: "Binance", timestamp: 0, usdAmount: 50 },
        { asset: "SHIB", exchange: "Binance", timestamp: 0, usdAmount: 25 },
      ],
      totalBackingAssetsInUsd: 175,
    };

    const unknown = listUnexpectedEthenaAssets(payload);
    expect(unknown).toContain("DOGE");
    expect(unknown).toContain("SHIB");
    expect(unknown).not.toContain("ETH");
  });
});

// --- Sky/MakerDAO adapter tests ---

describe("adaptSkyCollateral", () => {
  it("buckets MakerDAO vault collateral into 4 categories", () => {
    const tokens: Record<string, number> = {
      USDC: 3_000_000_000,
      WETH: 1_000_000_000,
      WSTETH: 500_000_000,
      WBTC: 200_000_000,
      LINK: 100_000_000,
    };

    const slices = adaptSkyCollateral(tokens);

    // Should have at most 4 buckets
    expect(slices.length).toBeLessThanOrEqual(4);

    // Stablecoins should be the largest bucket
    const stableSlice = slices.find((s) => s.name.includes("Stablecoins"));
    expect(stableSlice).toBeDefined();
    expect(stableSlice!.risk).toBe("low");
    expect(stableSlice!.coinId).toBe("usdc-circle");
    expect(stableSlice!.depType).toBe("mechanism");

    // ETH/LSD bucket
    const ethSlice = slices.find((s) => s.name.includes("ETH"));
    expect(ethSlice).toBeDefined();
    expect(ethSlice!.risk).toBe("low");

    // BTC bucket
    const btcSlice = slices.find((s) => s.name.includes("BTC"));
    expect(btcSlice).toBeDefined();
    expect(btcSlice!.risk).toBe("medium");

    // Other bucket
    const otherSlice = slices.find((s) => s.name.includes("Other"));
    expect(otherSlice).toBeDefined();
    expect(otherSlice!.risk).toBe("high");

    // Total should be 100%
    const totalPct = slices.reduce((sum, s) => sum + s.pct, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it("skips tokens with zero or negative values", () => {
    const tokens: Record<string, number> = {
      USDC: 1_000_000,
      WETH: 0,
      WBTC: -500,
    };

    const slices = adaptSkyCollateral(tokens);
    expect(slices.length).toBe(1);
    expect(slices[0].pct).toBe(100);
    expect(slices[0].name).toContain("Stablecoins");
  });

  it("groups multiple stablecoin tokens into one bucket", () => {
    const tokens: Record<string, number> = {
      USDC: 500_000_000,
      USDT: 300_000_000,
      GUSD: 50_000_000,
      USDP: 150_000_000,
    };

    const slices = adaptSkyCollateral(tokens);
    expect(slices.length).toBe(1);
    expect(slices[0].name).toContain("Stablecoins");
    expect(slices[0].pct).toBe(100);
  });

  it("returns empty array when all values are zero", () => {
    const slices = adaptSkyCollateral({ USDC: 0, WETH: 0 });
    expect(slices).toEqual([]);
  });
});

describe("listUnexpectedTokens (Sky)", () => {
  it("returns empty for known tokens", () => {
    expect(listUnexpectedTokens({ USDC: 100, WETH: 50, LINK: 25 })).toEqual(
      [],
    );
  });

  it("identifies tokens not in the known set", () => {
    const unknown = listUnexpectedTokens({
      USDC: 100,
      PEPE: 50,
      SHIB: 25,
    });
    expect(unknown).toContain("PEPE");
    expect(unknown).toContain("SHIB");
    expect(unknown).not.toContain("USDC");
  });

  it("is case-insensitive in the lookup", () => {
    // KNOWN_TOKENS uses uppercase; listUnexpectedTokens upper-cases the input
    const unknown = listUnexpectedTokens({ usdc: 100, weth: 50 });
    expect(unknown).toEqual([]);
  });
});

// --- Frax adapter tests ---

describe("adaptFraxCombinedData", () => {
  it("parses valid Frax collateral data", () => {
    const payload: FraxCombinedDataResponse = {
      protocol: {
        collateral: {
          ratio: 1.05,
          decentralization_ratio: 0.15,
          total_dollar_value: 650_000_000,
        },
      },
    };

    const result = adaptFraxCombinedData(payload);

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toContain("T-bills");
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0].risk).toBe("low");

    expect(result.metadata!.collateralRatio).toBe(1.05);
    expect(result.metadata!.decentralizationRatio).toBe(0.15);
    expect(result.metadata!.totalCollateralUsd).toBe(650_000_000);
  });

  it("throws when collateral data is missing", () => {
    const payload: FraxCombinedDataResponse = { protocol: {} };
    expect(() => adaptFraxCombinedData(payload)).toThrow(
      "missing collateral data",
    );
  });

  it("throws when protocol is missing entirely", () => {
    const payload = {} as FraxCombinedDataResponse;
    expect(() => adaptFraxCombinedData(payload)).toThrow(
      "missing collateral data",
    );
  });
});

// --- GHO adapter tests ---

describe("adaptGhoFacilitators", () => {
  it("computes percentage slices from facilitator bucket levels", () => {
    const data: GhoFacilitatorData = {
      facilitators: [
        {
          label: "Aave V3 Ethereum (overcollateralized)",
          bucketLevel: 150_000_000n * 10n ** 18n,
          bucketCapacity: 200_000_000n * 10n ** 18n,
        },
      ],
      gsmUsdc: 30_000_000n * 10n ** 18n,
      gsmUsdt: 20_000_000n * 10n ** 18n,
    };

    const result = adaptGhoFacilitators(data);

    expect(result.slices.length).toBe(3);

    const aaveSlice = result.slices.find((s) => s.name.includes("Aave"));
    expect(aaveSlice).toBeDefined();
    expect(aaveSlice!.risk).toBe("medium");

    const usdcSlice = result.slices.find((s) => s.name.includes("USDC"));
    expect(usdcSlice).toBeDefined();
    expect(usdcSlice!.risk).toBe("low");
    expect(usdcSlice!.coinId).toBe("usdc-circle");

    const usdtSlice = result.slices.find((s) => s.name.includes("USDT"));
    expect(usdtSlice).toBeDefined();
    expect(usdtSlice!.risk).toBe("low");
    expect(usdtSlice!.coinId).toBe("usdt-tether");

    const totalPct = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(totalPct).toBeCloseTo(100, 0);

    expect(result.metadata!.facilitatorCount).toBe(1);
    expect(result.metadata!.activeFacilitatorCount).toBe(1);
  });

  it("skips facilitators with zero bucket level", () => {
    const data: GhoFacilitatorData = {
      facilitators: [
        {
          label: "Active Facilitator",
          bucketLevel: 100_000n * 10n ** 18n,
          bucketCapacity: 500_000n * 10n ** 18n,
        },
        {
          label: "Empty Facilitator",
          bucketLevel: 0n,
          bucketCapacity: 100_000n * 10n ** 18n,
        },
      ],
      gsmUsdc: 0n,
      gsmUsdt: 0n,
    };

    const result = adaptGhoFacilitators(data);
    expect(result.slices.length).toBe(1);
    expect(result.slices[0].name).toBe("Active Facilitator");
    expect(result.slices[0].pct).toBe(100);

    expect(result.metadata!.facilitatorCount).toBe(2);
    expect(result.metadata!.activeFacilitatorCount).toBe(1);
  });

  it("returns empty slices when all values are zero", () => {
    const data: GhoFacilitatorData = {
      facilitators: [
        {
          label: "Empty",
          bucketLevel: 0n,
          bucketCapacity: 0n,
        },
      ],
      gsmUsdc: 0n,
      gsmUsdt: 0n,
    };

    const result = adaptGhoFacilitators(data);
    expect(result.slices).toEqual([]);
  });

  it("handles GSM-only scenario (no facilitator minting)", () => {
    const data: GhoFacilitatorData = {
      facilitators: [],
      gsmUsdc: 50_000_000n * 10n ** 18n,
      gsmUsdt: 50_000_000n * 10n ** 18n,
    };

    const result = adaptGhoFacilitators(data);
    expect(result.slices.length).toBe(2);

    const totalPct = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(totalPct).toBeCloseTo(100, 0);

    // Should be ~50/50 split
    for (const slice of result.slices) {
      expect(slice.pct).toBeCloseTo(50, 0);
    }
  });
});
