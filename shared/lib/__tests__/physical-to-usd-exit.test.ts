import { describe, expect, it } from "vitest";
import { evaluatePhysicalToUsdExit } from "../physical-to-usd-exit";
import { PhysicalToUsdRouteSchema, type PhysicalToUsdRoute } from "../redemption-backstop-configs/schema";
import { evaluateV9Exit } from "../safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { makeExitRoute } from "./safety-score-v9-exit.test-support";
import type { PhysicalToUsdTrace } from "../../types/exit-route";

const clock = Date.UTC(2026, 9, 1, 12) / 1000;
const reference = { usdPerTroyOunce: 1000, observedAtSec: clock };
function terms(): PhysicalToUsdRoute {
  return PhysicalToUsdRouteSchema.parse({ metal: "XAU", fineTroyOuncesPerToken: 1,
    lot: { minimumTokens: 100, incrementTokens: 100, bars: [] },
    vaultLocations: ["london"], barClass: "good-delivery", eligibility: "verified-customer",
    fees: { issuerFeeBps: 0, issuerFixedUsd: 0, deliveryUsdPerLot: 0, insuranceBps: 0, assayUsdPerLot: 0, taxBps: 0, conversionBps: 0 },
    settlementLegs: [{ leg: "release", maximumBusinessDays: 1 }, { leg: "sale", maximumBusinessDays: 1 }],
    reviewedAt: "2026-10-01", reviewExpiresAt: "2026-12-30",
    evidence: [{ url: "https://example.com/terms", quote: "Reviewed bounded physical redemption terms" }] });
}
function score(physical: PhysicalToUsdTrace) {
  const route = makeExitRoute({ physicalToUsd: physical, outputQuality: "stable-single",
    routeScoreCap: "offchain-issuer", outputValueRetention: 1,
    modelConfidence: physical.modelConfidence,
    capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 500,
      executableUsd: physical.rejectionReason === null ? physical.grossUsd! : 0,
      completionRatio: physical.rejectionReason === null ? physical.grossUsd! / 1_000_000 : 0,
      executionCostBps: physical.rejectionReason === null ? physical.costBps! : 500 }] });
  return evaluateV9Exit({ routes: [route], circulatingUsd: 10_000_000 }, V9_CANDIDATE_POLICY_V1);
}

