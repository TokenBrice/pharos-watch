import { describe, it, expect } from "vitest";
import {
  adaptGhoFacilitators,
  allocateResidualByBucketLevel,
  buildGhoRedemptionMetadata,
  buildGhoSlices,
  type GhoFacilitatorData,
  type GhoFacilitatorSnapshot,
  type GhoTrackedModuleSnapshot,
} from "../gho";

const SAMPLE: GhoFacilitatorData = {
  facilitators: [
    {
      address: "0x1111111111111111111111111111111111111111",
      label: "CoreGhoDirectMinter",
      bucketLevel: 165_000_000n * 10n ** 18n,
      bucketCapacity: 250_000_000n * 10n ** 18n,
    },
    {
      address: "0x2222222222222222222222222222222222222222",
      label: "GhoDirectFacilitator GSMs Mainnet",
      bucketLevel: 280_000_000n * 10n ** 18n,
      bucketCapacity: 280_000_000n * 10n ** 18n,
    },
  ],
  trackedModules: [
    {
      address: "0x3333333333333333333333333333333333333333",
      label: "stataUSDC GSM",
      currentBackingGho: 45_000_000n * 10n ** 18n,
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
      currentBackingGho: 15_000_000n * 10n ** 18n,
      swappable: false,
      isFrozen: true,
      isSeized: false,
      buyFeeBps: 10,
      risk: "low",
      coinId: "usdt-tether",
    },
  ],
  totalSupply: 300_000_000n * 10n ** 18n,
};

describe("adaptGhoFacilitators", () => {
  it("produces slices from tracked GSM backing plus per-facilitator residual", () => {
    const result = adaptGhoFacilitators(SAMPLE);
    // 2 tracked GSM modules (with non-zero backing) + 2 residual facilitators
    expect(result.slices.length).toBe(4);
    const total = result.slices.reduce((sum, slice) => sum + slice.pct, 0);
    expect(total).toBe(100);

    const aaveCore = result.slices.find((slice) => slice.name === "CoreGhoDirectMinter");
    expect(aaveCore).toBeDefined();
    expect(aaveCore?.risk).toBe("medium");
    // No unknownExposurePct because all facilitators are classified Aave V3.
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
  });

  it("skips tracked GSM modules with zero current backing", () => {
    const data: GhoFacilitatorData = {
      ...SAMPLE,
      trackedModules: [
        {
          ...SAMPLE.trackedModules[0],
          currentBackingGho: 0n,
        },
      ],
      totalSupply: 100_000_000n * 10n ** 18n,
    };
    const result = adaptGhoFacilitators(data);
    // 2 residual facilitator slices, no tracked module slices.
    expect(result.slices).toHaveLength(2);
    expect(result.slices.map((s) => s.name)).toEqual(
      expect.arrayContaining(["CoreGhoDirectMinter", "GhoDirectFacilitator GSMs Mainnet"]),
    );
  });

  it("classifies flashminter labels as high risk", () => {
    const data: GhoFacilitatorData = {
      facilitators: [
        {
          address: "0x5555555555555555555555555555555555555555",
          label: "GhoFlashMinter",
          bucketLevel: 100_000_000n * 10n ** 18n,
          bucketCapacity: 100_000_000n * 10n ** 18n,
        },
      ],
      trackedModules: [],
      totalSupply: 100_000_000n * 10n ** 18n,
    };
    const result = adaptGhoFacilitators(data);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]?.name).toBe("GhoFlashMinter");
    expect(result.slices[0]?.risk).toBe("high");
    expect(result.metadata?.unknownExposurePct).toBeUndefined();
  });

  it("reports unknownExposurePct for facilitator labels that do not match known patterns", () => {
    const data: GhoFacilitatorData = {
      facilitators: [
        {
          address: "0x6666666666666666666666666666666666666666",
          label: "SomeUnknownThirdParty",
          bucketLevel: 100_000_000n * 10n ** 18n,
          bucketCapacity: 100_000_000n * 10n ** 18n,
        },
      ],
      trackedModules: [],
      totalSupply: 100_000_000n * 10n ** 18n,
    };
    const result = adaptGhoFacilitators(data);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]?.risk).toBe("high");
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(100, 2);
  });

  it("includes tracked GSM coinIds", () => {
    const result = adaptGhoFacilitators(SAMPLE);
    const usdcSlice = result.slices.find((slice) => slice.name.includes("USDC"));
    expect(usdcSlice?.coinId).toBe("usdc-circle");
    expect(usdcSlice?.risk).toBe("low");
  });

  it("emits immediate redeemable metadata only for swappable modules", () => {
    const result = adaptGhoFacilitators(SAMPLE);

    expect(result.metadata?.immediateRedeemableUsd).toBe(45_000_000);
    expect(result.metadata?.trackedGsmBackingUsd).toBe(60_000_000);
    expect(result.metadata?.residualSupplyUsd).toBe(240_000_000);
    expect(result.metadata?.swappableTrackedGsmCount).toBe(1);
    expect(result.metadata?.redemptionFeeBps).toBe(10);
    expect(result.metadata?.buyFeeBpsMin).toBe(7);
    expect(result.metadata?.buyFeeBpsMax).toBe(10);
  });
});

const FACILITATOR_A: GhoFacilitatorSnapshot = {
  address: "0xaaa0000000000000000000000000000000000000",
  label: "CoreGhoDirectMinter",
  bucketLevel: 100n,
  bucketCapacity: 200n,
};
const FACILITATOR_B: GhoFacilitatorSnapshot = {
  address: "0xbbb0000000000000000000000000000000000000",
  label: "GhoFlashMinter",
  bucketLevel: 300n,
  bucketCapacity: 500n,
};
const FACILITATOR_ZERO: GhoFacilitatorSnapshot = {
  address: "0xccc0000000000000000000000000000000000000",
  label: "InactiveFacilitator",
  bucketLevel: 0n,
  bucketCapacity: 100n,
};

