import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig, resolveV9RedemptionRouteCostBpsAtNotional } from "../redemption-backstops";
import { resolveCapacitySemantics } from "../redemption-backstop-confidence";
import { resolveReviewedRouteSuspension } from "../redemption-route-suspension";
import { RedemptionBackstopConfigSchema } from "../redemption-backstop-configs/schema";

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

  it("keeps USYC eventual-only without a holder-scoped executable measurement", () => {
    const config = getRedemptionBackstopConfig("usyc-hashnote")!;
    expect(config.capacityModel.kind).toBe("supply-full");
    expect(resolveCapacitySemantics(config.capacityModel)).toBe("eventual-only");
    expect(config.outputAssets).toEqual(["usdc-circle"]);
    expect(config.costModel.feeBpsMax).toBe(3);
    expect(config.capacityModel).not.toHaveProperty("amountUsd");
    expect(config.capacityModel).not.toHaveProperty("fallbackRatio");
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

  it("admits USDR's exact reviewed suspension only after the review day and at its route identity", () => {
    const config = getRedemptionBackstopConfig("usdr-stablr")!;
    expect(RedemptionBackstopConfigSchema.safeParse(config).success).toBe(true);
    expect(config.routeStatus).toBe("suspended");
    expect(config.routeSuspension).toMatchObject({
      routeId: "redemption:usdr-stablr:offchain-issuer",
      suspendedAt: "2026-08-25",
      reviewedAt: "2026-10-30",
    });
    // The issuer's August 25, 2026 recovery update owns the as-of date.
    expect(config.routeSuspension?.sources[0]?.quote).toContain(
      "minting and redemption of EURR and USDR remain temporarily suspended",
    );
    const reviewedClockSec = Date.UTC(2026, 9, 30) / 1_000 + 86_400;
    expect(resolveReviewedRouteSuspension(config, "redemption:usdr-stablr:offchain-issuer", reviewedClockSec - 1)).toBeUndefined();
    expect(resolveReviewedRouteSuspension(config, "redemption:usdr-stablr:offchain-issuer", reviewedClockSec)).toBeDefined();
    expect(resolveReviewedRouteSuspension(config, "redemption:eurr-stablr:offchain-issuer", reviewedClockSec)).toBeUndefined();
  });

  it("does not convert EURCV acknowledgement or conditional month-end into payout duration", () => {
    const config = getRedemptionBackstopConfig("eurcv-societe-generale-forge")!;
    expect(config.settlementModel).toBe("days");
    expect(config.costModel.confidence).toBe("undisclosed-reviewed");
    expect(config.v9RouteReviewTerms?.settlementDelaySec).toBeUndefined();
    expect(config.v9RouteReviewTerms?.businessDayTerms).toBeUndefined();
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 1_000_000)).toBeNull();
  });
});
