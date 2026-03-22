import { describe, it, expect } from "vitest";
import { adaptGhoFacilitators, type GhoFacilitatorData } from "../gho";

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
  it("produces slices from tracked GSM backing plus residual issuance", () => {
    const result = adaptGhoFacilitators(SAMPLE);
    expect(result.slices.length).toBe(3);
    const total = result.slices.reduce((sum, slice) => sum + slice.pct, 0);
    expect(total).toBe(100);

    const residual = result.slices.find((slice) => slice.name.includes("Residual"));
    expect(residual).toBeDefined();
    expect(residual?.risk).toBe("medium");
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
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]?.name).toContain("Residual");
    expect(result.slices[0]?.pct).toBe(100);
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
    expect(result.metadata?.buyFeeBpsMin).toBe(7);
    expect(result.metadata?.buyFeeBpsMax).toBe(10);
  });
});
