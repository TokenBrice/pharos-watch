import { describe, expect, it } from "vitest";
import { resolveCapacitySemantics } from "../redemption-backstop-confidence";
import { getRedemptionBackstopConfig, resolveV9RedemptionRouteCostBpsAtNotional } from "../redemption-backstops";
import { resolveDefaultHolderEligibility } from "../redemption-backstop-configs/shared";

describe("getRedemptionBackstopConfig", () => {
  it("shares the Sky LitePSM capacity model across USDS and DAI", () => {
    const usds = getRedemptionBackstopConfig("usds-sky");
    const dai = getRedemptionBackstopConfig("dai-makerdao");

    expect(usds).not.toBeNull();
    expect(dai).not.toBeNull();
    expect(usds?.capacityModel).toEqual(dai?.capacityModel);
  });

  it.each(["frax-frax", "mai-qidao"])("keeps the explicitly unmodeled %s route absent", (id) => {
    expect(getRedemptionBackstopConfig(id)).toBeNull();
  });

  it("keeps Lido earnUSD queue terms without invented capacity, settlement or fee bounds", () => {
    const config = getRedemptionBackstopConfig("earnusd-lido");
    expect(config?.outputAssets).toEqual(["usdc-circle"]);
    expect(resolveCapacitySemantics(config!.capacityModel)).toBe("eventual-only");
    expect(config?.settlementModel).toBe("queued");
    expect(config?.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
    expect(config?.v9RouteReviewTerms).not.toHaveProperty("settlementDelaySec");
    expect(config?.costModel).toMatchObject({ confidence: "formula", feeModelKind: "formula" });
    expect(config?.costModel).not.toHaveProperty("feeBps");
    expect(config?.costModel).not.toHaveProperty("feeBpsMax");
  });

  it.each(["usdm-monetrix", "susdat-saturn"])(
    "does not promote %s queue diagnostics into immediate capacity, completion or all-in costs",
    (id) => {
      const config = getRedemptionBackstopConfig(id)!;
      expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
      expect(config.capacityModel).not.toHaveProperty("fallbackRatio");
      expect(config.capacityModel).not.toHaveProperty("ratio");
      expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
      expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
    },
  );

  it("does not turn migrated USDat backing into USDC redemption capacity or a cost bound", () => {
    const config = getRedemptionBackstopConfig("usdat-saturn")!;
    expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
    expect(config.outputAssets).toEqual(["usdc-circle"]);
    expect(config.holderEligibility ?? resolveDefaultHolderEligibility(config)).toBe("whitelisted-primary");
    expect(config.capacityModel).not.toHaveProperty("ratio");
    expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
  });

  it.each(["susdai-usd-ai", "reusd-re-protocol"])(
    "keeps %s variable pricing and conditional queue terms unbounded at every tested notional",
    (id) => {
      const config = getRedemptionBackstopConfig(id)!;
      expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(["cost", "settlement"]);
      expect(config.settlementModel).toBe("queued");
      expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
      for (const notional of [1_000, 1_000_000, 25_000_000]) {
        expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBeNull();
      }
    },
  );

  it("does not promote Maple FAQ timing into a guaranteed completion bound", () => {
    const config = getRedemptionBackstopConfig("syrupusdc-maple")!;
    expect(config.settlementModel).toBe("queued");
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.v9RouteReviewTerms?.businessDayTerms).toBeUndefined();
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBe(0);
  });

  it("does not expose a cash redemption route for non-refundable JPYC Prepaid v1", () => {
    expect(getRedemptionBackstopConfig("jpyc-jpyc-v1")).toBeNull();
  });

  it("redeems the Curve savings wrapper into crvUSD rather than its market pool's other token", () => {
    expect(getRedemptionBackstopConfig("scrvusd-curve")?.outputAssets).toEqual(["crvusd-curve"]);
  });

  it("keeps Apyx USDC output separate from its unproven settlement bound", () => {
    const config = getRedemptionBackstopConfig("apxusd-apyx");

    expect(config?.outputAssetType).toBe("stable-single");
    expect(config?.outputAssets).toEqual(["usdc-circle"]);
    expect(config?.executionModel).toBe("rules-based-nav");
    expect(config?.v9RouteReviewTerms).toMatchObject({
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["settlement", "cost"],
    });
  });

  it("retires JuiceDollar's operational route without treating shutdown as a live suspended channel", () => {
    expect(getRedemptionBackstopConfig("jusd-juicedollar")).toBeNull();
  });

  it("leaves eEARN withdrawal costs unavailable until an admitted validator quote arrives", () => {
    const config = getRedemptionBackstopConfig("eearn-ember")!;
    expect(config.v9RouteReviewTerms?.settlementModel).toBe("queued");
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    for (const notional of [1_000, 1_000_000, 25_000_000]) {
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBeNull();
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional, 5)).toBe(5);
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional, 0)).toBe(0);
    }
  });

  it.each([
    ["apxusd-apyx", "usdc-circle"],
    ["usx-solstice", "usdg-paxos"],
    ["usda-avalon", "usdt-tether"],
  ])("does not invent a %s cost ceiling from payout identity or processing terms", (id, output) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.outputAssets).toEqual([output]);
    for (const notional of [1_000, 1_000_000, 25_000_000]) {
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBeNull();
    }
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    if (id !== "usx-solstice") {
      expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(expect.arrayContaining(["cost", "settlement"]));
    }
  });

  it.each(["frxusd-frax", "sfrxusd-frax", "usdz-anzen"])(
    "keeps %s public mutable fee formulas separate from numeric all-in costs",
    (id) => {
      const config = getRedemptionBackstopConfig(id);
      expect(config?.costModel).toMatchObject({
        kind: "dynamic-or-unclear",
        confidence: "formula",
        feeModelKind: "formula",
      });
      expect(config?.costModel).not.toHaveProperty("feeBps");
      expect(config?.costModel).not.toHaveProperty("feeBpsMax");
      expect(config?.v9RouteCostTerms).toBeUndefined();
      expect(config?.capacityModel).toMatchObject({ kind: "reserve-sync-metadata" });
    },
  );

  it("keeps syrupUSDG's zero native fee separate from unbounded queue completion", () => {
    const config = getRedemptionBackstopConfig("syrupusdg-maple");
    expect(config?.costModel).toMatchObject({ kind: "fee-bps", feeBps: 0, confidence: "fixed" });
    expect(config?.costModel.feeDescription).toContain("gas, wallet and third-party charges");
    expect(config?.v9RouteReviewTerms).toMatchObject({
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement"],
    });
    expect(config?.v9RouteReviewTerms).not.toHaveProperty("settlementDelaySec");
    expect(config?.outputAssets).toEqual(["usdg-paxos"]);
    expect(config?.capacityModel).toEqual({ kind: "reserve-sync-metadata" });
  });

  it("records ACRDX's issuer-only zero without changing queued NAV redemption", () => {
    const config = getRedemptionBackstopConfig("acrdx-anemoy-apollo");
    expect(config?.costModel).toMatchObject({ kind: "fee-bps", feeBps: 0, confidence: "fixed" });
    expect(config?.costModel.feeDescription).toContain("issuer entry/exit fee only");
    expect(config?.settlementModel).toBe("queued");
    expect(config?.outputAssetType).toBe("nav");
    expect(config?.docs).toContainEqual(expect.objectContaining({
      url: "https://centrifuge-files.mypinata.cloud/ipfs/bafkreigpp4zkwecojcuipjnzyclrfgzaqe6tu5vedvujw6u73c3xfwbx5m",
      supports: ["route", "fees"],
    }));
  });

  it.each([
    ["tryb-bilira", "bank-transfer leg"],
    ["avusd-avant", "0.05% (5 bps)"],
  ])("keeps %s partial fee disclosures without a route-wide numerical ceiling", (id, disclosure) => {
    const config = getRedemptionBackstopConfig(id);
    expect(config?.costModel).toMatchObject({
      kind: "dynamic-or-unclear",
      feeModelKind: "documented-variable",
    });
    expect(config?.costModel.feeDescription).toContain(disclosure);
    expect(config?.costModel).not.toHaveProperty("feeBps");
    expect(config?.costModel).not.toHaveProperty("feeBpsMax");
    expect(config?.v9RouteCostTerms).toBeUndefined();
  });

  it("keeps UTY's verified Base USDC payout separate from unbounded redemption terms", () => {
    const config = getRedemptionBackstopConfig("uty-xsy");

    expect(config?.outputAssetType).toBe("stable-single");
    expect(config?.outputAssets).toEqual(["usdc-circle"]);
    expect(config?.unresolvedOutputAssetKeys).toBeUndefined();
    expect(config?.v9RouteReviewTerms).toMatchObject({
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
    });
  });


  it("excludes USDA from Indigo's current complete PSM payout set", () => {
    expect(getRedemptionBackstopConfig("iusd-indigo-protocol")?.outputAssets).toEqual([
      "usdm-moneta",
      "usdc-circle",
    ]);
  });

  it.each([
    ["stkgho-umbrella-aave", "immediate-bounded"],
    ["usdrif-rif", "eventual-only"],
    ["susd1plus-lorenzo", "eventual-only"],
    ["witry-brix", "eventual-only"],
  ] as const)("resolves %s capacity as %s", (id, expected) => {
    const config = getRedemptionBackstopConfig(id);
    expect(config).not.toBeNull();
    expect(resolveCapacitySemantics(config!.capacityModel)).toBe(expected);
  });

  it.each([
    "hyusd-hylo",
    "dusd-dtrinity",
    "u-united-stables",
    "silk-shade-protocol",
    "satusd-river",
    "witry-brix",
    "dllr-sovryn",
    "deuro-deuro",
    "nect-beraborrow",
  ])("withholds unresolved output assets for %s", (id) => {
    const config = getRedemptionBackstopConfig(id);
    expect(config).not.toBeNull();
    expect(config?.outputAssets).toBeUndefined();
  });
});
