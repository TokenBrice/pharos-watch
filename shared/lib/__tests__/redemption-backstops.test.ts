import { describe, expect, it } from "vitest";
import { resolveCapacitySemantics } from "../redemption-backstop-confidence";
import { getRedemptionBackstopConfig } from "../redemption-backstops";

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
      missingScoringFields: ["settlement"],
    });
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
