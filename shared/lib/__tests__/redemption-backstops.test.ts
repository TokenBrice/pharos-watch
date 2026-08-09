import { describe, expect, it } from "vitest";
import { resolveCapacitySemantics } from "../redemption-backstop-confidence";
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
      ["susdai-usd-ai", "queue-redeem"],
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
      ["chfau-allunity", "offchain-issuer"],
      ["usdh-native-markets", "offchain-issuer"],
      ["fidd-fidelity", "offchain-issuer"],
      ["usdgo-osl", "offchain-issuer"],
      ["wusd-worldwide", "offchain-issuer"],
      ["sbc-brale", "offchain-issuer"],
      ["usda-anzens", "offchain-issuer"],
      ["frxusd-frax", "stablecoin-redeem"],
      ["msusd-main-street", "stablecoin-redeem"],
      ["usp-pikudao", "queue-redeem"],
      ["pusd-plume", "offchain-issuer"],
      ["idrx-idrx", "offchain-issuer"],
      ["mxnb-juno", "offchain-issuer"],
      ["zchf-frankencoin", "stablecoin-redeem"],
      ["susd1plus-lorenzo", "queue-redeem"],
      ["witry-brix", "queue-redeem"],
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
    expect(getRedemptionBackstopConfig("usdt-tether")).toMatchObject({
      costModel: {
        kind: "dynamic-or-unclear",
        feeDescription: "0.10% with a $1,000 minimum",
        feeBpsMax: 10,
      },
      v9RouteCostTerms: { minFeeUsd: 1_000 },
      v9RouteReviewTerms: {
        minRedeemUsd: 100_000,
        settlementModel: "days",
      },
      settlementModel: "same-day",
    });

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

    const dusd = getRedemptionBackstopConfig("dusd-dialectic");
    expect(dusd).toMatchObject({
      routeFamily: "queue-redeem",
      outputAssets: ["usdc-circle"],
      accessModel: "whitelisted-onchain",
      holderEligibility: "issuer-discretionary",
      settlementModel: "queued",
      executionModel: "opaque",
      capacityModel: {
        kind: "reserve-sync-metadata",
        liveCapacityConfidence: "documented-bound",
        basis: "live-proxy-buffer",
      },
      costModel: { kind: "fee-bps", feeBps: 0 },
      routeStatus: "open",
      routeExitCorrelation: "same-protocol-liquidity",
      reviewedAt: "2026-07-30",
    });
    expect(dusd?.capacityModel).not.toMatchObject({ fallbackRatio: expect.any(Number) });
    expect(dusd?.docs?.find((source) => source.label === "DUSD AsyncRedeemer verified source")).toMatchObject({
      supports: expect.arrayContaining(["fees"]),
    });
    expect(dusd?.docs?.find((source) => source.label === "DUSD Machine Terms")?.supports).not.toContain("fees");
    const dusdNotes = dusd?.notes?.join(" ") ?? "";
    expect(dusdNotes).toContain("no contractual queue priority");
    expect(dusdNotes).toContain("no perpetual zero-fee covenant");
    expect(dusdNotes).toContain("not a contractual redemption right");
    expect(dusdNotes).toContain("remain unfilled indefinitely");
    expect(dusdNotes).toContain("U.S. persons");
    expect(dusdNotes).toContain("EU/EEA-originating transactions may be refused");
    expect(dusdNotes).toContain("cease the Machine without notice");

    expect(getRedemptionBackstopConfig("susd1plus-lorenzo")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "days",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-single",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-05-17",
    });

    expect(getRedemptionBackstopConfig("witry-brix")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "days",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-single",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-05-17",
    });

    expect(getRedemptionBackstopConfig("bold-liquity")).toMatchObject({
      routeFamily: "collateral-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "bluechip-collateral",
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "dynamic-or-unclear", confidence: "formula" },
      reviewedAt: "2026-03-22",
    });

    expect(getRedemptionBackstopConfig("fpi-frax")).toMatchObject({
      routeFamily: "collateral-redeem",
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "dynamic-or-unclear" },
    });

    expect(getRedemptionBackstopConfig("lusd-liquity")).toMatchObject({
      routeFamily: "collateral-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "bluechip-collateral",
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "dynamic-or-unclear", confidence: "formula" },
      reviewedAt: "2026-03-22",
    });

    expect(getRedemptionBackstopConfig("msusd-main-street")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "days",
      executionModel: "rules-based-nav",
      capacityModel: { kind: "supply-ratio", ratio: 0.2, confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("eusd-electronic-usd")).toMatchObject({
      routeFamily: "basket-redeem",
      executionModel: "deterministic-basket",
      outputAssetType: "stable-basket",
    });

    expect(getRedemptionBackstopConfig("zchf-frankencoin")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
      capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.0085 },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-05-25",
    });

    for (const id of ["susd1plus-lorenzo", "witry-brix"] as const) {
      const config = getRedemptionBackstopConfig(id);
      expect(config?.docs?.length).toBeGreaterThanOrEqual(3);
      expect(resolveCapacitySemantics(config!.capacityModel)).toBe("eventual-only");
    }
  });

  it("promotes reviewed stable-buffer routes out of the heuristic bucket", () => {
    expect(getRedemptionBackstopConfig("usdd-tron-dao-reserve")).toMatchObject({
      routeFamily: "psm-swap",
      capacityModel: { kind: "supply-ratio", ratio: 0.16, confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("lisusd-lista")).toMatchObject({
      routeFamily: "psm-swap",
      capacityModel: { kind: "supply-ratio", ratio: 0.15, confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 200 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("reusd-re-protocol")).toMatchObject({
      routeFamily: "queue-redeem",
      capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.2, confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usr-resolv")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usdf-astherus")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 10 },
      reviewedAt: "2026-05-14",
    });

    expect(getRedemptionBackstopConfig("dusd-standx")).toMatchObject({
      routeFamily: "offchain-issuer",
      capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usp-pikudao")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "days",
      capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 20 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("buck-bucket-protocol")).toMatchObject({
      routeFamily: "psm-swap",
      outputAssetType: "stable-basket",
      outputAssets: ["usdc-circle", "usdt-tether"],
      capacityModel: { kind: "supply-ratio", ratio: 0.25, confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 30 },
      reviewedAt: "2026-07-14",
    });

    expect(getRedemptionBackstopConfig("fxusd-f-x-protocol")).toMatchObject({
      routeFamily: "collateral-redeem",
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "fee-bps", feeBps: 50 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("fxsave-f-x-protocol")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-single",
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "dynamic-or-unclear", confidence: "formula", feeModelKind: "formula" },
      reviewedAt: "2026-05-27",
    });
    expect(getRedemptionBackstopConfig("fxsave-f-x-protocol")?.notes?.[0]).toContain("idle fxSP balance");
  });

  it("promotes the next non-top-100 tranche to reviewed medium-confidence routes", () => {
    // cUSD/cEUR retain the 2026-07-09 live broker-pool capacity model; their
    // concrete stable outputs were reconciled against those pools on 2026-07-15.
    expect(getRedemptionBackstopConfig("cusd-celo")).toMatchObject({
      routeFamily: "collateral-redeem",
      outputAssetType: "stable-basket",
      outputAssets: ["usdc-circle", "usdt-tether"],
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-07-15",
    });

    expect(getRedemptionBackstopConfig("ceur-celo")).toMatchObject({
      routeFamily: "collateral-redeem",
      outputAssetType: "stable-single",
      outputAssets: ["cusd-celo"],
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-07-15",
    });

    expect(getRedemptionBackstopConfig("xofm-mento")).toMatchObject({
      routeFamily: "psm-swap",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
      outputAssets: ["cusd-celo"],
      capacityModel: { kind: "reserve-sync-metadata", basis: "live-direct-telemetry" },
      costModel: { kind: "dynamic-or-unclear", confidence: "formula", feeModelKind: "formula" },
      reviewedAt: "2026-07-27",
    });
    expect(getRedemptionBackstopConfig("xofm-mento")?.notes?.[1]).toContain("BiPoolManager");

    expect(getRedemptionBackstopConfig("alusd-alchemix")).toMatchObject({
      routeFamily: "queue-redeem",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("aznd-mu-digital")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usda-anzens")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("pusd-plume")).toMatchObject({
      routeFamily: "offchain-issuer",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-03-23",
    });
  });

  it("keeps explicitly unmodeled protocol routes unmodeled", () => {
    expect(getRedemptionBackstopConfig("hollar-hydrated")).toBeNull();
    expect(getRedemptionBackstopConfig("frax-frax")).toBeNull();
  });

  it("promotes the remaining issuer-style tranche to reviewed documented-bound", () => {
    const reviewedIssuerIds = [
      "eurs-stasis",
      "gyen-gyen",
      "cadc-cad-coin",
      "vchf-vnx",
      "vgbp-vnx",
      "tryb-bilira",
      "tgbp-tokenised",
      "jpyc-jpyc",
      "axcnh-anchorx",
      "idrt-rupiah-token",
      "europ-schuman",
      "eurau-allunity",
      "chfau-allunity",
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

    expect(getRedemptionBackstopConfig("tgbp-tokenised")).toMatchObject({
      settlementModel: "days",
    });
  });

  it("models the newly reviewed MXNB and IDRX issuer-api rails with current source-backed constraints", () => {
    expect(getRedemptionBackstopConfig("idrx-idrx")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "same-day",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-04-03",
    });
    expect(getRedemptionBackstopConfig("idrx-idrx")?.docs?.length).toBeGreaterThanOrEqual(3);

    expect(getRedemptionBackstopConfig("mxnb-juno")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "same-day",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-04-03",
    });
    expect(getRedemptionBackstopConfig("mxnb-juno")?.docs?.length).toBeGreaterThanOrEqual(2);
  });

  it("promotes FPI to a reviewed collateral-redemption route", () => {
    expect(getRedemptionBackstopConfig("fpi-frax")).toMatchObject({
      routeFamily: "collateral-redeem",
      outputAssetType: "mixed-collateral",
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });
  });

  it("marks reviewed lower-cap issuer routes as documented-bound", () => {
    const reviewedIssuerIds = [
      "cash-phantom",
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

    const documentedHotBufferIssuerIds = ["pyusd-paypal", "usdp-paxos", "usdg-paxos", "gusd-gemini"] as const;

    for (const id of documentedHotBufferIssuerIds) {
      const config = getRedemptionBackstopConfig(id);
      expect(config).toMatchObject({
        routeFamily: "offchain-issuer",
        capacityModel: { kind: "supply-ratio", ratio: 0.25, confidence: "documented-bound", basis: "hot-buffer" },
        reviewedAt: "2026-06-10",
      });
      expect(config?.docs?.length).toBeGreaterThanOrEqual(2);
    }

    expect(getRedemptionBackstopConfig("euri-banking-circle")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usdo-openeden")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "same-day",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 10 },
      reviewedAt: "2026-06-25",
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
    const reviewedIssuerIds = ["thbill-theo", "xaum-matrixdock", "usdgo-osl", "usat-tether"] as const;

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
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });
    expect(getRedemptionBackstopConfig("frxusd-frax")?.docs?.length).toBeGreaterThan(0);
  });

  it("uses live Superstate liquidity for USTB redemption capacity", () => {
    expect(getRedemptionBackstopConfig("ustb-superstate")).toMatchObject({
      routeFamily: "offchain-issuer",
      accessModel: "issuer-api",
      settlementModel: "same-day",
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-04-15",
    });
    expect(getRedemptionBackstopConfig("ustb-superstate")?.docs?.length).toBeGreaterThan(0);
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
      reviewedAt: "2026-07-19",
    });

    expect(getRedemptionBackstopConfig("susdai-usd-ai")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "queued",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-single",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-04-04",
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

    for (const id of ["usx-solstice", "usda-avalon", "usdai-usd-ai", "susdai-usd-ai", "nusd-neutrl"] as const) {
      expect(getRedemptionBackstopConfig(id)?.docs?.length).toBeGreaterThan(0);
    }
  });

  it("models the telemetry-backed synthetic-dollar tranche with reviewed live-buffer routes", () => {
    expect(getRedemptionBackstopConfig("usde-ethena")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "immediate",
      executionModel: "deterministic-onchain",
      // Ethena's API docs list both USDT/USDe and USDC/USDe redeem pairs.
      outputAssetType: "stable-basket",
      outputAssets: ["usdt-tether", "usdc-circle"],
      capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.005 },
      costModel: { kind: "fee-bps", feeBps: 10 },
      reviewedAt: "2026-03-23",
    });
    expect(getRedemptionBackstopConfig("usde-ethena")?.docs?.length).toBeGreaterThan(0);

    expect(getRedemptionBackstopConfig("usdf-falcon")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "queued",
      executionModel: "rules-based-nav",
      // Falcon docs: redeem USDf for the original deposits (USDT, USDC, or FDUSD) 1:1.
      outputAssetType: "stable-basket",
      outputAssets: ["usdt-tether", "usdc-circle", "fdusd-first-digital"],
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-03-23",
    });
    expect(getRedemptionBackstopConfig("usdf-falcon")?.docs?.length).toBeGreaterThan(0);
  });

  it("marks the remaining lower-cap docs tranche as reviewed documented-bound", () => {
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

    for (const id of ["pgold-pleasing", "apxusd-apyx"] as const) {
      expect(getRedemptionBackstopConfig(id)?.docs?.length).toBeGreaterThan(0);
    }
  });

  it("corrects Maple syrup routes onto reviewed queue redemption semantics", () => {
    expect(getRedemptionBackstopConfig("syrupusdc-maple")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "queued",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-single",
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("syrupusdc-maple")?.docs?.length).toBeGreaterThan(0);

    for (const id of ["syrupusdt-maple"] as const) {
      expect(getRedemptionBackstopConfig(id)).toMatchObject({
        routeFamily: "queue-redeem",
        accessModel: "whitelisted-onchain",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 0 },
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
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usdu-unitas")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "whitelisted-onchain",
      settlementModel: "same-day",
      outputAssetType: "mixed-collateral",
      capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-07-19",
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
      outputAssets: ["usdc-circle"],
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 10 },
      reviewedAt: "2026-07-14",
    });

    expect(getRedemptionBackstopConfig("ousd-origin-protocol")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      capacityModel: { kind: "reserve-sync-metadata" },
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

  it("upgrades the moderate-effort reviewed queue out of heuristic redemption semantics", () => {
    expect(getRedemptionBackstopConfig("dola-inverse-finance")).toMatchObject({
      routeFamily: "psm-swap",
      capacityModel: { kind: "supply-ratio", ratio: 0.08, confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 20 },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("rwausdi-multipli")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("mtbill-midas")).toMatchObject({
      routeFamily: "offchain-issuer",
      settlementModel: "days",
      capacityModel: { kind: "supply-ratio", ratio: 0.02, confidence: "documented-bound", basis: "hot-buffer" },
      costModel: { kind: "fee-bps", feeBps: 7 },
      reviewedAt: "2026-05-17",
    });

    expect(getRedemptionBackstopConfig("musd-metamask")).toMatchObject({
      routeFamily: "offchain-issuer",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usdn-noble")).toMatchObject({
      routeFamily: "offchain-issuer",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("yusd-aegis")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "whitelisted-onchain",
      capacityModel: { kind: "supply-ratio", ratio: 0.15 },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("usn-noon")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "whitelisted-onchain",
      capacityModel: { kind: "supply-ratio", ratio: 0.15 },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("uty-xsy")).toMatchObject({
      routeFamily: "queue-redeem",
      settlementModel: "days",
      capacityModel: { kind: "supply-ratio", ratio: 0.3 },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("yzusd-yuzu")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "issuer-api",
      settlementModel: "days",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "dynamic-or-unclear" },
      reviewedAt: "2026-03-23",
    });

    expect(getRedemptionBackstopConfig("jupusd-jupiter")).toMatchObject({
      routeFamily: "stablecoin-redeem",
      accessModel: "whitelisted-onchain",
      capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.1, confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 4 },
      reviewedAt: "2026-03-23",
    });

    for (const id of [
      "dola-inverse-finance",
      "rwausdi-multipli",
      "mtbill-midas",
      "musd-metamask",
      "usdn-noble",
      "yusd-aegis",
      "usn-noon",
      "uty-xsy",
      "yzusd-yuzu",
      "jupusd-jupiter",
    ] as const) {
      expect(getRedemptionBackstopConfig(id)?.docs?.length).toBeGreaterThan(0);
    }
  });

  it("adds conservative source-reviewed queued coverage for Phase 4 candidates", () => {
    expect(getRedemptionBackstopConfig("stkgho-umbrella-aave")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "queued",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-single",
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-05-10",
    });

    expect(getRedemptionBackstopConfig("usdrif-rif")).toMatchObject({
      routeFamily: "queue-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "queued",
      executionModel: "rules-based-nav",
      outputAssetType: "mixed-collateral",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: { kind: "fee-bps", feeBps: 25 },
      reviewedAt: "2026-05-10",
    });

    for (const id of ["stkgho-umbrella-aave", "usdrif-rif"] as const) {
      expect(getRedemptionBackstopConfig(id)?.docs?.length).toBeGreaterThan(0);
    }
    // stkGHO now reads live ERC-4626 idle-balance telemetry as a current
    // bounded buffer; only usdrif remains a documented eventual-only route.
    expect(resolveCapacitySemantics(getRedemptionBackstopConfig("stkgho-umbrella-aave")!.capacityModel)).toBe(
      "immediate-bounded",
    );
    expect(resolveCapacitySemantics(getRedemptionBackstopConfig("usdrif-rif")!.capacityModel)).toBe("eventual-only");
  });

  it("records the sourced redemption-tail output rulings without resolving incomplete baskets", () => {
    const nestOutputs = new Map([
      ["ntbill-nest", ["usdc-circle", "pusd-plume"]],
      ["nbasis-nest", ["usdc-circle", "pusd-plume"]],
      ["nopal-nest", ["usdc-circle", "pusd-plume", "usdt-tether"]],
      ["nwisdom-nest", ["usdc-circle", "pusd-plume"]],
    ] as const);
    for (const [id, outputAssets] of nestOutputs) {
      expect(getRedemptionBackstopConfig(id)).toMatchObject({
        routeFamily: "queue-redeem",
        settlementModel: "days",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-basket",
        outputAssets,
        reviewedAt: "2026-07-15",
      });
    }

    expect(getRedemptionBackstopConfig("ussd-sonic-labs")).toMatchObject({
      outputAssetType: "stable-single",
      outputAssets: ["frxusd-frax"],
      costModel: { kind: "fee-bps", feeBps: 0 },
      reviewedAt: "2026-07-15",
    });
    expect(getRedemptionBackstopConfig("ftusd-flying-tulip")).toMatchObject({
      outputAssetType: "stable-basket",
      outputAssets: ["usdc-circle", "usdt-tether"],
      reviewedAt: "2026-08-09",
    });
    expect(getRedemptionBackstopConfig("hyusd-hylo")).toMatchObject({
      routeStatus: "unknown",
      outputAssetType: "mixed-collateral",
      reviewedAt: "2026-07-15",
    });
    expect(getRedemptionBackstopConfig("hyusd-hylo")?.outputAssets).toBeUndefined();

    const dusd = getRedemptionBackstopConfig("dusd-dtrinity");
    expect(dusd).toMatchObject({ outputAssetType: "stable-basket", reviewedAt: "2026-07-27" });
    expect(dusd?.outputAssets).toBeUndefined();
    expect(dusd?.unresolvedOutputDisposition).toBe("reviewed-external");
    expect(dusd?.unresolvedOutputAssetKeys).toEqual([
      "usdc-circle",
      "usdt-tether",
      "usds-sky",
      "susds-sky",
      "frxusd-frax",
      "sfrxusd-frax",
      "dai-makerdao",
      "sdai-sky",
      "asset:vbusdc",
      "asset:vbusdt",
      "ausd-agora",
    ]);
    expect(dusd?.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("11 symbols"),
        expect.stringContaining("unresolvedOutputAssetKeys"),
      ]),
    );
  });

  it("records the 2026-07-19 output-asset wave over newly tracked or newly documented outputs", () => {
    for (const id of [
      "audm-mento",
      "brlm-mento",
      "cadm-mento",
      "chfm-mento",
      "copm-mento",
      "ghsm-mento",
      "kesm-mento",
      "zarm-mento",
    ] as const) {
      expect(getRedemptionBackstopConfig(id)).toMatchObject({
        outputAssetType: "stable-single",
        outputAssets: ["cusd-celo"],
        reviewedAt: "2026-07-19",
      });
    }

    expect(getRedemptionBackstopConfig("usdai-usd-ai")).toMatchObject({
      outputAssetType: "stable-single",
      outputAssets: ["pyusd-paypal"],
      reviewedAt: "2026-07-19",
    });
    expect(getRedemptionBackstopConfig("u-united-stables")).toMatchObject({
      outputAssetType: "stable-basket",
      outputAssets: ["usdc-circle", "usdt-tether", "usd1-world-liberty-financial"],
      reviewedAt: "2026-07-19",
    });
    expect(getRedemptionBackstopConfig("inalpha-nest")).toMatchObject({
      outputAssetType: "stable-basket",
      outputAssets: ["usdc-circle", "pusd-plume"],
      reviewedAt: "2026-07-19",
    });
    expect(getRedemptionBackstopConfig("said-gaib")).toMatchObject({
      outputAssetType: "stable-single",
      outputAssets: ["aid-gaib"],
      reviewedAt: "2026-07-19",
    });
    expect(getRedemptionBackstopConfig("acred-apollo-securitize")).toMatchObject({
      outputAssetType: "stable-basket",
      outputAssets: ["usdc-circle", "usdg-paxos"],
      reviewedAt: "2026-07-19",
    });
    expect(getRedemptionBackstopConfig("usdu-unitas")).toMatchObject({
      outputAssetType: "mixed-collateral",
      outputAssets: ["asset:sol", "asset:btc", "asset:eth"],
      reviewedAt: "2026-07-19",
    });
    expect(getRedemptionBackstopConfig("eur0-usual")).toMatchObject({
      outputAssetType: "mixed-collateral",
      outputAssets: ["asset:eutbl"],
      reviewedAt: "2026-07-19",
    });
    expect(getRedemptionBackstopConfig("silk-shade-protocol")).toMatchObject({
      outputAssetType: "mixed-collateral",
      outputAssets: ["asset:sscrt", "asset:wbtc", "asset:usdc"],
      reviewedAt: "2026-07-19",
    });
    expect(getRedemptionBackstopConfig("usdp-parallel")).toMatchObject({
      outputAssetType: "mixed-collateral",
      outputAssets: [
        "asset:frxusd",
        "asset:sfrxusd",
        "asset:usde",
        "asset:susde",
        "asset:usds",
        "asset:susds",
        "asset:usdc",
        "asset:ygamiusdc",
      ],
      reviewedAt: "2026-07-19",
    });
    expect(getRedemptionBackstopConfig("reusd-resupply")).toMatchObject({
      outputAssetType: "mixed-collateral",
      outputAssets: ["asset:crvusd", "asset:frxusd"],
      reviewedAt: "2026-07-19",
    });
    expect(getRedemptionBackstopConfig("satusd-river")).toMatchObject({
      outputAssetType: "bluechip-collateral",
      outputAssets: ["asset:btc", "asset:eth", "asset:bnb"],
      reviewedAt: "2026-07-19",
    });

    // Durable withholdings from the 2026-07-15 EXIT_OUTPUT waves remain
    // unresolved: no documented payout asset, untracked output, or no fixed
    // documented output set.
    for (const id of [
      "aznd-mu-digital",
      "witry-brix",
      "dllr-sovryn",
      "deuro-deuro",
      "nect-beraborrow",
    ] as const) {
      expect(getRedemptionBackstopConfig(id)?.outputAssets).toBeUndefined();
    }
    // scusd-rings graduated on the 2026-07-27 wave-7 review: the archived
    // issuer tutorial establishes the conservative USDC/USDT/DAI redeem set
    // (GHO/USDS stay excluded pending primary confirmation).
    expect(getRedemptionBackstopConfig("scusd-rings")).toMatchObject({
      outputAssetType: "stable-basket",
      outputAssets: ["usdc-circle", "usdt-tether", "dai-makerdao"],
      reviewedAt: "2026-07-27",
    });

    expect(getRedemptionBackstopConfig("zys-zephyr-protocol")).toMatchObject({
      outputAssetType: "stable-single",
      outputAssets: ["zsd-zephyr-protocol"],
    });
    expect(getRedemptionBackstopConfig("dllr-sovryn")?.unresolvedOutputAssetKeys).toEqual([
      "asset:zusd",
      "doc-money-on-chain",
    ]);
    expect(getRedemptionBackstopConfig("dllr-sovryn")?.unresolvedOutputDisposition).toBe("reviewed-external");
    expect(getRedemptionBackstopConfig("witry-brix")?.unresolvedOutputAssetKeys).toEqual([
      "asset:itry",
    ]);
    expect(getRedemptionBackstopConfig("witry-brix")?.unresolvedOutputDisposition).toBe("reviewed-external");
    expect(getRedemptionBackstopConfig("aznd-mu-digital")?.unresolvedOutputAssetKeys).toBeUndefined();
    expect(getRedemptionBackstopConfig("aznd-mu-digital")?.unresolvedOutputDisposition).toBe(
      "issuer-undisclosed",
    );

    expect(getRedemptionBackstopConfig("eearn-ember")).toMatchObject({
      outputAssets: ["usdc-circle"],
      capacityModel: {
        kind: "reserve-sync-metadata",
        basis: "live-direct-telemetry",
      },
      v9RouteReviewTerms: { settlementModel: "queued" },
    });
    expect(getRedemptionBackstopConfig("sdusd-dtrinity")).toMatchObject({
      outputAssets: ["dusd-dtrinity"],
      capacityModel: { kind: "reserve-sync-metadata" },
    });
  });
});
