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
      ["m-m0", "offchain-issuer"],
      ["usx-solstice", "stablecoin-redeem"],
      ["usda-avalon", "stablecoin-redeem"],
      ["usdai-usd-ai", "stablecoin-redeem"],
      ["nusd-neutrl", "queue-redeem"],
      ["usde-ethena", "stablecoin-redeem"],
      ["usdf-falcon", "queue-redeem"],
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
      ["frxusd-frax", "stablecoin-redeem"],
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

  it("marks reviewed lower-cap issuer routes as documented-bound", () => {
    const reviewedIssuerIds = [
      "cash-phantom",
      "mnee-mnee",
      "usdp-paxos",
      "gusd-gemini",
      "xusd-straitsx",
      "xsgd-straitsx",
      "usdq-quantoz",
      "eurq-quantoz",
      "eure-monerium",
    ] as const;

    for (const id of reviewedIssuerIds) {
      const config = getRedemptionBackstopConfig(id);
      expect(config).toMatchObject({
        routeFamily: "offchain-issuer",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        reviewedAt: "2026-03-23",
      });
      expect(config?.docs?.length).toBeGreaterThan(0);
    }

    expect(getRedemptionBackstopConfig("euri-banking-circle")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("tbill-openeden")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 5 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usdcv-societe-generale-forge")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("eurcv-societe-generale-forge")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });
  });

  it("marks the second lower-cap issuer tranche as reviewed documented-bound", () => {
    const reviewedIssuerIds = [
      "usdh-native-markets",
      "fidd-fidelity",
      "usdx-hex-trust",
      "sbc-brale",
      "eurr-stablr",
      "usdr-stablr",
      "wusd-worldwide",
      "audd-novatti",
    ] as const;

    for (const id of reviewedIssuerIds) {
      const config = getRedemptionBackstopConfig(id);
      expect(config).toMatchObject({
        routeFamily: "offchain-issuer",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        reviewedAt: "2026-03-23",
      });
      expect(config?.docs?.length).toBeGreaterThan(0);
    }

    expect(getRedemptionBackstopConfig("usdh-native-markets")).toMatchObject({
      costModel: { kind: "fee-bps", feeBps: 0 },
    });

    expect(getRedemptionBackstopConfig("sbc-brale")).toMatchObject({
      costModel: { kind: "dynamic-or-unclear" },
    });

    expect(getRedemptionBackstopConfig("usdm-moneta")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("aeur-anchored-coins")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });
  });

  it("marks the third lower-cap redemption tranche as reviewed documented-bound", () => {
    const reviewedIssuerIds = [
      "thbill-theo",
      "xaum-matrixdock",
      "usdgo-osl",
      "usat-tether",
    ] as const;

    for (const id of reviewedIssuerIds) {
      const config = getRedemptionBackstopConfig(id);
      expect(config).toMatchObject({
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        reviewedAt: "2026-03-23",
      });
      expect(config?.docs?.length).toBeGreaterThan(0);
    }

    expect(getRedemptionBackstopConfig("thbill-theo")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "same-day",
      costModel: { kind: "dynamic-or-unclear" },
    });

    expect(getRedemptionBackstopConfig("xaum-matrixdock")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      costModel: { kind: "fee-bps", feeBps: 25 },
    });

    expect(getRedemptionBackstopConfig("usdgo-osl")).toMatchObject({
      routeFamily: "offchain-issuer",
      costModel: { kind: "fee-bps", feeBps: 0 },
    });

    expect(getRedemptionBackstopConfig("usat-tether")).toMatchObject({
      routeFamily: "offchain-issuer",
      costModel: { kind: "dynamic-or-unclear" },
    });

    expect(getRedemptionBackstopConfig("frxusd-frax")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });
    expect(getRedemptionBackstopConfig("frxusd-frax")?.docs?.length).toBeGreaterThan(0);
  });

  it("marks the mid-cap route-correction tranche as reviewed documented-bound", () => {
    expect(getRedemptionBackstopConfig("m-m0")).toMatchObject({
      routeFamily: "offchain-issuer",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });
    expect(getRedemptionBackstopConfig("m-m0")?.docs?.length).toBeGreaterThan(0);

    expect(getRedemptionBackstopConfig("usx-solstice")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usda-avalon")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      settlementModel: "days",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-single",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usdai-usd-ai")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("nusd-neutrl")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "queued",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-single",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    for (const id of ["usx-solstice", "usda-avalon", "usdai-usd-ai", "nusd-neutrl"] as const) {
      expect(getRedemptionBackstopConfig(id)?.docs?.length).toBeGreaterThan(0);
    }
  });

  it("models the telemetry-backed synthetic-dollar tranche with reviewed live-buffer routes", () => {
    expect(getRedemptionBackstopConfig("usde-ethena")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "immediate",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
      capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.005 },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });
    expect(getRedemptionBackstopConfig("usde-ethena")?.docs?.length).toBeGreaterThan(0);

    expect(getRedemptionBackstopConfig("usdf-falcon")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "queued",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-single",
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-03-23",
    });
    expect(getRedemptionBackstopConfig("usdf-falcon")?.docs?.length).toBeGreaterThan(0);
  });

  it("marks the remaining lower-cap docs tranche as reviewed documented-bound", () => {
    expect(getRedemptionBackstopConfig("pusd-pleasing")).toMatchObject({
      routeFamily: "offchain-issuer",
      accessModel: "issuer-api",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("pgold-pleasing")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      executionModel: "opaque",
      outputAssetType: "bluechip-collateral",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("apxusd-apyx")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    for (const id of ["pusd-pleasing", "pgold-pleasing", "apxusd-apyx"] as const) {
      expect(getRedemptionBackstopConfig(id)?.docs?.length).toBeGreaterThan(0);
    }
  });

  it("corrects Maple syrup routes onto reviewed queue redemption semantics", () => {
    for (const id of ["syrupusdc-maple", "syrupusdt-maple"] as const) {
      expect(getRedemptionBackstopConfig(id)).toMatchObject({
        routeFamily: "queue-redeem",
        accessModel: "whitelisted-onchain",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: { kind: "dynamic-or-unclear" },
        reviewedAt: "2026-03-23",
      });
      expect(getRedemptionBackstopConfig(id)?.docs?.length).toBeGreaterThan(0);
      expect(getRedemptionBackstopConfig(id)?.notes?.some((note) => note.includes("FIFO"))).toBe(true);
    }
  });

  it("marks the requested quick-win tranche as reviewed documented-bound", () => {
    expect(getRedemptionBackstopConfig("avusd-avant")).toMatchObject({
      routeFamily: "queue-redeem",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("cusd-cap")).toMatchObject({
      routeFamily: "basket-redeem",
      executionModel: "deterministic-basket",
      outputAssetType: "stable-basket",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usdu-unitas")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "same-day",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("cgusd-cygnus-finance")).toMatchObject({
      routeFamily: "queue-redeem",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 35 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("honey-berachain")).toMatchObject({
      routeFamily: "basket-redeem",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("eusd-electronic-usd")).toMatchObject({
      routeFamily: "basket-redeem",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("aid-gaib")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "whitelisted-onchain",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 10 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("ousd-origin-protocol")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 25 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usbd-bima")).toMatchObject({
      routeFamily: "collateral-redeem",
      outputAssetType: "mixed-collateral",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear", confidence: "formula" },
      reviewedAt: "2026-03-23",
    });

    for (const id of [
      "avusd-avant",
      "cusd-cap",
      "usdu-unitas",
      "cgusd-cygnus-finance",
      "honey-berachain",
      "eusd-electronic-usd",
      "aid-gaib",
      "ousd-origin-protocol",
      "usbd-bima",
    ] as const) {
      expect(getRedemptionBackstopConfig(id)?.docs?.length).toBeGreaterThan(0);
    }
  });
});
