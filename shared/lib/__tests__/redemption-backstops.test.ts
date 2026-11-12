import { describe, expect, it } from "vitest";
import { resolveCapacitySemantics } from "../redemption-backstop-confidence";
import {
  getRedemptionBackstopConfig,
  resolveReviewedRedemptionSettlement,
  resolveV9RedemptionRouteCostBpsAtNotional,
} from "../redemption-backstops";
import { resolveDefaultHolderEligibility, resolveRedemptionCostBpsAtNotional } from "../redemption-backstop-configs/shared";
import { getLiveReserveAdapterDefinition } from "../live-reserve-adapters";
import { TRACKED_META_BY_ID } from "../stablecoins/registry";
import { REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS } from "../../data/coverage-dispositions/redemption-coverage-dispositions";

describe("getRedemptionBackstopConfig", () => {
  it.each(["dllr-sovryn", "xusd-babelfish"])("keeps %s conversions suspended", (id) => {
    expect(getRedemptionBackstopConfig(id)).toMatchObject({
      routeStatus: "suspended",
      routeSuspension: { routeId: `redemption:${id}:basket-redeem`, reviewedAt: "2026-11-12" },
    });
  });

  it.each([
    ["usdv-solomon-v2", "defer", "issuer-terms-missing", "https://raw.githubusercontent.com/SolomonLabs/chancery/main/spec/04_Settlement_Pathways_and_Permissions.md"],
    ["iusd-initia", "needs-research", "documentation-insufficient", "https://contents.initia.xyz/app/iusd-faq.json"],
  ])("keeps %s's opaque composite path unconfigured with its sourced unresolved disposition", (id, disposition, reasonCode, evidenceUrl) => {
    expect(getRedemptionBackstopConfig(id)).toBeNull();
    const review = REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS.filter((row) => row.id === id);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ disposition, reasonCode, reviewedDate: "2026-10-11" });
    expect(review[0]!.evidenceUrls).toContain(evidenceUrl);
    expect(review[0]!.evidenceNeeded).toMatch(/capacity|liquidity/);
    expect(review[0]!.evidenceNeeded).toMatch(/fees|deductions/);
    expect(review[0]!.evidenceNeeded).toMatch(/settlement|completion/);
  });

  it.each([
    ["mantrausd-mantra", "issuer-api", "whitelisted-primary"],
    ["usdm-moneta", "manual", "whitelisted-primary"],
  ] as const)("keeps %s documentary access separate from executable capacity and complete costs", (id, access, eligibility) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.accessModel).toBe(access);
    expect(config.holderEligibility).toBe(eligibility);
    expect(config.capacityModel).toEqual({ kind: "unquantified" });
    expect(config.v9RouteReviewTerms?.scoringDisposition).toBe("bounded-terms-gap");
    expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(expect.arrayContaining(["capacity", "cost", "settlement"]));
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.v9RouteReviewTerms?.businessDayTerms).toBeUndefined();
    for (const notional of [1_000, 1_000_000, 25_000_000]) {
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBeNull();
    }
  });

  it("withholds BRZ's unrevalidated historical 1% fee and full-supply terms", () => {
    const config = getRedemptionBackstopConfig("brz-transfero")!;
    expect(config.capacityModel).toEqual({ kind: "unquantified" });
    expect(config.costModel).toMatchObject({
      kind: "dynamic-or-unclear",
      confidence: "undisclosed-reviewed",
      feeModelKind: "undisclosed-reviewed",
    });
    expect(config.costModel).not.toHaveProperty("feeBps");
    expect(config.v9RouteReviewTerms).toMatchObject({
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "cost", "settlement"],
      reviewedAt: "2026-10-14",
    });
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
  });

  it("keeps SoulPeg atomic receipt conversion and zero protocol fee distinct from a USDC payout", () => {
    const config = getRedemptionBackstopConfig("spusd-soulpeg")!;
    expect(config.holderEligibility).toBe("any-holder");
    expect(config.settlementModel).toBe("atomic");
    expect(config.v9RouteReviewTerms).toMatchObject({ settlementDelaySec: 0, missingScoringFields: ["capacity"] });
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBe(0);
    expect(config.costModel).not.toHaveProperty("gasOrBridgeCostUsd");
  });

  it("records ZARU legal entitlement as eventual-only with all executable terms withheld", () => {
    const config = getRedemptionBackstopConfig("zaru-blocktower")!;
    expect(config.capacityModel).toEqual({ kind: "supply-full", confidence: "documented-bound", basis: "issuer-term-redemption" });
    expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
    expect(config.holderEligibility).toBe("whitelisted-primary");
    expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
    expect(config.outputAssets).toBeUndefined();
  });

  it.each(["kau-kinesis", "kag-kinesis"])(
    "prices %s's published 0.45%% + $100 schedule as an additive flat at every cost-scenario notional",
    (stablecoinId) => {
      const config = getRedemptionBackstopConfig(stablecoinId)!;
      // $1,000: $4.50 + $100 = 1,045 bps; $10,000: $45 + $100 = 145 bps;
      // $1,000,000: $4,500 + $100 = 46 bps.
      expect(resolveRedemptionCostBpsAtNotional(config.costModel, 1_000)).toBeCloseTo(1_045, 6);
      expect(resolveRedemptionCostBpsAtNotional(config.costModel, 10_000)).toBeCloseTo(145, 6);
      expect(resolveRedemptionCostBpsAtNotional(config.costModel, 1_000_000)).toBeCloseTo(46, 6);
    },
  );

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

  it.each([
    { id: "usdm-monetrix", missingScoringFields: ["capacity", "settlement"], protocolFeeBps: 0 },
    { id: "susdat-saturn", missingScoringFields: ["capacity", "settlement", "cost"], protocolFeeBps: null },
  ])(
    "keeps $id queue capacity and completion unproven while preserving reviewed protocol fees",
    ({ id, missingScoringFields, protocolFeeBps }) => {
      const config = getRedemptionBackstopConfig(id)!;
      expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
      expect(config.capacityModel).not.toHaveProperty("fallbackRatio");
      expect(config.capacityModel).not.toHaveProperty("ratio");
      expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(missingScoringFields);
      expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
      for (const notional of [1_000, 1_000_000, 25_000_000]) {
        expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBe(protocolFeeBps);
      }
      expect(config.costModel).not.toHaveProperty("feeBpsMax");
      expect(config.v9RouteCostTerms?.publishedFeeSchedule).toBeUndefined();
      if (id === "usdm-monetrix") {
        expect(config.costModel).toMatchObject({
          kind: "fee-bps", feeBps: 0, confidence: "fixed",
          feeDescription: expect.stringContaining("network gas separate"),
        });
      }
    },
  );

  it("does not turn migrated USDat backing into USDC redemption capacity or a cost bound", () => {
    const config = getRedemptionBackstopConfig("usdat-saturn")!;
    expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
    expect(config.outputAssets).toEqual(["usdc-circle"]);
    expect(config.accessModel).toBe("permissionless-onchain");
    expect(config.holderEligibility ?? resolveDefaultHolderEligibility(config)).toBe("unknown");
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
});

describe("reviewed queue-redeem capacity models", () => {
  it("does not publish USDCx's collateral-only escrow read as live-direct capacity", () => {
    const stablecoinId = "usdcx-movement";
    const config = getRedemptionBackstopConfig(stablecoinId)!;
    const meta = TRACKED_META_BY_ID.get(stablecoinId)!;
    const adapter = meta.liveReservesConfig
      ? getLiveReserveAdapterDefinition(meta.liveReservesConfig.adapter)
      : null;

    expect(adapter?.redemptionTelemetry.capacity).toBe("direct");
    expect(config.capacityModel).toEqual({ kind: "unquantified" });
    expect(resolveReviewedRedemptionSettlement(config, 1_793_318_400)).toBe("queued");
    expect(meta.liveReservesConfig?.params?.settlementDelaySec).toBeUndefined();
  });
});
