import { describe, expect, it } from "vitest";
import { resolveCapacitySemantics } from "../redemption-backstop-confidence";
import { getRedemptionBackstopConfig } from "../redemption-backstops";
import { resolveReviewedRedemptionSettlementDelay } from "../redemption-backstop-configs/settlement";
import { resolveRedemptionCostBpsAtNotional, resolveV9RedemptionRouteCostBpsAtNotional } from "../redemption-backstop-configs/shared";
import { COVERAGE_AND_STABLECOIN_AUDIT_OFFCHAIN_CONFIGS as familyConfigs } from "../redemption-backstop-configs/offchain-issuer/coverage-and-stablecoin-audit";

const clock = Date.parse("2026-10-08T12:00:00Z") / 1000;
const spikoIds = ["ustbl-spiko", "safo-spiko-usd", "spkcc-spiko", "uktbl-spiko", "gbpsafo-spiko", "eutbl-spiko", "eursafo-spiko", "eurspkcc-spiko"];
const midasIds = ["mf-one-midas", "mglobal-midas-fasanara", "mhyper-midas", "mmev-midas", "mapollo-midas"];

describe("reviewed Spiko and major-issuer route boundaries", () => {
  it("does not expose an operational route for account-only BFUSD", () => {
    expect(getRedemptionBackstopConfig("bfusd-binance")).toBeNull();
  });

  it.each(spikoIds)("keeps %s eventual-only rather than promoting NAV or account eligibility to liquidity", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.capacityModel).toEqual({ kind: "supply-full", confidence: "documented-bound" });
    expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
    expect(config.outputAssetType).toBe("nav");
    expect(config.settlementModel).toBe("days");
    expect(resolveReviewedRedemptionSettlementDelay(config.v9RouteReviewTerms, clock)).toBeUndefined();
  });

  it.each(["eutbl-spiko", "eursafo-spiko", "ustbl-spiko", "safo-spiko-usd"])(
    "retains %s zero fund exit fees but explicitly withholds completed settlement", (id) => {
      const config = getRedemptionBackstopConfig(id)!;
      expect(resolveRedemptionCostBpsAtNotional(config.costModel, 100_000)).toBe(0);
      expect(config.v9RouteReviewTerms).toMatchObject({
        settlementModel: "days", scoringDisposition: "bounded-terms-gap",
        missingScoringFields: ["settlement"], reviewedAt: "2026-10-07",
      });
      expect(config.v9RouteReviewTerms).not.toHaveProperty("settlementDelaySec");
      expect(config.v9RouteReviewTerms).not.toHaveProperty("businessDayTerms");
    },
  );

  it("keeps GBPSAFO's independent review and merged factor gaps", () => {
    expect(getRedemptionBackstopConfig("gbpsafo-spiko")!.v9RouteReviewTerms).toMatchObject({
      reviewedAt: "2026-09-04", missingScoringFields: ["capacity", "settlement", "cost"],
    });
  });

  it.each(["rlusd-ripple", "tusd-trueusd", "usdgo-osl", "ylds-figure"])(
    "retains %s issuer-only zero fee without a completion scalar", (id) => {
      const config = getRedemptionBackstopConfig(id)!;
      expect(resolveRedemptionCostBpsAtNotional(config.costModel, 100_000)).toBe(0);
      expect(config.costModel).toMatchObject({ kind: "fee-bps", feeBps: 0, confidence: "fixed" });
      expect(resolveReviewedRedemptionSettlementDelay(config.v9RouteReviewTerms, clock)).toBeUndefined();
    },
  );

  it.each(["tusd-trueusd", "sofid-sofi", "usat-tether"])(
    "keeps %s completed-payout and all-in cost gaps independently of issuer fee", (id) => {
      const config = getRedemptionBackstopConfig(id)!;
      expect(config.settlementModel).toBe("days");
      expect(config.v9RouteReviewTerms).toMatchObject({
        scoringDisposition: "bounded-terms-gap", reviewedAt: "2026-10-07",
      });
      expect(config.v9RouteReviewTerms!.missingScoringFields).toEqual(expect.arrayContaining(["cost", "settlement"]));
      expect(config.v9RouteReviewTerms).not.toHaveProperty("settlementDelaySec");
    },
  );

  it.each(["sofid-sofi", "usat-tether"])("does not turn %s fee authority or an omitted schedule into numeric fee zero", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(resolveRedemptionCostBpsAtNotional(config.costModel, 100_000)).toBeNull();
    expect(config.costModel).not.toHaveProperty("feeBps");
    expect(config.costModel).not.toHaveProperty("feeBpsMax");
  });

  it.each(["usdc-circle", "eurc-circle"])("retains %s conservative tier ceiling without assuming an allowance or credit", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.v9RouteCostTerms).toEqual({ feeBpsMax: 10 });
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 100_000)).toBe(10);
    expect(config.costModel.kind).not.toBe("fee-bps");
    expect(resolveReviewedRedemptionSettlementDelay(config.v9RouteReviewTerms, clock)).toBeUndefined();
  });

  it.each([...midasIds, ...spikoIds])("isolates %s docs, costs, notes and review arrays from every other family row", (id) => {
    const row = familyConfigs[id]!;
    const original = structuredClone(row);
    const otherIds = [...midasIds, ...spikoIds].filter((other) => other !== id);
    const before = JSON.stringify(otherIds.map((other) => familyConfigs[other]));
    try {
      row.docs![0]!.supports!.push("fees");
      row.costModel.feeDescription = "mutated fee";
      row.notes!.push("mutated note");
      row.v9RouteReviewTerms?.missingScoringFields?.push("cost");
      row.v9RouteReviewTerms?.docs?.[0]?.supports?.push("fees");
      row.v9RouteReviewTerms?.businessDayTerms?.conditions.push("mutated calendar condition");
      expect(JSON.stringify(otherIds.map((other) => familyConfigs[other]))).toBe(before);
    } finally {
      Object.assign(row, original);
    }
  });
});
