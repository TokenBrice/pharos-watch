import { describe, expect, it } from "vitest";
import { evaluatePhysicalToUsdExit } from "../physical-to-usd-exit";
import { PhysicalToUsdRouteSchema, type PhysicalToUsdRoute } from "../redemption-backstop-configs/schema";
import { evaluateV9Exit, projectV9ExitEvaluationRoute } from "../safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { makeExitRoute, makeNormalizedExitRoute } from "./safety-score-v9-exit.test-support";
import type { PhysicalToUsdTrace } from "../../types/exit-route";

const clock = Date.UTC(2026, 9, 1, 12) / 1000;
const reference = { usdPerTroyOunce: 1000, observedAtSec: clock };
function terms(): PhysicalToUsdRoute {
  return PhysicalToUsdRouteSchema.parse({ metal: "XAU", fineTroyOuncesPerToken: 1,
    lot: { minimumTokens: 100, incrementTokens: 100, bars: [] },
    throughput: { tokens: 100_000, periodSec: 86400, evidence: { url: "https://example.com/terms", quote: "The reviewed desk processes 100,000 tokens per calendar day." } },
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
    expect(evaluatePhysicalToUsdExit(terms(), reference, 99_999, clock)).toMatchObject({ grossUsd: 0, netUsd: null, lots: 0, rejectionReason: "physical-request-below-minimum" });
    expect(evaluatePhysicalToUsdExit(terms(), reference, 100_000, clock)).toMatchObject({ grossUsd: 100_000, lots: 1, rejectionReason: null });
    expect(evaluatePhysicalToUsdExit(terms(), reference, 199_999, clock)).toMatchObject({ grossUsd: 100_000, lots: 1 });
    expect(evaluatePhysicalToUsdExit(terms(), reference, 200_000, clock)).toMatchObject({ grossUsd: 200_000, lots: 2 });
  });
  it("credits only one minimum lot without documented throughput, not the full request", () => {
    const config = terms();
    delete config.throughput;
    expect(evaluatePhysicalToUsdExit(config, reference, 99_999, clock).grossUsd).toBe(0);
    expect(evaluatePhysicalToUsdExit(config, reference, 25_000_000, clock)).toMatchObject({ grossUsd: 100_000, lots: 1 });
    config.lot = { minimumTokens: 430, incrementTokens: null, bars: [{ barId: "variable-bar", fineTroyOunces: 350, maximumFineTroyOunces: 430 }] };
    expect(evaluatePhysicalToUsdExit(config, reference, 25_000_000, clock)).toMatchObject({ grossUsd: 350_000, tokens: 350, lots: 1 });
    config.lot.bars.push({ barId: "larger-bar", fineTroyOunces: 1000 });
    expect(evaluatePhysicalToUsdExit(config, reference, 25_000_000, clock)).toMatchObject({ grossUsd: 350_000, lots: 1 });
  });
  it("caps documented throughput over the full settlement window and still respects request and lot limits", () => {
    const config = terms();
    config.throughput = { tokens: 100, periodSec: 86400, evidence: { url: "https://example.com/terms", quote: "100 tokens per calendar day." } };
    const bounded = evaluatePhysicalToUsdExit(config, reference, 25_000_000, clock);
    expect(bounded).toMatchObject({ maximumSettlementSec: 18 * 86400, grossUsd: 1_800_000, lots: 18 });
    expect(evaluatePhysicalToUsdExit(config, reference, 250_000, clock).grossUsd).toBe(200_000);
    config.throughput.tokens = 1;
    expect(evaluatePhysicalToUsdExit(config, reference, 25_000_000, clock).grossUsd).toBe(0);
    config.throughput.evidence.quote = "";
    expect(evaluatePhysicalToUsdExit(config, reference, 25_000_000, clock).rejectionReason).toBe("physical-throughput-invalid-or-unevidenced");
  });
  it("prices physical costs on the common denominator without subsidizing expensive metal exits", () => {
    const config = terms();
    for (const costBps of [100, 150]) {
      config.fees.issuerFeeBps = costBps - 100;
      const physical = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock);
      const ordinary = makeExitRoute({ capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000, completionRatio: 1, executionCostBps: costBps }] });
      const ordinaryScore = evaluateV9Exit({ circulatingUsd: 10_000_000, routes: [ordinary] }, V9_CANDIDATE_POLICY_V1);
      expect(score(physical).routes[0]?.components?.cost).toBe(ordinaryScore.routes[0]?.components?.cost);
    }
    config.fees.issuerFeeBps = 150;
    expect(score(evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock)).routes[0]).toMatchObject({ included: true, components: { cost: 0 } });
  });
  it("removes only physical KYC's institutional discount and keeps modelled coverage weaker than exact observation", () => {
    const ordinary = projectV9ExitEvaluationRoute(makeNormalizedExitRoute({ holderAccess: "institutional-eligible", modelConfidence: "medium" }));
    const physical = projectV9ExitEvaluationRoute(makeNormalizedExitRoute({ holderAccess: "verified-customer-neutral", modelConfidence: "medium", coverageClass: "modelled-terms-lower-bound" }));
    const evaluate = (route: typeof physical) => evaluateV9Exit({ circulatingUsd: 10_000_000, routes: [route] }, V9_CANDIDATE_POLICY_V1).routes[0]!;
    const neutral = evaluate(physical);
    const gated = evaluate(ordinary);
    expect(neutral.included).toBe(true);
    expect(neutral.confidenceFactor).toBe(gated.confidenceFactor);
    expect(gated.score).toBeCloseTo(neutral.score! * 0.9, 1);
    expect(evaluate({ ...physical, coverageClass: "exact-complete" }).score).toBeGreaterThanOrEqual(neutral.score!);
    expect(evaluate({ ...physical, coverageClass: "diagnostic" })).toMatchObject({ included: false, score: null });
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
  it("withholds loss-making net USD without clamping the full execution cost or granting route credit", () => {
    const config = terms();
    delete config.throughput;
    config.lot = { minimumTokens: 430, incrementTokens: null, bars: [{ barId: "good-delivery", fineTroyOunces: 350, maximumFineTroyOunces: 430 }] };
    config.fees.issuerFeeBps = 100;
    config.fees.issuerFixedUsd = 100;
    const rejected = evaluatePhysicalToUsdExit(config, { ...reference, usdPerTroyOunce: 0.01 }, 1_000_000, clock);
    expect(rejected).toMatchObject({ grossUsd: 3.5, netUsd: null, rejectionReason: "physical-net-usd-nonpositive" });
    expect(rejected.costBps).toBeCloseTo((3.5 - (-96.57)) / 3.5 * 10_000);
    expect(score(rejected).routes[0]).toMatchObject({ included: false, score: null, exclusionReason: "missing-same-notional-route" });
  });
  it("withholds exactly break-even net USD rather than publishing a zero statistic", () => {
    const config = terms();
    delete config.throughput;
    config.fees.issuerFixedUsd = 99_000;
    const rejected = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock);
    expect(rejected).toMatchObject({ grossUsd: 100_000, netUsd: null, costBps: 10_000, rejectionReason: "physical-net-usd-nonpositive" });
    expect(score(rejected).routes[0]).toMatchObject({ included: false, score: null });
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
    config.bestEffortIssuerCashOut = { operatingProcess: "Issuer operates conversion and bank payout", lot: config.lot, throughput: config.throughput, fees: config.fees, settlementLegs: config.settlementLegs };
    const cash = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock, "best-effort-issuer-cash-out");
    expect(cash).toMatchObject({ costBps: 100, netUsd: 990_000, modelConfidence: "low" });
    const physical = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock);
    const evaluated = score(physical).routes[0]!;
    expect(physical.netUsd).toBe(990_000);
    expect(evaluated).toMatchObject({ included: true, components: { outputAssetQuality: 65, cost: 50 }, confidenceFactor: 0.75 });
    expect(evaluated.score).toBeLessThanOrEqual(65);
    expect(score(cash).routes[0]?.confidenceFactor).toBe(0.35);
  });
  it("does not admit costly small-silver cash-outs by pretending issuer sale spread is zero", () => {
    const config = terms();
    config.bestEffortIssuerCashOut = { operatingProcess: "Issuer attempts sale and wires USD", lot: config.lot, throughput: config.throughput, fees: config.fees, settlementLegs: config.settlementLegs };
    expect(evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock, "best-effort-issuer-cash-out")).toMatchObject({ costBps: 100, rejectionReason: null });
    config.metal = "XAG";
    config.barClass = "small-bar-or-coin";
    const rejected = evaluatePhysicalToUsdExit(config, reference, 1_000_000, clock, "best-effort-issuer-cash-out");
    expect(rejected).toMatchObject({ costBps: 800, rejectionReason: "physical-cost-ceiling-exceeded" });
    expect(score(rejected).routes[0]?.score).toBeNull();
  });
});