describe("allocateResidualByBucketLevel", () => {
  it("returns empty when residual is non-positive", () => {
    expect(allocateResidualByBucketLevel([FACILITATOR_A, FACILITATOR_B], 0n)).toEqual([]);
    expect(allocateResidualByBucketLevel([FACILITATOR_A, FACILITATOR_B], -10n)).toEqual([]);
  });

  it("returns empty when no facilitator has a positive bucketLevel", () => {
    expect(allocateResidualByBucketLevel([FACILITATOR_ZERO], 1_000n)).toEqual([]);
  });

  it("splits residual proportionally and folds rounding dust into the last share", () => {
    // 1000 across 100 + 300 = 250 + 750 — exact.
    const exact = allocateResidualByBucketLevel([FACILITATOR_A, FACILITATOR_B], 1_000n);
    expect(exact).toHaveLength(2);
    expect(exact[0]?.share).toBe(250n);
    expect(exact[1]?.share).toBe(750n);

    // 1001: floor(1001 * 100 / 400) = 250; last absorbs dust → 751.
    const dust = allocateResidualByBucketLevel([FACILITATOR_A, FACILITATOR_B], 1_001n);
    expect(dust[0]?.share).toBe(250n);
    expect(dust[1]?.share).toBe(751n);
    // Invariant: sum equals input residual.
    expect(dust.reduce((sum, a) => sum + a.share, 0n)).toBe(1_001n);
  });

  it("skips facilitators with bucketLevel === 0 when computing shares", () => {
    const result = allocateResidualByBucketLevel(
      [FACILITATOR_A, FACILITATOR_ZERO, FACILITATOR_B],
      1_000n,
    );
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.facilitator.label)).toEqual([
      "CoreGhoDirectMinter",
      "GhoFlashMinter",
    ]);
  });
});

describe("buildGhoSlices", () => {
  const trackedActive: GhoTrackedModuleSnapshot = {
    address: "0xddd0000000000000000000000000000000000000",
    label: "stataUSDC GSM",
    coinId: "usdc-circle",
    risk: "low",
    currentBackingGho: 10n * 10n ** 18n,
    swappable: true,
    isFrozen: false,
    isSeized: false,
    buyFeeBps: 7,
  };
  const trackedZero: GhoTrackedModuleSnapshot = { ...trackedActive, label: "Empty GSM", currentBackingGho: 0n };

  it("skips zero-backing tracked modules and forwards coinId on the rest", () => {
    const { values, unknownResidualRaw } = buildGhoSlices([trackedActive, trackedZero], [], 0n);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ name: "stataUSDC GSM", risk: "low", coinId: "usdc-circle" });
    expect(unknownResidualRaw).toBe(0n);
  });

  it("attributes residual to facilitators and accumulates only unknown-label shares", () => {
    const allocations = [
      { facilitator: FACILITATOR_A, share: 100n * 10n ** 18n }, // aave-v3-direct → medium
      { facilitator: FACILITATOR_B, share: 200n * 10n ** 18n }, // flashminter → high, NOT unknown
      {
        facilitator: { ...FACILITATOR_A, label: "MysteryParty" },
        share: 300n * 10n ** 18n, // unknown → high
      },
    ];
    const { values, unknownResidualRaw } = buildGhoSlices([], allocations, 600n * 10n ** 18n);
    expect(values).toHaveLength(3);
    expect(values.find((v) => v.name === "CoreGhoDirectMinter")?.risk).toBe("medium");
    expect(values.find((v) => v.name === "GhoFlashMinter")?.risk).toBe("high");
    expect(values.find((v) => v.name === "MysteryParty")?.risk).toBe("high");
    // Only the "MysteryParty" share counts toward unknown exposure.
    expect(unknownResidualRaw).toBe(300n * 10n ** 18n);
  });

  it("synthesizes a single high-risk residual slice when no facilitator allocations exist but residual is positive", () => {
    const residual = 50n * 10n ** 18n;
    const { values, unknownResidualRaw } = buildGhoSlices([], [], residual);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      name: "Residual facilitators / reserve buffer",
      risk: "high",
    });
    expect(unknownResidualRaw).toBe(residual);
  });
});

describe("buildGhoRedemptionMetadata", () => {
  it("marks routeStatus open when immediateRedeemableRaw is positive and includes optional fields", () => {
    const block = buildGhoRedemptionMetadata({
      immediateRedeemableRaw: 1n,
      immediateRedeemableUsd: 42,
      immediateRedeemableRatio: 0.5,
      redemptionFeeBps: 12,
    });
    expect(block.routeStatus).toBe("open");
    expect(block.capacityUsd).toBe(42);
    expect(block.capacityRatioOfSupply).toBe(0.5);
    expect(block.feeBps).toBe(12);
    expect(block.capacityKind).toBe("live-direct");
    expect(block.freshnessKind).toBe("same-run-onchain");
    expect(block.routeStatusSource).toBe("onchain");
    expect(block.holderEligibility).toBe("any-holder");
    expect(block.settlementDelaySec).toBe(0);
    expect(block.sourceUrls).toEqual(["https://aave.com/help/gho-stablecoin/stability-module"]);
  });

  it("marks routeStatus paused when immediateRedeemableRaw is zero and omits optional fields when undefined", () => {
    const block = buildGhoRedemptionMetadata({
      immediateRedeemableRaw: 0n,
      immediateRedeemableUsd: 0,
    });
    expect(block.routeStatus).toBe("paused");
    expect("capacityRatioOfSupply" in block).toBe(false);
    expect("feeBps" in block).toBe(false);
  });
});
