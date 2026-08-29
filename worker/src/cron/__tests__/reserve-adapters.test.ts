/**
 * Tests for reserve adapter parsing functions.
 *
 * Each adapter has an exported pure "adapt*" function that takes a raw API
 * response and returns an AdapterResult with typed slices. These tests verify
 * correct parsing, bucketing, slice percentage computation, and error handling
 * without any network calls.
 */
import { describe, it, expect } from "vitest";
import { adaptCircleTransparency } from "../reserve-adapters/circle-transparency";
import {
  adaptEthenaCollateral,
  listUnexpectedEthenaAssets,
  type EthenaCollateralResponse,
} from "../reserve-adapters/ethena";
import { adaptSkyModules, listUnknownGroups, type SkyGroupResult } from "../reserve-adapters/sky-makercore";
import { adaptGhoFacilitators, type GhoFacilitatorData } from "../reserve-adapters/gho";

// --- Circle adapter tests ---

describe("adaptCircleTransparency", () => {
  const mockUsdcHtml = `
    <div class="reserve-wrapper"
      data-usdc-us-treasuries="47.08"
      data-usdc-months="19.87"
      data-usdc-cash="11.35"
      data-usdc-in-circulation="21.70">
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
    expect(() => adaptCircleTransparency("<div>empty page</div>", "usdc")).toThrow("missing reserve attributes");
  });

  it("throws when attributes have zero or invalid values", () => {
    const html = `
      <div data-usdc-us-treasuries="0" data-usdc-months="100"></div>
    `;

    expect(() => adaptCircleTransparency(html, "usdc")).toThrow("missing reserve attributes");
  });

  it("throws when some required attributes are missing", () => {
    const html = `<div data-usdc-us-treasuries="95.5"></div>`;

    expect(() => adaptCircleTransparency(html, "usdc")).toThrow("missing reserve attributes");
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

    const result = adaptEthenaCollateral(payload, "https://example.com/ethena");

    // Should have exactly 4 slices (one per bucket with values)
    expect(result.slices.length).toBe(4);

    // Find individual slices
    const liquidCashSlice = result.slices.find((s) => s.name.includes("Liquid Cash"));
    const btcSlice = result.slices.find((s) => s.name.includes("BTC"));
    const ethSlice = result.slices.find((s) => s.name.includes("ETH"));
    const otherSlice = result.slices.find((s) => s.name.includes("Other"));

    expect(liquidCashSlice).toBeDefined();
    expect(liquidCashSlice!.risk).toBe("medium");

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
    expect(result.metadata).not.toHaveProperty("immediateRedeemableUsd");
    expect(result.metadata).not.toHaveProperty("immediateRedeemableRatio");
    expect(result.metadata).not.toHaveProperty("redemption");
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

    const result = adaptEthenaCollateral(payload, "https://example.com/ethena");

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

    const result = adaptEthenaCollateral(payload, "https://example.com/ethena");
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

    const result = adaptEthenaCollateral(payload, "https://example.com/ethena");
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

const SKY_SAMPLE_GROUPS: SkyGroupResult[] = [
  { group: "stablecoins", group_name: "Stablecoins", debt: "4848053264.74", collateral: "4848920495.92", datetime: "2026-04-05T17:33:24" },
  { group: "spark", group_name: "Spark", debt: "3604127984.82", collateral: "3604127984.82", datetime: "2026-04-05T17:33:24" },
  { group: "grove", group_name: "Grove", debt: "2942299611.45", collateral: "2942299611.45", datetime: "2026-04-05T17:33:24" },
  { group: "obex", group_name: "Obex", debt: "605813016.00", collateral: "605813016.00", datetime: "2026-04-05T17:33:24" },
  { group: "core", group_name: "Core", debt: "524177048.08", collateral: "1744997221.98", datetime: "2026-04-05T17:33:24" },
  { group: "staked", group_name: "Staking Engine", debt: "153348644.44", collateral: "1213000185.95", datetime: "2026-04-05T17:33:24" },
  { group: "legacy-rwa", group_name: "Legacy RWA", debt: "104787191.81", collateral: "104787191.81", datetime: "2026-04-05T17:33:24" },
];

describe("adaptSkyModules", () => {
  it("maps Sky module groups into risk-labeled slices", () => {
    const slices = adaptSkyModules(SKY_SAMPLE_GROUPS);

    expect(slices).toHaveLength(7);

    const stableSlice = slices.find((s) => s.name.includes("Stablecoins"));
    expect(stableSlice).toBeDefined();
    expect(stableSlice!.risk).toBe("very-low");
    expect(stableSlice!.sourceKey).toBe("sky-makercore:module:stablecoins");
    // The PSM is a mixed basket, so neither a single coinId nor its relational
    // depType can be authored until the slice is split into exact exposures.
    expect(stableSlice!.coinId).toBeUndefined();
    expect(stableSlice!.depType).toBeUndefined();

    const sparkSlice = slices.find((s) => s.name.includes("Spark"));
    expect(sparkSlice).toBeDefined();
    expect(sparkSlice!.risk).toBe("low");
    expect(sparkSlice!.sourceKey).toBe("sky-makercore:module:spark");

    const coreSlice = slices.find((s) => s.name.includes("Core"));
    expect(coreSlice).toBeDefined();
    expect(coreSlice!.risk).toBe("medium");

    const stakedSlice = slices.find((s) => s.name.includes("Staking Engine"));
    expect(stakedSlice).toBeDefined();
    expect(stakedSlice!.risk).toBe("high");

    const totalPct = slices.reduce((sum, s) => sum + s.pct, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it("omits modules with zero debt", () => {
    const withZero: SkyGroupResult[] = [
      { group: "stablecoins", group_name: "Stablecoins", debt: "1000000000", collateral: "1000000000", datetime: "2026-04-05T17:33:24" },
      { group: "legacy-rwa", group_name: "Legacy RWA", debt: "0", collateral: "0", datetime: "2026-04-05T17:33:24" },
    ];
    const slices = adaptSkyModules(withZero);
    expect(slices).toHaveLength(1);
    expect(slices[0].pct).toBe(100);
  });

  it("returns empty array when all debts are zero", () => {
    const allZero: SkyGroupResult[] = [
      { group: "stablecoins", group_name: "Stablecoins", debt: "0", collateral: "0", datetime: "2026-04-05T17:33:24" },
    ];
    expect(adaptSkyModules(allZero)).toEqual([]);
  });
});

describe("listUnknownGroups (Sky)", () => {
  it("returns empty for known groups", () => {
    expect(listUnknownGroups(SKY_SAMPLE_GROUPS)).toEqual([]);
  });

  it("identifies groups not in the known set", () => {
    const groups: SkyGroupResult[] = [
      ...SKY_SAMPLE_GROUPS,
      { group: "new-thing", group_name: "New Thing", debt: "100", collateral: "100", datetime: "2026-04-05T17:33:24" },
    ];
    const unknown = listUnknownGroups(groups);
    expect(unknown).toContain("new-thing");
    expect(unknown).not.toContain("stablecoins");
  });
});

// --- GHO adapter tests ---

describe("adaptGhoFacilitators", () => {
  it("computes percentage slices from tracked GSM backing plus residual issuance", () => {
    const data: GhoFacilitatorData = {
      facilitators: [
        {
          address: "0x1111111111111111111111111111111111111111",
          label: "CoreGhoDirectMinter",
          bucketLevel: 165_000_000n * 10n ** 18n,
          bucketCapacity: 250_000_000n * 10n ** 18n,
        },
      ],
      trackedModules: [
        {
          address: "0x3333333333333333333333333333333333333333",
          label: "stataUSDC GSM",
          currentBackingGho: 30_000_000n * 10n ** 18n,
          swappable: true,
          isFrozen: false,
          isSeized: false,
          buyFeeBps: 7,
          risk: "low",
          coinId: "usdc-circle",
        },
        {
          address: "0x4444444444444444444444444444444444444444",
          label: "stataUSDT GSM",
          currentBackingGho: 20_000_000n * 10n ** 18n,
          swappable: true,
          isFrozen: false,
          isSeized: false,
          buyFeeBps: 10,
          risk: "low",
          coinId: "usdt-tether",
        },
      ],
      totalSupply: 250_000_000n * 10n ** 18n,
    };

    const result = adaptGhoFacilitators(data);

    expect(result.slices.length).toBe(3);

    // Task 2.5: residual is now decomposed per-facilitator; "CoreGhoDirectMinter"
    // classifies as aave-v3-direct (medium risk) via the directminter pattern.
    const residualSlice = result.slices.find((s) => s.name === "CoreGhoDirectMinter");
    expect(residualSlice).toBeDefined();
    expect(residualSlice!.risk).toBe("medium");

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

  it("skips tracked GSM modules with zero current backing", () => {
    const data: GhoFacilitatorData = {
      facilitators: [
        {
          address: "0x1111111111111111111111111111111111111111",
          label: "Active Facilitator",
          bucketLevel: 100_000n * 10n ** 18n,
          bucketCapacity: 500_000n * 10n ** 18n,
        },
        {
          address: "0x2222222222222222222222222222222222222222",
          label: "Empty Facilitator",
          bucketLevel: 0n,
          bucketCapacity: 100_000n * 10n ** 18n,
        },
      ],
      trackedModules: [
        {
          address: "0x3333333333333333333333333333333333333333",
          label: "Empty GSM",
          currentBackingGho: 0n,
          swappable: true,
          isFrozen: false,
          isSeized: false,
          buyFeeBps: null,
          risk: "low",
        },
      ],
      totalSupply: 100_000n * 10n ** 18n,
    };

    const result = adaptGhoFacilitators(data);
    expect(result.slices.length).toBe(1);
    // Task 2.5: residual allocated to the active facilitator (label preserved),
    // classified as "unknown" (high risk) since "Active Facilitator" doesn't match
    // directminter/flashmint/aave patterns.
    expect(result.slices[0].name).toBe("Active Facilitator");
    expect(result.slices[0].risk).toBe("high");
    expect(result.slices[0].pct).toBe(100);

    expect(result.metadata!.facilitatorCount).toBe(2);
    expect(result.metadata!.activeFacilitatorCount).toBe(1);
  });

  it("returns empty slices when all values are zero", () => {
    const data: GhoFacilitatorData = {
      facilitators: [
        {
          address: "0x1111111111111111111111111111111111111111",
          label: "Empty",
          bucketLevel: 0n,
          bucketCapacity: 0n,
        },
      ],
      trackedModules: [],
      totalSupply: 0n,
    };

    const result = adaptGhoFacilitators(data);
    expect(result.slices).toEqual([]);
  });

  it("handles tracked-GSM-only scenario", () => {
    const data: GhoFacilitatorData = {
      facilitators: [],
      trackedModules: [
        {
          address: "0x3333333333333333333333333333333333333333",
          label: "stataUSDC GSM",
          currentBackingGho: 50_000_000n * 10n ** 18n,
          swappable: true,
          isFrozen: false,
          isSeized: false,
          buyFeeBps: 7,
          risk: "low",
          coinId: "usdc-circle",
        },
        {
          address: "0x4444444444444444444444444444444444444444",
          label: "stataUSDT GSM",
          currentBackingGho: 50_000_000n * 10n ** 18n,
          swappable: true,
          isFrozen: false,
          isSeized: false,
          buyFeeBps: 10,
          risk: "low",
          coinId: "usdt-tether",
        },
      ],
      totalSupply: 100_000_000n * 10n ** 18n,
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
