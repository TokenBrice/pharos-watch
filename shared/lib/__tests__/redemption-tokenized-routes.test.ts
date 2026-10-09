import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig, resolveReviewedRedemptionSettlement, resolveV9RedemptionRouteCostBpsAtNotional } from "../redemption-backstops";
import { resolveCapacitySemantics } from "../redemption-backstop-confidence";
import { resolveReviewedRouteSuspension } from "../redemption-route-suspension";
import { RedemptionBackstopConfigSchema } from "../redemption-backstop-configs/schema";
import { NEST_NAV_VAULT_CONFIGS } from "../redemption-backstop-configs/queue-redeem-nest-nav";
import { NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS } from "../redemption-backstop-configs/offchain-issuer/non-usd-and-tokenized";
import { resolveReviewedRedemptionSettlementDelay } from "../redemption-backstop-configs/settlement";

const reviewedClock = Date.UTC(2026, 9, 8) / 1_000;

describe("tokenized issuer route evidence boundaries", () => {
  it.each(["kgst-kyrgyz-som", "wbrl-ripio", "wclp-ripio", "wcop-ripio", "wmxn-ripio", "wpen-ripio", "hlusd-hela"])(
    "does not infer %s capacity from backing or outstanding supply",
    (id) => {
      const config = getRedemptionBackstopConfig(id)!;
      expect(config.capacityModel).toEqual({ kind: "unquantified" });
      expect(config.holderEligibility).toBe("unknown");
      expect(config.settlementModel).toBe("days");
      expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement", "cost"]);
      expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
      expect(config.v9RouteReviewTerms?.businessDayTerms).toBeUndefined();
      if (id !== "hlusd-hela") expect(config.routeStatus).toBe("unknown");
    },
  );

  it("retains HLUSD's manual alternatives and OTC fee without inventing a sell minimum", () => {
    const config = getRedemptionBackstopConfig("hlusd-hela")!;
    expect(config).toMatchObject({ accessModel: "manual", executionModel: "opaque", outputAssets: ["usdc-circle", "usdt-tether"] });
    expect(config.costModel.kind).toBe("fee-bps");
    if (config.costModel.kind !== "fee-bps") throw new Error("Expected HLUSD's fixed OTC fee");
    expect(config.costModel.feeBps).toBe(100);
    expect(config.v9RouteReviewTerms?.minRedeemUsd).toBeUndefined();
  });

  it.each(["iauon-ondo", "slvon-ondo"])("keeps %s documented USDon redemption separate from standard put capacity", (id) => {
    const config = getRedemptionBackstopConfig(id)!;
    expect(config.capacityModel).toEqual({ kind: "unquantified" });
    expect(config.outputAssets).toEqual(["usdon-ondo"]);
    expect(config.v9RouteReviewTerms).toMatchObject({
      settlementModel: "immediate",
      minRedeemUsd: 1,
      scoringDisposition: "bounded-terms-gap",
      missingScoringFields: ["capacity", "settlement", "cost"],
    });
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.v9RouteReviewTerms?.businessDayTerms).toBeUndefined();
    expect(config.costModel.feeBpsMax).toBeUndefined();
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
    const capacitySource = config.docs?.find((source) =>
      source.url === "https://docs.ondo.finance/api-reference/limits/get-trading-limits.md");
    expect(capacitySource?.supports).toContain("capacity");
    // Account/asset limits are documentary constraints, not executable
    // standard-put capacity or an end-to-end instant completion guarantee.
    const reviewClockSec = Date.parse(`${config.v9RouteReviewTerms!.reviewedAt}T00:00:00Z`) / 1_000;
    for (const clockSec of [reviewClockSec - 1, reviewClockSec + 86_400]) {
      expect(resolveReviewedRedemptionSettlement(config, clockSec)).toBe("immediate");
      expect(resolveReviewedRedemptionSettlementDelay(config.v9RouteReviewTerms, clockSec)).toBeUndefined();
    }
  });

  it("keeps mTBILL's coherent instant fee and heuristic buffer, not standard-branch limits", () => {
    const config = getRedemptionBackstopConfig("mtbill-midas")!;
    expect(config.capacityModel).toEqual({ kind: "supply-ratio", ratio: 0.02, confidence: "heuristic", basis: "hot-buffer" });
    expect(config.outputAssets).toEqual(["usdc-circle"]);
    expect(config.costModel.kind).toBe("fee-bps");
    if (config.costModel.kind !== "fee-bps") throw new Error("Expected mTBILL's fixed instant fee");
    expect(config.costModel.feeBps).toBe(7);
    expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(["capacity", "settlement"]);
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
  });

  it("enforces the USDY USD minimum without treating default-account fees or headroom as universal", () => {
    const config = getRedemptionBackstopConfig("usdy-ondo-finance")!;
    expect(config.capacityModel).toEqual({ kind: "supply-ratio", ratio: 0.05, confidence: "heuristic", basis: "hot-buffer" });
    expect(config.settlementModel).toBe("days");
    expect(config.v9RouteReviewTerms).toMatchObject({ settlementModel: "atomic", settlementDelaySec: 0, minRedeemUsd: 1, missingScoringFields: ["capacity", "cost"] });
    expect(config.costModel.feeBpsMax).toBeUndefined();
    for (const notional of [0.5, 1, 1_000, 10_000_000, 25_000_000]) {
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBeNull();
    }
  });

  it("keeps USYC eventual-only without a holder-scoped executable measurement", () => {
    const config = getRedemptionBackstopConfig("usyc-hashnote")!;
    expect(config.capacityModel.kind).toBe("supply-full");
    expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
    expect(config.outputAssets).toEqual(["usdc-circle"]);
    expect(config.costModel.feeBpsMax).toBe(3);
    expect(config.capacityModel).not.toHaveProperty("amountUsd");
    expect(config.capacityModel).not.toHaveProperty("fallbackRatio");
  });

  it("keeps Gate's quota-dependent fee range without changing its capacity model", () => {
    const config = getRedemptionBackstopConfig("gusd-gate")!;
    expect(config.costModel).toMatchObject({ feeBpsMin: 0, feeBpsMax: 10 });
    expect(config.capacityModel).toEqual({ kind: "supply-full", confidence: "documented-bound" });
    expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
  });

  it("admits EURR's exact reviewed suspension only after the review day and at its route identity", () => {
    const config = getRedemptionBackstopConfig("eurr-stablr")!;
    expect(RedemptionBackstopConfigSchema.safeParse(config).success).toBe(true);
    expect(config.routeStatus).toBe("suspended");
    expect(resolveReviewedRouteSuspension(config, "redemption:eurr-stablr:offchain-issuer", reviewedClock - 86_400)).toBeUndefined();
    expect(resolveReviewedRouteSuspension(config, "redemption:eurr-stablr:offchain-issuer", reviewedClock)).toBeDefined();
    expect(resolveReviewedRouteSuspension(config, "redemption:eurr-stablr:offchain-issuer", reviewedClock - 1)).toBeUndefined();
    expect(resolveReviewedRouteSuspension(config, "redemption:usdr-stablr:offchain-issuer", reviewedClock)).toBeUndefined();
  });

  it("leaves rwaUSDi cost and liquidity-class completion unbounded", () => {
    const config = getRedemptionBackstopConfig("rwausdi-multipli")!;
    expect(config.costModel.confidence).toBe("undisclosed-reviewed");
    expect(config.settlementModel).toBe("days");
    expect(config.v9RouteReviewTerms?.missingScoringFields).toEqual(["cost", "settlement"]);
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.v9RouteReviewTerms?.businessDayTerms).toBeUndefined();
    for (const notional of [1_000, 1_000_000, 25_000_000]) {
      expect(resolveV9RedemptionRouteCostBpsAtNotional(config, notional)).toBeNull();
    }
  });

  it("does not convert EURCV acknowledgement or conditional month-end into payout duration", () => {
    const config = getRedemptionBackstopConfig("eurcv-societe-generale-forge")!;
    expect(config.settlementModel).toBe("days");
    expect(config.costModel.confidence).toBe("undisclosed-reviewed");
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.v9RouteReviewTerms?.businessDayTerms).toBeUndefined();
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
  });

  it("isolates family rows' nested docs, outputs, fees and review terms", () => {
    const iau = structuredClone(NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS["iauon-ondo"]);
    const slv = structuredClone(NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS["slvon-ondo"]);
    const nestBefore = structuredClone(NEST_NAV_VAULT_CONFIGS);
    const ondoConfig = NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS["iauon-ondo"];
    const nestConfig = NEST_NAV_VAULT_CONFIGS["ntbill-nest"];
    expect(nestConfig.costModel.kind).toBe("fee-bps");
    if (nestConfig.costModel.kind !== "fee-bps") throw new Error("Expected a mutable fixed-fee fixture");
    try {
      ondoConfig.outputAssets!.push("usdc-circle");
      ondoConfig.v9RouteReviewTerms!.missingScoringFields!.push("cost");
      ondoConfig.docs![0].supports!.push("capacity");
      nestConfig.outputAssets!.push("usdt-tether");
      nestConfig.docs![0].supports!.push("fees");
      nestConfig.costModel.feeBps = 99;
      expect(NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS["slvon-ondo"]).toEqual(slv);
      for (const id of ["nbasis-nest", "nopal-nest", "nwisdom-nest"]) expect(NEST_NAV_VAULT_CONFIGS[id]).toEqual(nestBefore[id]);
    } finally {
      NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS["iauon-ondo"] = iau;
      NEST_NAV_VAULT_CONFIGS["ntbill-nest"] = nestBefore["ntbill-nest"];
    }
  });
});