describe("physical-to-USD exit", () => {
  it("enforces minimum and integer lot boundaries without borrowing tokens", () => {
    expect(evaluatePhysicalToUsdExit(terms(), reference, 99_999, clock)).toMatchObject({ grossUsd: 0, lots: 0, rejectionReason: "physical-request-below-minimum" });
    expect(evaluatePhysicalToUsdExit(terms(), reference, 100_000, clock)).toMatchObject({ grossUsd: 100_000, lots: 1, rejectionReason: null });
    expect(evaluatePhysicalToUsdExit(terms(), reference, 199_999, clock)).toMatchObject({ grossUsd: 100_000, lots: 1 });
    expect(evaluatePhysicalToUsdExit(terms(), reference, 200_000, clock)).toMatchObject({ grossUsd: 200_000, lots: 2 });
  });
  it("sizes variable bars at upper fine weight and counts lower fine weight without charging refunds", () => {
    const config = terms();
    config.lot = { minimumTokens: 430, incrementTokens: null, bars: [{ barId: "good-delivery", fineTroyOunces: 350, maximumFineTroyOunces: 430 }] };
    expect(evaluatePhysicalToUsdExit(config, reference, 429_999, clock).grossUsd).toBe(0);
    expect(evaluatePhysicalToUsdExit(config, reference, 430_000, clock)).toMatchObject({ lots: 1, tokens: 350, grossUsd: 350_000, netUsd: 346_500, costBps: 100 });
  });
  it("admits exactly 500 bps and rejects 501 with no route credit", () => {
    const config = terms();
    config.fees.taxBps = 400;
    const admitted = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock);
    expect(admitted).toMatchObject({ costBps: 500, rejectionReason: null });
    expect(score(admitted).routes[0]).toMatchObject({ included: true, components: { cost: 0, outputAssetQuality: 65 } });
    config.fees.taxBps = 401;
    const rejected = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock);
    expect(rejected).toMatchObject({ costBps: 501, rejectionReason: "physical-cost-ceiling-exceeded" });
    expect(score(rejected).routes[0]).toMatchObject({ included: false, score: null, exclusionReason: "missing-same-notional-route" });
  });
  it("withholds unknown lots, unstated timing and explicitly unbounded charges", () => {
    const config = terms();
    config.fees.deliveryUsdPerLot = "unbounded";
    expect(evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock)).toMatchObject({ netUsd: null, rejectionReason: "physical-deliveryUsdPerLot-unbounded" });
    config.fees.deliveryUsdPerLot = 0;
    config.settlementLegs[0]!.maximumBusinessDays = null;
    expect(evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock)).toMatchObject({ netUsd: null, rejectionReason: "physical-final-settlement-missing" });
    config.settlementLegs[0]!.maximumBusinessDays = 1;
    config.lot.incrementTokens = null;
    expect(evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock)).toMatchObject({ netUsd: null, rejectionReason: "physical-lot-increment-missing" });
  });
  it("expires reviews and captured references fail closed", () => {
    const expired = evaluatePhysicalToUsdExit(terms(), { ...reference, observedAtSec: clock + 91 * 86400 }, 1_000_000, clock + 91 * 86400);
    expect(expired).toMatchObject({ grossUsd: null, rejectionReason: "physical-review-expired-or-invalid" });
    expect(score(expired).routes[0]?.score).toBeNull();
    expect(evaluatePhysicalToUsdExit(terms(), { ...reference, observedAtSec: clock - 86401 }, 1_000_000, clock).rejectionReason).toBe("physical-metal-price-unavailable-or-stale");
  });
  it("uses explicit maxima ahead of typical estimates and lowers confidence for assumptions", () => {
    const config = terms();
    config.settlementLegs = [{ leg: "release", maximumBusinessDays: null, typicalBusinessDays: "several-business-days" }];
    config.fees.issuerFeeBps = null;
    const assumed = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock);
    expect(assumed).toMatchObject({ modelConfidence: "low", assumptions: ["fee-policy-assumed", "settlement-maximum-policy-assumed"], maximumSettlementSec: 43 * 86400 });
    config.settlementLegs[0]!.maximumBusinessDays = 1;
    config.fees.issuerFeeBps = 0;
    const explicit = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock);
    expect(explicit).toMatchObject({ modelConfidence: "medium", assumptions: [], maximumSettlementSec: 15 * 86400 });
    expect(score(assumed).routes[0]?.confidenceFactor).toBe(0.35);
    expect(score(explicit).routes[0]?.confidenceFactor).toBe(0.75);
  });
  it("models silver tax by release jurisdiction, not as a tax on every vaulted sale", () => {
    const config = terms();
    config.metal = "XAG";
    config.fees.taxBps = null;
    config.fineness = 0.999;
    const vaulted = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock);
    expect(vaulted).toMatchObject({ rejectionReason: null, costBps: 100 });
    config.saleLocation = "delivered";
    config.vaultLocations = ["zurich"];
    expect(evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock)).toMatchObject({ costBps: 910, rejectionReason: "physical-cost-ceiling-exceeded" });
    config.vaultLocations = ["singapore"];
    expect(evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock)).toMatchObject({ costBps: 200, rejectionReason: null });
    config.fineness = null;
    expect(evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock).rejectionReason).toBe("physical-cost-ceiling-exceeded");
  });
  it("estimates unpublished domestic delivery but withholds unpriced cross-border delivery", () => {
    const config = terms();
    config.saleLocation = "delivered";
    config.fees.deliveryUsdPerLot = null;
    config.fees.insuranceBps = null;
    config.fees.assayUsdPerLot = null;
    const domestic = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock);
    expect(domestic).toMatchObject({ grossUsd: 1_000_000, netUsd: 940_000, costBps: 600, modelConfidence: "low", rejectionReason: "physical-cost-ceiling-exceeded" });
    config.deliveryScope = "cross-border";
    expect(evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock)).toMatchObject({ netUsd: null, rejectionReason: "physical-deliveryUsdPerLot-cross-border-unpriced" });
  });
  it("keeps best-effort cash confidence low and charges cost once, leaving USD retention one", () => {
    const config = terms();
    config.bestEffortIssuerCashOut = { operatingProcess: "Issuer operates conversion and bank payout", lot: config.lot, fees: config.fees, settlementLegs: config.settlementLegs };
    const cash = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock, "best-effort-issuer-cash-out");
    expect(cash).toMatchObject({ costBps: 0, netUsd: 1_000_000, modelConfidence: "low" });
    const physical = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock);
    const evaluated = score(physical).routes[0]!;
    expect(physical.netUsd).toBe(990_000);
    expect(evaluated).toMatchObject({ included: true, components: { outputAssetQuality: 65, cost: 80 }, confidenceFactor: 0.75 });
    expect(evaluated.score).toBeLessThanOrEqual(65);
    expect(score(cash).routes[0]?.confidenceFactor).toBe(0.35);
  });
});
