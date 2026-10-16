import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig, resolveV9RedemptionRouteCostBpsAtNotional } from "../redemption-backstops";
import { RedemptionBackstopConfigSchema } from "../redemption-backstop-configs/schema";
import { cloneRedemptionBackstopConfig, resolveDefaultHolderEligibility } from "../redemption-backstop-configs/shared";
import { resolveCapacitySemantics } from "../redemption-backstop-confidence";

describe("wave-3 redemption handoff uptake", () => {
  it.each([
    { kind: "unquantified", amountUsd: 0 },
    { kind: "unquantified", fallbackRatio: 0.1 },
    { kind: "unquantified", eventualCapacityModel: "supply-full" },
    { kind: "unquantified", confidence: "documented-bound" },
  ])("rejects fabricated quantity/confidence in an unquantified route (%j)", (capacityModel) => {
    expect(RedemptionBackstopConfigSchema.safeParse({
      ...getRedemptionBackstopConfig("susdat-saturn")!,
      capacityModel,
    }).success).toBe(false);
  });

  it.each(["xgld-unitas", "susdat-saturn", "susdx-axis", "witry-brix"])("does not turn %s cooldown or servicing into a completion SLA or static capacity", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.settlementModel).toBe("queued");
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
    expect(config.capacityModel).not.toHaveProperty("fallbackRatio");
    expect(config.capacityModel).not.toHaveProperty("eventualCapacityModel");
  });

  it("keeps HBD all-in payout cost and completed conversion settlement unquantified", () => {
    const config = getRedemptionBackstopConfig("hbd-hive")!;
    expect(config.costModel).toMatchObject({ kind: "dynamic-or-unclear", confidence: "formula", feeModelKind: "formula" });
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.v9RouteReviewTerms?.missingScoringFields).toContain("settlement");
  });

  it("keeps XGLD's XAUt collateral fee separate from physical delivery or USD par", () => {
    const config = getRedemptionBackstopConfig("xgld-unitas")!;
    expect(config.outputAssets).toEqual(["xaut-tether"]);
    expect(config.holderEligibility).toBe("whitelisted-primary");
    expect(config.physicalCommodityDelivery).toBeUndefined();
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBe(10);
  });

  it.each(["dllr-sovryn", "srusde-strata", "gldy-streamex"])("retains %s alternatives unresolved without equal-weight basket or final SLA", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.outputAssets).toBeUndefined();
    expect(config.outputAssetType).not.toBe("stable-basket");
    expect(config.unresolvedOutputDisposition).toBe("reviewed-external");
    expect(config.unresolvedOutputAssetKeys!.length).toBeGreaterThan(1);
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
  });

  it("allows the srUSDe any-holder cohort without relaxing branch-specific output or fee terms", () => {
    const config = getRedemptionBackstopConfig("srusde-strata")!;
    expect(config.accessModel).toBe("permissionless-onchain");
    expect(config.holderEligibility ?? resolveDefaultHolderEligibility(config)).toBe("any-holder");
    expect(config.settlementModel).toBe("queued");
    expect(config.totalScoreCap).toBe(65);
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBe(2.5);
    expect(config.capacityModel).toMatchObject({
      requiredOutputAssetKeys: ["usde-ethena", "susde-ethena"],
    });
    expect(RedemptionBackstopConfigSchema.safeParse({
      ...config,
      capacityModel: { kind: "reserve-sync-metadata", requiredOutputAssetKeys: ["usdc-circle"] },
    }).success).toBe(false);
  });

  it("does not copy V3 mutable transmutation fees into the legacy DAI route", () => {
    const config = getRedemptionBackstopConfig("alusd-alchemix")!;
    expect(config.outputAssets).toEqual(["dai-makerdao"]);
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
  });

  it.each([["m-m0"], ["wm-m0", "wm-m0"]])("rejects an incompatible output-bound capacity certificate (%j)", (...requiredOutputAssetKeys) => {
    const config = getRedemptionBackstopConfig("usdr-rise")!;
    expect(RedemptionBackstopConfigSchema.safeParse({
      ...config,
      capacityModel: { kind: "reserve-sync-metadata", requiredOutputAssetKeys },
    }).success).toBe(false);
  });

  it("clones the output-bound capacity certificate instead of sharing its mutable key list", () => {
    const original = getRedemptionBackstopConfig("usdr-rise")!;
    const cloned = cloneRedemptionBackstopConfig(original);
    if (cloned.capacityModel.kind !== "reserve-sync-metadata") throw new Error("Expected live route");
    cloned.capacityModel.requiredOutputAssetKeys![0] = "m-m0";
    expect(original.capacityModel).toMatchObject({ requiredOutputAssetKeys: ["wm-m0"] });
  });
});

describe("PKT-12 bounded holder conversion terms", () => {
  it.each(["usda-avalon", "uusd-youves", "susd-solayer"])("does not promote %s conversion rights into full-supply capacity", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    const result = RedemptionBackstopConfigSchema.safeParse(config);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(config.capacityModel).toEqual({ kind: "unquantified" });
    expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(
      expect.arrayContaining(["capacity", "settlement", "cost"]),
    );
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.v9RouteCostTerms?.publishedFeeSchedule).toBeUndefined();
  });

  it("retains Avalon's USDT payout without inventing conversion fees", () => {
    const config = getRedemptionBackstopConfig("usda-avalon")!;
    expect(config.outputAssets).toEqual(["usdt-tether"]);
    expect(config.holderEligibility).toBe("unknown");
    expect(config.costModel.kind).toBe("dynamic-or-unclear");
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
  });

  it("retains Youves' collateral conversion haircut rather than treating it as par", () => {
    const config = getRedemptionBackstopConfig("uusd-youves")!;
    expect(config.outputAssetType).toBe("mixed-collateral");
    expect(config.outputAssets).toEqual(["asset:xtz", "asset:tzbtc", "asset:sirs", "asset:usdt"]);
    expect(config.costModel).toMatchObject({ kind: "fee-bps", feeBps: 625 });
    expect(config.settlementModel).toBe("days");
  });

  it("keeps Solayer's QLP-dependent USDC payout non-atomic and eligibility unresolved", () => {
    const config = getRedemptionBackstopConfig("susd-solayer")!;
    expect(config.outputAssets).toEqual(["usdc-circle"]);
    expect(config.settlementModel).toBe("queued");
    expect(config.holderEligibility).toBe("unknown");
    expect(config.costModel.kind).toBe("dynamic-or-unclear");
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
  });

  it.each(["wars-argentine-peso", "hyusd-hylo"])("keeps %s's explicitly unmeasured capacity unquantified", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    const result = RedemptionBackstopConfigSchema.safeParse(config);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(config.capacityModel).toEqual({ kind: "unquantified" });
  });

  it("does not turn Bridge's compliance-gated processing term into completed pathUSD payout", () => {
    const config = getRedemptionBackstopConfig("pathusd-bridge")!;
    const result = RedemptionBackstopConfigSchema.safeParse(config);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(config.outputAssets).toEqual(["usdc-circle"]);
    expect(config.settlementModel).toBe("days");
    expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.v9RouteReviewTerms?.businessDayTerms).toBeUndefined();
  });
});
