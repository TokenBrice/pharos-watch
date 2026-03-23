import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig } from "../redemption-backstops";

describe("getRedemptionBackstopConfig", () => {
  it("models the expanded candidate batch", () => {
    const expectedRouteFamilies = [
      ["usds-sky", "psm-swap"],
      ["lisusd-lista", "psm-swap"],
      ["usdd-tron-dao-reserve", "psm-swap"],
      ["honey-berachain", "basket-redeem"],
      ["ousd-origin-protocol", "stablecoin-redeem"],
      ["eusd-electronic-usd", "basket-redeem"],
      ["usdcv-societe-generale-forge", "offchain-issuer"],
      ["eurcv-societe-generale-forge", "offchain-issuer"],
      ["aeur-anchored-coins", "offchain-issuer"],
      ["eure-monerium", "offchain-issuer"],
      ["usdr-stablr", "offchain-issuer"],
      ["eurr-stablr", "offchain-issuer"],
      ["europ-schuman", "offchain-issuer"],
      ["eurau-allunity", "offchain-issuer"],
      ["usdh-native-markets", "offchain-issuer"],
      ["fidd-fidelity", "offchain-issuer"],
      ["usdgo-osl", "offchain-issuer"],
      ["wusd-worldwide", "offchain-issuer"],
      ["sbc-brale", "offchain-issuer"],
      ["usda-anzens", "offchain-issuer"],
    ] as const;

    for (const [id, routeFamily] of expectedRouteFamilies) {
      expect(getRedemptionBackstopConfig(id)?.routeFamily).toBe(routeFamily);
    }
  });

  it("models USDS through the shared Sky LitePSM path", () => {
    const usds = getRedemptionBackstopConfig("usds-sky");
    const dai = getRedemptionBackstopConfig("dai-makerdao");

    expect(usds).toMatchObject({
      routeFamily: "psm-swap",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
      capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.33 },
      costModel: { kind: "fee-bps", feeBps: 0 },
    });
    expect(usds?.notes?.some((note) => note.includes("LitePSMWrapper-USDS-USDC"))).toBe(true);

    expect(dai).not.toBeNull();
    expect(usds?.capacityModel).toEqual(dai?.capacityModel);
  });

  it("captures candidate-specific fee and output details", () => {
    expect(getRedemptionBackstopConfig("lisusd-lista")).toMatchObject({
      routeFamily: "psm-swap",
      capacityModel: { kind: "supply-ratio", ratio: 0.15 },
      costModel: { kind: "fee-bps", feeBps: 200 },
    });

    expect(getRedemptionBackstopConfig("honey-berachain")).toMatchObject({
      routeFamily: "basket-redeem",
      outputAssetType: "stable-basket",
      executionModel: "deterministic-basket",
      costModel: { kind: "dynamic-or-unclear" },
    });

    expect(getRedemptionBackstopConfig("ousd-origin-protocol")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      outputAssetType: "stable-single",
      costModel: { kind: "fee-bps", feeBps: 25 },
    });

    expect(getRedemptionBackstopConfig("iusd-infinifi")).toMatchObject({
      routeFamily: "queue-redeem",
      capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.15 },
      costModel: { kind: "fee-bps", feeBps: 0 },
    });

    expect(getRedemptionBackstopConfig("eusd-electronic-usd")).toMatchObject({
      routeFamily: "basket-redeem",
      executionModel: "deterministic-basket",
      outputAssetType: "stable-basket",
    });
  });
});
