import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig, resolveV9RedemptionRouteCostBpsAtNotional } from "../redemption-backstops";
import { RedemptionBackstopConfigSchema } from "../redemption-backstop-configs/schema";
import { cloneRedemptionBackstopConfig } from "../redemption-backstop-configs/shared";

const touched = ["xgld-unitas", "susdat-saturn", "susdx-axis", "usdr-rise", "slvon-ondo", "iauon-ondo", "witry-brix", "gldy-streamex", "dllr-sovryn", "srusde-strata", "alusd-alchemix"];

describe("wave-3 redemption handoff uptake", () => {
  it.each(touched)("admits the strict %s configuration", (id) => {
    const result = RedemptionBackstopConfigSchema.safeParse(getRedemptionBackstopConfig(id));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

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
    expect(config.capacityModel.kind).toBe("unquantified");
    expect(config.capacityModel).not.toHaveProperty("fallbackRatio");
    expect(config.capacityModel).not.toHaveProperty("eventualCapacityModel");
  });

  it("keeps XGLD's XAUt collateral fee separate from physical delivery or USD par", () => {
    const config = getRedemptionBackstopConfig("xgld-unitas")!;
    expect(config.outputAssets).toEqual(["xaut-tether"]);
    expect(config.holderEligibility).toBe("whitelisted-primary");
    expect(config.physicalCommodityDelivery).toBeUndefined();
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBe(10);
  });

  it.each(["slvon-ondo", "iauon-ondo"])("binds %s instant terms to USDon, not a USDC promise", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.outputAssets).toEqual(["usdon-ondo"]);
    expect(config.v9RouteReviewTerms).toMatchObject({ settlementModel: "atomic", settlementDelaySec: 0, minRedeemUsd: 1 });
    expect(config.capacityModel.kind).toBe("unquantified");
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBe(10);
    expect(config.costModel.kind).toBe("dynamic-or-unclear");
  });

  it.each(["dllr-sovryn", "srusde-strata", "gldy-streamex"])("retains %s alternatives unresolved without equal-weight basket or final SLA", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.outputAssets).toBeUndefined();
    expect(config.outputAssetType).not.toBe("stable-basket");
    expect(config.unresolvedOutputDisposition).toBe("reviewed-external");
    expect(config.unresolvedOutputAssetKeys!.length).toBeGreaterThan(1);
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
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
