import { describe, expect, it } from "vitest";
import { loadV9MethodologyPolicy, V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9AssetFactsBase } from "../../types/safety-score-v9-facts";
import {
  evaluateV9Exit,
  isV9CreditableNonAtomicRedemption,
  projectV9ExitEvaluationRoute,
  selectV9ExitCirculatingUsd,
  resolveV9DistinctExitCapacity,
  selectV9ExitStressRequest,
  type V9ExitEvaluationRoute,
} from "../safety-score-v9/exit";
import {
  makeExitRoute,
  makeExitGap as gap,
  makeDocumentedRedemption,
  makeNormalizedExitRoute,
} from "./safety-score-v9-exit.test-support";
import {
  admitExitExecutionCertificate,
  exitExecutionInputGenerationId,
  exitExecutionReviewDigest,
  validateExitExecutionModelReviews,
} from "../safety-score-v9/exit-execution";
import { makeExecutionCertificate } from "./safety-score-v9-exit-execution.test-support";
import executionReviews from "../../data/safety-score-v9/exit-execution-model-reviews-v1.json";
import { domainDigest } from "../safety-score-v9/primitives";

const P = V9_CANDIDATE_POLICY_V1;
type ExitInput = Parameters<typeof evaluateV9Exit>[0];

const route = (overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute =>
  makeExitRoute({ capacityEvidenceTier: "live-direct", ...overrides });
const documentedRedemption = (overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute =>
  makeDocumentedRedemption({ capacityEvidenceTier: "documented", ...overrides });
const dexRoute = (overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute => route({
  routeKey: "dex:usdc-circle:pool", lane: "dex", routeFamily: "dex-amm",
  evidenceKind: "measured-executable-depth", ...overrides,
});
const pt = (requestedNotionalUsd: number, executableUsd: number, executionCostBps = 0, maxCostBps = 200) => ({
  requestedNotionalUsd, maxCostBps, executableUsd,
  completionRatio: executableUsd / requestedNotionalUsd, executionCostBps,
});
const evalExit = (input: ExitInput, policy = P) => evaluateV9Exit(input, policy);
const evalRoutes = (
  routes: V9ExitEvaluationRoute[],
  extra: Partial<Omit<ExitInput, "routes">> = {},
  policy = P,
) => evaluateV9Exit({ circulatingUsd: 20_000_000, ...extra, routes }, policy);
const stressReq = (supply: number | null) => selectV9ExitStressRequest(supply, P);

function certificateRoute(options: {
  routeKey?: string;
  certification: "exact-lower-bound" | "exact-complete";
  physicalResourceKeys?: string[];
  requestedNotionalUsd?: number;
  executionCostBps?: number;
  modelConfidence?: V9ExitEvaluationRoute["modelConfidence"];
  rawUnits?: string;
}) {
  const review = validateExitExecutionModelReviews(executionReviews, P)
    .find((entry) => entry.identity.assetId === "susds-sky")!;
  const clockSec = Math.ceil(Date.parse(review.reviewedAt) / 1000);
  const model = P.policy.semantic.exit.executionModels[review.modelId]!;
  const requestedNotionalUsd = options.requestedNotionalUsd ?? 100_000;
  const executionCostBps = options.executionCostBps ?? 200;
  const requestedRawInput = (BigInt(requestedNotionalUsd) * 10n ** BigInt(review.producer.inputDecimals)).toString();
  const certificate = makeExecutionCertificate();
  Object.assign(certificate, {
    modelId: review.modelId, identity: review.identity, holder: review.holder,
    reviewDigest: exitExecutionReviewDigest(review), observedAtSec: clockSec,
    sourceMaxAgeSec: model.sourceMaxAgeSec, priceMaxAgeSec: model.priceMaxAgeSec,
  });
  certificate.source.timestamp = clockSec;
  certificate.observationGenerationId = domainDigest("safety-score-v10.exit-execution-source.v1", certificate.source);
  Object.assign(certificate.inputReference, {
    assetKey: review.identity.assetId, deployment: review.identity.deployment,
    decimals: review.producer.inputDecimals, observedAtSec: clockSec,
  });
  certificate.inputGenerationId = exitExecutionInputGenerationId(
    review.identity.assetId, { requestedNotionalUsd, maxCostBps: 200 }, certificate.inputReference,
  );
  certificate.gates = model.requiredGates.map((gateId) => ({
    gateId, verdict: "passed", evidenceId: `observed:${gateId}`, observedAtSec: clockSec, reason: null,
  }));
  const point = certificate.points[0]!;
  point.certification = options.certification;
  Object.assign(point, {
    requestedNotionalUsd, executableUsd: requestedNotionalUsd,
    executionCostBps, allInCostBps: executionCostBps,
    requestedRawInput, executedRawInput: requestedRawInput, fees: [],
  });
  Object.assign(point.outputs[0]!, {
    assetKey: review.identity.outputAssetKeys[0],
    deployment: `${review.producer.chain}:${review.producer.outputToken}`,
    decimals: review.producer.outputDecimals, observedAtSec: clockSec,
    rawUnits: options.rawUnits ?? (BigInt(requestedNotionalUsd) * 98n * 10n ** BigInt(review.producer.outputDecimals) / 100n).toString(),
  });
  return {
    assetId: review.identity.assetId, clockSec, certificate,
    route: route({
      ...(options.routeKey ? { routeKey: options.routeKey } : {}),
      executionModelId: certificate.modelId, executionCertificate: certificate,
      modelConfidence: options.modelConfidence ?? "medium", observationConfidence: "medium",
      coverageClass: options.certification,
      capacityCurve: [pt(point.requestedNotionalUsd, point.executableUsd, executionCostBps, point.maxCostBps)],
      ...(options.physicalResourceKeys ? { physicalResourceKeys: options.physicalResourceKeys } : {}),
    }),
  };
}

describe("typed Exit route identity", () => {
  it("projects fact identity independently of the opaque publication key", () => {
    const fact = makeNormalizedExitRoute({
      routeKey: "redemption:generation:redemption:colliding:coin:offchain-issuer",
      routeId: "redemption:coin:offchain-issuer", lane: "redemption",
    });
    expect(projectV9ExitEvaluationRoute(fact)).toMatchObject({ routeKey: fact.routeKey, routeId: fact.routeId, lane: fact.lane });
  });

  it.each([
    { name: "included", overrides: {}, included: true },
    { name: "excluded capacity", overrides: { scoreEligible: false, evidenceKind: "unsupported", capacityCurve: [] }, included: false },
    { name: "incomparable request", overrides: { capacityCurve: [] }, included: false },
    { name: "immaterial lower bound", overrides: { coverageClass: "exact-lower-bound", capacityCurve: [pt(1_000_000, 1)] }, included: false },
  ] satisfies { name: string; overrides: Partial<V9ExitEvaluationRoute>; included: boolean }[])(
    "retains exact identity for $name",
    ({ overrides, included }) => {
      const candidate = route({ routeKey: "opaque:generation", routeId: "redemption:coin:stablecoin-redeem", lane: "redemption", ...overrides });
      expect(evalRoutes([candidate]).routes[0]).toMatchObject({
        routeKey: candidate.routeKey, routeId: candidate.routeId, lane: candidate.lane, included,
      });
    },
  );
});

describe("selectV9ExitStressRequest", () => {
  it.each([
    [1, 1_000_000], [19_999_999, 1_000_000], [20_000_000, 1_000_000], [20_000_001, 1_000_000.05],
    [100_000_000, 5_000_000], [499_999_999, 24_999_999.95], [500_000_000, 25_000_000], [500_000_001, 25_000_000],
  ])("clamps supply %s at the $1m floor and $25m maximum without snapping", (supply, expected) => {
    const request = stressReq(supply);
    expect(request.requestedNotionalUsd).toBeCloseTo(expected, 6);
    expect(request.maxCostBps).toBe(200);
    expect(request.rawSupplyRequestUsd).toBeCloseTo(Math.min(25_000_000, Math.max(100_000, supply * 0.05)), 6);
  });

  it("retains a smaller measured execution as a lower bound at the $1m floor", () => {
    const result = evalRoutes([route({ coverageClass: "exact-lower-bound", capacityCurve: [pt(100_000, 100_000)] })], { circulatingUsd: 125_000 });
    expect(result.stressRequest!.requestedNotionalUsd).toBe(1_000_000);
    expect(result.routes[0]).toMatchObject({
      included: true, capacityPoint: { requestedNotionalUsd: 1_000_000, executableUsd: 100_000, completionRatio: 0.1 },
    });
    expect(result.reasons).not.toContain("no-viable-exit-path");
  });

  it.each(["high", "low"] as const)("keeps thin measured depth below the stress floor measured (%s confidence)", (modelConfidence) => {
    const candidate = route({ coverageClass: "exact-lower-bound", modelConfidence, capacityCurve: [pt(100_000, 6_900, 200)] });
    const previousPolicy = structuredClone(P.policy);
    previousPolicy.semantic.exit.stressRequest.floorUsd = 100_000;
    const before = evalRoutes([candidate], { circulatingUsd: 125_000 }, loadV9MethodologyPolicy(previousPolicy));
    const after = evalRoutes([candidate], { circulatingUsd: 125_000 });
    expect(after.stressRequest).toMatchObject({ requestedNotionalUsd: 1_000_000, rawSupplyRequestUsd: 100_000 });
    expect(after.routes[0]).toMatchObject({ included: true, exclusionReason: null, capacityPoint: { requestedNotionalUsd: 1_000_000, executableUsd: 6_900 } });
    expect(after.routes[0]!.components!.capacity).toBeLessThan(before.routes[0]!.components!.capacity!);
    expect(after.score).toBeLessThanOrEqual(before.score!);
    expect(after.score).toBeLessThanOrEqual(50);
    expect(after.limitedEvidenceCauses).toEqual([]);
    expect(after.reasons).not.toContain("missing-same-notional-route");
  });

  it.each([[999.99, false], [1_000, true]] as const)("tests thin capacity %s against the unfloored materiality boundary", (executableUsd, included) => {
    const result = evalRoutes([route({ coverageClass: "exact-lower-bound", capacityCurve: [pt(100_000, executableUsd)] })], { circulatingUsd: 125_000 });
    expect(result.routes[0]!.included).toBe(included);
    if (included) expect(result.score).toBeLessThanOrEqual(50);
  });

  it.each([null, 0, NaN, -1])("uses maximum stress sizing without usable supply (%s)", (supply) => {
    expect(stressReq(supply)).toMatchObject({ requestedNotionalUsd: 25_000_000, rawSupplyRequestUsd: 25_000_000 });
  });

  it("evaluates current routes at maximum stress without usable supply sizing", () => {
    const result = evalRoutes([route()], { circulatingUsd: null });
    expect(result.stressRequest?.requestedNotionalUsd).toBe(25_000_000);
    expect(result.routes[0]).toMatchObject({ included: true, capacityPoint: { requestedNotionalUsd: 25_000_000 } });
    expect(result.reasons).toContain("missing-same-notional-route");

    const lowerBound = evalRoutes([route({ capacityCurve: route().capacityCurve.filter((p) => p.requestedNotionalUsd < 25_000_000) })], { circulatingUsd: null });
    expect(lowerBound.primaryRouteKey).toBe("redemption:issuer");
    expect(lowerBound.routes[0]!.capacityPoint).toMatchObject({ requestedNotionalUsd: 25_000_000, executableUsd: 10_000_000, completionRatio: 0.4 });
  });

  it.each([20_000_000, 200_000_000])("has no request-grid cliff around %s supply", (boundary) => {
    const candidate = route({ coverageClass: "exact-lower-bound", capacityCurve: [pt(boundary * 0.05, boundary * 0.05)] });
    const below = evalRoutes([candidate], { circulatingUsd: boundary - 1 });
    const above = evalRoutes([candidate], { circulatingUsd: boundary + 1 });
    expect(above.stressRequest!.requestedNotionalUsd).toBeCloseTo((boundary + 1) * 0.05, 6);
    expect(above.routes[0]).toMatchObject({ included: true, capacityPoint: { executableUsd: boundary * 0.05 } });
    expect(above.routes[0]!.capacityPoint!.completionRatio).toBeCloseTo(boundary / (boundary + 1), 2);
    expect(above.limitedEvidenceCauses).toEqual([]);
    expect(Math.abs(above.score! - below.score!)).toBeLessThan(0.1);
  });
});

describe("exact physical rail precedence", () => {
  it.each([0, 40_000])("never substitutes modeled capacity for a current certificate proving $%s", (executableUsd) => {
    const certificate = makeExecutionCertificate();
    const point = certificate.points[0]!;
    point.executableUsd = executableUsd;
    point.certification = "exact-complete";
    const certified = route({
      routeKey: "certificate", executionModelId: certificate.modelId, executionCertificate: certificate,
      capacityCurve: [pt(point.requestedNotionalUsd, executableUsd, point.executionCostBps, point.maxCostBps)],
      physicalResourceKeys: ["endpoint:fixture"], failureDomains: ["certified:fixture"],
    });
    const modeled = route({
      routeKey: "modeled", physicalResourceKeys: ["endpoint:fixture"],
      capacityCurve: [pt(100_000, 100_000)], failureDomains: ["modeled:fixture"],
    });
    const request = stressReq(2_000_000);
    const result = resolveV9DistinctExitCapacity([modeled, certified], request, P);
    expect(result.includedRouteKeys).toEqual(["certificate"]);
    expect(result.valuedExecutableUsd).toBe(executableUsd);
    expect(resolveV9DistinctExitCapacity([certified, { ...modeled, routeKey: "other-rail", physicalResourceKeys: ["endpoint:other"] }], request, P).valuedExecutableUsd)
      .toBe(executableUsd + 100_000);
    expect(resolveV9DistinctExitCapacity([{ ...certified, observationState: "stale" as const }, modeled], request, P).includedRouteKeys)
      .toContain(modeled.routeKey);
  });

  it("keeps a higher-scoring model primary when the same-rail certificate is a lower bound", () => {
    const certificate = certificateRoute({ routeKey: "certificate", certification: "exact-lower-bound", physicalResourceKeys: ["rail:fixture"] });
    const modeled = route({ physicalResourceKeys: ["rail:fixture"] });
    const capacity = resolveV9DistinctExitCapacity([modeled, certificate.route], stressReq(2_000_000), P);
    expect(capacity.includedRouteKeys).toEqual(["certificate", "redemption:issuer"]);
    expect(capacity.valuedExecutableUsd).toBe(1_000_000);

    const result = evalRoutes([modeled, certificate.route], { circulatingUsd: 2_000_000, assetId: certificate.assetId, clockSec: certificate.clockSec });
    expect(result.primaryRouteKey).toBe("redemption:issuer");
    expect(result.routes.find((e) => e.routeKey === "certificate")).toMatchObject({ included: true });
    expect(result.routes.find((e) => e.routeKey === "certificate")!.score).not.toBeNull();
    expect(result.diversificationBonus).toBe(0);
  });

  it.each<{
    name: string; measured: number; claimed: number; ask: number; supersedes: boolean;
    certification?: "exact-complete" | "exact-lower-bound"; stale?: boolean;
  }>([
    { name: "arcusdc-sized sub-ask receipt", measured: 4_250_000, claimed: 12_580_000, ask: 25_000_000, supersedes: false },
    { name: "senrlusdv2-sized full-ask receipt", measured: 20_730_000, claimed: 44_590_000, ask: 20_730_000, supersedes: true },
    { name: "one dollar below modeled capacity", measured: 4_250_000, claimed: 4_250_001, ask: 25_000_000, supersedes: false },
    { name: "exact modeled capacity below ask", measured: 4_250_000, claimed: 4_250_000, ask: 25_000_000, supersedes: true },
    { name: "above modeled capacity below ask", measured: 4_250_001, claimed: 4_250_000, ask: 25_000_000, supersedes: true },
    { name: "above ask below modeled capacity", measured: 25_000_001, claimed: 30_000_000, ask: 25_000_000, supersedes: true },
    { name: "lower bound covering ask", measured: 25_000_000, claimed: 12_580_000, ask: 25_000_000, certification: "exact-lower-bound", supersedes: false },
    { name: "stale complete receipt covering ask", measured: 25_000_000, claimed: 12_580_000, ask: 25_000_000, stale: true, supersedes: false },
  ])("supersedes only measured coverage: $name", ({ measured, claimed, ask, supersedes, certification = "exact-complete", stale = false }) => {
    const certificate = certificateRoute({ routeKey: "certificate", certification, requestedNotionalUsd: measured, physicalResourceKeys: ["rail:fixture"] });
    if (stale) certificate.route.observationState = "stale";
    const modeled = route({
      routeKey: "modeled", physicalResourceKeys: ["rail:fixture"],
      capacityCurve: [pt(Math.max(ask, claimed), claimed)],
    });
    const circulatingUsd = ask / 0.05;
    const capacity = resolveV9DistinctExitCapacity([modeled, certificate.route], stressReq(circulatingUsd), P);
    expect(capacity.includedRouteKeys.includes("modeled")).toBe(!supersedes);
    expect(capacity.valuedExecutableUsd).toBe(supersedes ? Math.min(measured, ask) : Math.min(stale ? claimed : Math.max(measured, claimed), ask));

    const result = evalRoutes([modeled, certificate.route], { circulatingUsd, assetId: certificate.assetId, clockSec: certificate.clockSec });
    const modeledTrace = result.routes.find((e) => e.routeKey === "modeled")!;
    expect(modeledTrace.included).toBe(!supersedes);
    expect(modeledTrace.score === null).toBe(supersedes);
    expect(result.primaryRouteKey).toBe(supersedes ? "certificate" : "modeled");
    expect(result.diversificationBonus).toBe(0);
  });

  it("does not treat issuer identity as exact rail identity or independent capacity", () => {
    const left = route({ routeKey: "left", physicalResourceKeys: ["issuer:fixture"], failureDomains: ["issuer:fixture"] });
    const result = evalRoutes([left, { ...left, routeKey: "right" }]);
    expect(result.diversificationBonus).toBe(0);
    expect(result.diversificationRouteKey).toBeNull();
  });
});

describe("Exit circulating amount admission", () => {
  const supply: V9AssetFactsBase["supply"] = {
    status: {
      applicability: { state: "required", policyRuleId: "v9.supply.bridge-materiality", rationale: null, gapId: null },
      observationState: "bounded-unknown", evidenceRefIds: ["aggregate-supply"], gapIds: ["bridge-materiality"],
    },
    sourceGenerationId: "fixture-supply", sourceKind: "aggregate-circulating",
    circulatingUnits: null, referencePriceUsd: null, circulatingUsd: 100_000_000,
    chainDistribution: null, selectedBridgeRoutes: [], selectedRouteSupplyShare: null,
    unknownRouteSupplyShare: null, unreviewedRouteSupplyShare: null, failureDomains: [],
  };

  it("uses the known amount without claiming that the distribution is known", () => {
    expect(stressReq(selectV9ExitCirculatingUsd(supply))).toMatchObject({ rawSupplyRequestUsd: 5_000_000, requestedNotionalUsd: 5_000_000 });
  });

  it.each(["missing", "stale", "unsupported"] as const)("refuses a numeric amount whose observation is %s", (observationState) => {
    expect(selectV9ExitCirculatingUsd({ ...supply, status: { ...supply.status, observationState } })).toBeNull();
  });

  it("refuses an unknown amount even when distribution is the attributed gap", () => {
    expect(selectV9ExitCirculatingUsd({ ...supply, circulatingUsd: null })).toBeNull();
    expect(selectV9ExitCirculatingUsd({
      ...supply,
      status: { ...supply.status, applicability: { state: "required", policyRuleId: "v9.supply.current", rationale: null, gapId: null } },
    })).toBeNull();
  });
});

describe("evaluateV9Exit", () => {
  it.each(["missing-supply", "stale-supply", "unusable-supply"] as const)(
    "retains %s sizing uncertainty independently of route evidence",
    (sizingUncertaintyReason) => {
      const result = evalRoutes([route()], { circulatingUsd: null, supplyObservedAtSec: 1_700_000_000, sizingUncertaintyReason });
      expect(result.stressRequest).toMatchObject({ requestedNotionalUsd: 25_000_000, supplyObservedAtSec: 1_700_000_000, sizingUncertaintyReason });
      expect(result.routes).toHaveLength(1);
    },
  );

  it("lets a complete 1:1 redemption route support a strong exit score despite absent DEX depth", () => {
    const result = evalRoutes([route()]);
    expect(result.primaryRouteKey).toBe("redemption:issuer");
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("scores a reviewed terms gap with a usable curve and caps only bounded recovery", () => {
    const candidate = route({
      routeKey: "redemption:terms-gap", scoreEligible: false, coverageClass: "diagnostic",
      evidenceKind: "documented-terms", feeEvidence: "disclosed-unquantified",
    });
    const result = evalRoutes([candidate]);
    expect(result.primaryRouteKey).toBe(candidate.routeKey);
    expect(result.routes[0]).toMatchObject({ included: true, score: 70, components: { cost: 50 } });

    const missingCurve = evalRoutes([{ ...candidate, capacityCurve: [] }]);
    expect(missingCurve.score).toBe(50);
    expect(missingCurve.primaryRouteKey).toBeNull();
  });

  it("does not lift a measured zero because an alternative has no usable curve", () => {
    const measured = route({ capacityCurve: route().capacityCurve.map((p) => ({ ...p, executableUsd: 0, completionRatio: 0 })) });
    const missing = route({ routeKey: "missing", capacityCurve: [], feeEvidence: "disclosed-unquantified" });
    const result = evalRoutes([measured, missing]);
    expect(result.score).toBe(0);
    expect(result.primaryRouteKey).toBe(measured.routeKey);
  });

  it("charges institutional access once and keeps reviewed unquantified fees at unknown quality", () => {
    const result = evalRoutes([route({
      routeKey: "redemption:institutional", evidenceKind: "documented-terms",
      access: "issuer-api", holderEligibility: "verified-customer",
      settlement: "same-day", settlementDelaySec: 86_400, modelConfidence: "medium", feeEvidence: "disclosed-unquantified",
    })], { circulatingUsd: 1_000_000_000 });
    expect(result.routes[0]).toMatchObject({
      components: { access: 55, cost: 50, capacity: 78.3 },
      supportedComponentCeiling: 75.325, confidenceFactor: 0.85,
    });
    expect(result.routes[0]!.score).toBeCloseTo(64.02625, 10);
  });

  it("keeps a measured route score of 25 below bounded unknown rather than applying a floor", () => {
    const result = evalRoutes([route({
      access: "manual", modelConfidence: "low",
      capacityCurve: route().capacityCurve.map((p) => ({ ...p, executionCostBps: 920 / 7 })),
    })]);
    expect(result.routes[0]!.score).toBeCloseTo(25, 10);
    expect(result.score).toBe(25);
    expect(result.primaryRouteKey).not.toBeNull();
  });

  it("preserves route settlement delays independently of the request window", () => {
    const immediate = route({ routeKey: "redemption:immediate" });
    const nearTerm = route({ routeKey: "redemption:near-term", settlement: "same-day", settlementDelaySec: 86_400 });
    const queued = route({ routeKey: "redemption:queued", settlement: "queued", settlementDelaySec: 30 * 86_400 });
    const result = evalRoutes([queued, nearTerm, immediate]);
    expect(result.stressRequest?.comparisonWindowSec).toBe(300);
    expect(result.primaryRouteKey).toBe(immediate.routeKey);
    expect(result.routes.find((e) => e.routeKey === queued.routeKey)!.settlementDelaySec).toBe(30 * 86_400);
    expect(result.routes.find((e) => e.routeKey === nearTerm.routeKey)?.settlementDelaySec).toBe(86_400);
  });

  it("credits a 30-day queue without treating it as immediate capacity", () => {
    const result = evalRoutes([route({ routeKey: "redemption:30-day-queue", settlement: "queued", settlementDelaySec: 30 * 86_400 })]);
    expect(result.score).toBeGreaterThan(0);
    expect(result.primaryRouteKey).toBe("redemption:30-day-queue");
    expect(result.routes[0]?.settlementDelaySec).toBe(30 * 86_400);
  });

  it.each([
    {
      name: "eEARN-like unproven settlement bound",
      overrides: { settlementBoundUnproven: true, access: "whitelisted-onchain" as const, holderEligibility: "issuer-discretionary" as const, queueDepthUsd: 3_104.889979, execution: "opaque" as const, capacityCurve: [pt(100_000, 0), pt(1_000_000, 0)] },
      circulatingUsd: 5_800_000, reason: "unproven-settlement-bound", checkConfidence: true,
    },
    {
      name: "non-score-eligible queued zero",
      overrides: { access: "whitelisted-onchain" as const, holderEligibility: "issuer-discretionary" as const, queueDepthUsd: 3_104.889979, execution: "opaque" as const, capacityCurve: [pt(100_000, 0), pt(1_000_000, 0)] },
      circulatingUsd: 5_800_000, reason: "missing-same-notional-route", checkConfidence: false,
    },
    {
      name: "immaterial reserve lower bound",
      overrides: { routeKey: "redemption:autousd-operator-queue", settlementDelaySec: 30 * 86_400, capacityCurve: [pt(1_000_000, 1_000, 5)] },
      circulatingUsd: 20_000_000, reason: "missing-same-notional-route", checkConfidence: false,
    },
  ])("treats $name as bounded uncertainty instead of exhaustion", ({ overrides, circulatingUsd, reason, checkConfidence }) => {
    const candidate = route({
      routeKey: "redemption:eearn-operator-queue", routeFamily: "protocol-redemption", scoreEligible: false,
      evidenceKind: "live-reserve-state", settlement: "queued", capacityScoringHorizon: "queued", ...overrides,
    });
    const result = evalRoutes([candidate], { circulatingUsd, portfolioStatus: "reviewed-complete" });
    expect(result.score).toBe(50);
    expect(result.primaryRouteKey).toBeNull();
    expect(result.reasons).toContain(reason);
    expect(result.reasons).not.toContain("no-viable-exit-path");
    expect(result.routes[0]).toMatchObject({
      included: false, exclusionReason: reason, score: null,
      ...(checkConfidence ? { observationConfidence: "high", modelConfidence: "high", confidenceFactor: null, capacityPoint: null, components: null } : {}),
    });
  });

  it("prices queue backlog and minimum redemption gates through the reviewed constraint bands", () => {
    const base = route({
      routeKey: "redemption:queue-terms", capacityScoringHorizon: "queued", settlement: "queued",
      settlementDelaySec: 30 * 86_400, access: "issuer-api", dailyLimitUsd: 1_000_000,
    });
    const unconstrained = evalRoutes([base]);
    const constrained = evalRoutes([{ ...base, queueDepthUsd: 1_500_000, minRedeemUsd: 1_000_000 }]);
    expect(constrained.score!).toBeLessThan(unconstrained.score!);
    expect(constrained.routes[0]).toMatchObject({
      capacityScoringHorizon: "queued", settlementDelaySec: 30 * 86_400,
      queueDepthUsd: 1_500_000, dailyLimitUsd: 1_000_000, minRedeemUsd: 1_000_000,
      capsApplied: expect.arrayContaining(["queue-backlog:0.65", "minimum-redeem:0.75"]),
    });
  });

  it("does not let a weak optional route lower the best credible route", () => {
    const strong = route();
    const baseline = evalRoutes([strong]);
    const withWeak = evalRoutes([strong, dexRoute({
      routeKey: "dex:weak", capacityCurve: [pt(1_000_000, 10_000, 150)],
      failureDomains: ["redemption-rail:issuer"], physicalResourceKeys: ["rail:issuer"],
    })]);
    expect(withWeak.score).toBe(baseline.score);
    expect(withWeak.reasons).toContain("correlated-exit-routes");
  });

  it("scales bounded redundancy credit by the independent route's own quality", () => {
    const result = evalRoutes([route(), dexRoute({
      routeKey: "dex:independent", failureDomains: ["dex-protocol:independent"], physicalResourceKeys: ["pool:independent"],
    })]);
    expect(result.diversificationRouteKey).not.toBeNull();
    expect(result.diversificationBonus).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
    const primaryScore = result.routes.find((e) => e.routeKey === result.primaryRouteKey)!.score!;
    const backupScore = result.routes.find((e) => e.routeKey === result.diversificationRouteKey)!.score!;
    expect(result.diversificationBonus).toBeCloseTo(
      Math.min(100 - primaryScore, 100 * P.policy.semantic.exit.independentRouteBenefitLimit) * (backupScore / 100), 2,
    );
  });

  it("accepts a conservative exact lower bound and excludes diagnostic coverage", () => {
    const lowerBound = evalRoutes([route({ coverageClass: "exact-lower-bound" })]);
    const diagnostic = evalRoutes([route({ coverageClass: "diagnostic" })]);
    expect(lowerBound.score).not.toBeNull();
    expect(diagnostic.score).toBe(50);
    expect(diagnostic.primaryRouteKey).toBeNull();
    expect(diagnostic.reasons).toContain("unsupported-same-notional-route");
    expect(lowerBound.score!).toBeGreaterThan(diagnostic.score!);
  });

  it("does not infer measured absence from a reviewed diagnostic inventory", () => {
    const diagnosticRoute = route({ coverageClass: "diagnostic" });
    const reviewed = evalRoutes([diagnosticRoute], { portfolioStatus: "reviewed-complete" });
    const incomplete = evalRoutes([diagnosticRoute], { portfolioStatus: "incomplete" });
    expect(reviewed.score).toBe(50);
    expect(reviewed.reasons).not.toContain("no-viable-exit-path");
    expect(incomplete.score).toBe(reviewed.score);
    expect(incomplete.primaryRouteKey).toBeNull();
    expect(incomplete.reasons).toEqual(expect.arrayContaining(["unsupported-same-notional-route", "missing-same-notional-route"]));
  });

  it("does not self-suppress the missing-route echo when there is no route to diagnose", () => {
    const withDiag = evalRoutes([route({ coverageClass: "diagnostic" })], { portfolioStatus: "incomplete" });
    expect(withDiag.reasons).toEqual(["missing-same-notional-route", "unsupported-same-notional-route"]);
    expect(withDiag.primaryRouteKey).toBeNull();
    expect(withDiag.routes[0]).toMatchObject({ included: false, score: null, capacityPoint: null, exclusionReason: "unsupported-same-notional-route" });
    expect(withDiag.reasons).not.toContain("no-viable-exit-path");

    const withoutAny = evalRoutes([], { portfolioStatus: "incomplete" });
    expect(withoutAny.reasons).toEqual(["missing-same-notional-route"]);
    expect(withoutAny.score).toBe(50);
    expect(withoutAny.score).toBe(withDiag.score);
  });

  it("keeps unresolved optional output visible without invalidating a resolved route", () => {
    const result = evalRoutes([route(), route({ routeKey: "dex:unknown-output", outputResolved: false })]);
    expect(result.score).not.toBeNull();
    expect(result.reasons).not.toContain("unresolved-exit-output");
    expect(result.routes.find((t) => t.routeKey === "dex:unknown-output")?.exclusionReason).toBe("unresolved-exit-output");
  });

  it("applies output-value loss to capacity and route quality", () => {
    expect(evalRoutes([route({ outputValueRetention: 0.6 })]).score).toBeLessThan(evalRoutes([route()]).score!);
  });

  it("distinguishes the bounded-unknown cost sentinel from measured execution costs", () => {
    const traceAtCost = (executionCostBps: number) => evalRoutes([dexRoute({
      routeKey: "dex:measured-cost", feeEvidence: executionCostBps === 200 ? "disclosed-unquantified" : null,
      capacityCurve: [pt(1_000_000, 1_000_000, executionCostBps)],
    })]).routes.find((e) => e.routeKey === "dex:measured-cost")!;

    const boundedUnknown = traceAtCost(200);
    const favorable = traceAtCost(80);
    const adverse = traceAtCost(180);
    expect(boundedUnknown.components?.cost).toBe(50);
    expect(favorable.components?.cost).toBeGreaterThan(50);
    expect(favorable.score).toBeGreaterThan(boundedUnknown.score!);
    expect(adverse.components?.cost).toBeLessThan(50);
    expect(adverse.score).toBeLessThan(boundedUnknown.score!);

    const scores = [0, 20, 50, 80, 100, 120, 150, 180, 199].map((c) => traceAtCost(c).score!);
    expect(scores.every((s, i) => i === 0 || s <= scores[i - 1]!)).toBe(true);
  });

  it.each([
    { modelConfidence: "medium", modelFactor: 0.865, confidenceFactor: 0.865 },
    { modelConfidence: "high", modelFactor: 1, confidenceFactor: 0.865 },
    { modelConfidence: "low", modelFactor: 0.35, confidenceFactor: 0.35 },
  ] as const)("prices certificate credit by measured coverage and keeps a $modelConfidence review priced as reviewed", ({ modelConfidence, modelFactor, confidenceFactor }) => {
    const traces = [199.99, 200].map((executionCostBps) => {
      const built = certificateRoute({
        certification: "exact-complete", executionCostBps, modelConfidence,
        rawUnits: executionCostBps === 200 ? "98000000000000000000000" : "98000100000000000000000",
      });
      const admitted = admitExitExecutionCertificate({
        certificate: built.certificate, envelope: P, assetId: built.assetId, clockSec: built.clockSec,
        inputGenerationId: built.certificate.inputGenerationId, observationGenerationId: built.certificate.observationGenerationId,
        request: { requestedNotionalUsd: 100_000, maxCostBps: 200 },
      });
      expect(admitted.state).toBe("observed");
      const result = evalRoutes([
        built.route,
        route({ routeKey: "modeled:duplicate", evidenceKind: "documented-terms", capacityCurve: [pt(100_000, 100_000)] }),
      ], { circulatingUsd: 2_000_000, assetId: built.assetId, clockSec: built.clockSec });
      expect(result.primaryRouteKey).toBe("redemption:issuer");
      expect(result.diversificationBonus).toBe(0);
      expect(result.routes.find((e) => e.routeKey === "modeled:duplicate")!.included).toBe(false);
      const primary = result.routes.find((e) => e.routeKey === "redemption:issuer")!;
      expect(primary.confidenceDimensions!.model.factor).toBe(modelFactor);
      expect(primary.confidenceDimensions!.observation.factor).toBe(0.865);
      expect(primary.confidenceFactor).toBe(confidenceFactor);
      return primary;
    });
    expect(traces[0]!.factorContributions!.cost!.score).toBeCloseTo(0.005, 6);
    expect(traces[1]!.components!.cost).toBe(0);
    expect(traces[1]!.score).toBeLessThanOrEqual(traces[0]!.score!);
  });

  it("scales certificate credit by the share of the current stress ask it measured", () => {
    const lowerBound = certificateRoute({ routeKey: "certificate", certification: "exact-lower-bound", physicalResourceKeys: ["rail:fixture"] });
    const complete = certificateRoute({ routeKey: "certificate", certification: "exact-complete", physicalResourceKeys: ["rail:fixture"] });
    const factorAt = (subject: typeof lowerBound, circulatingUsd: number, routeOverride = subject.route) =>
      evalRoutes([routeOverride], { circulatingUsd, assetId: subject.assetId, clockSec: subject.clockSec })
        .routes.find((e) => e.routeKey === "certificate")!.confidenceFactor;
    expect(factorAt(lowerBound, 2_000_000)).toBeCloseTo(0.85, 10);
    expect(factorAt(complete, 2_000_000)).toBeCloseTo(0.85 + 0.1 * 0.15, 10);
    expect(factorAt(complete, 26_000_000)).toBeCloseTo(0.85 + (0.1 / 1.3) * 0.15, 10);
    expect(factorAt(complete, 2_000_000, { ...complete.route, observationConfidence: "low" as const })).toBeCloseTo(0.6, 10);
  });

  it("retains non-certificate on-chain medium model confidence at 0.75", () => {
    const trace = evalRoutes([route({ modelConfidence: "medium", observationConfidence: "medium" })]).routes[0]!;
    expect(trace.confidenceDimensions!.model.factor).toBe(0.75);
    expect(trace.confidenceDimensions!.observation.factor).toBe(0.85);
    expect(trace.confidenceFactor).toBe(0.75);
  });

  it("floors a zero-capacity route to zero instead of letting an undisclosed cost carry it", () => {
    const zeroCapacity = dexRoute({
      routeKey: "dex:undisclosed-cost", settlementDelaySec: 86_400, modelConfidence: "medium",
      capacityCurve: route().capacityCurve.map((p) => ({ ...p, executableUsd: 0, completionRatio: 0, executionCostBps: 200 })),
    });
    const trace = evalRoutes([zeroCapacity]).routes.find((e) => e.routeKey === "dex:undisclosed-cost");
    expect(trace).toMatchObject({
      included: false, capacityPoint: { executableUsd: 0 }, components: { cost: 50, capacity: 0 }, score: 0,
      capsApplied: expect.arrayContaining(["zero-executable-capacity"]),
    });
  });

  it("floors a route that fills a vanishing fraction of the stress request", () => {
    const evaluate = (executableUsd: number) =>
      evalRoutes([dexRoute({ routeKey: "dex:thin-depth", capacityCurve: [pt(25_000_000, executableUsd, 200)] })], { circulatingUsd: 1_000_000_000 })
        .routes.find((e) => e.routeKey === "dex:thin-depth");
    expect(evaluate(13.93)).toMatchObject({
      included: false, score: 0, capsApplied: expect.arrayContaining(["immaterial-executable-capacity"]),
    });
    const absoluteFloor = P.policy.semantic.exit.absoluteCapacityBreakpoints.find((p) => p.value > 0 && p.score > 0)!.value;
    const material = evaluate(absoluteFloor);
    expect(material?.score).toBeGreaterThan(0);
    expect(material?.score).toBeLessThanOrEqual(50);
    expect(material?.capsApplied).toContain("insufficient-completion:50");
    expect(material?.capsApplied).not.toContain("immaterial-executable-capacity");
  });

  it("tests materiality before output-value retention", () => {
    const evaluate = (executableUsd: number, outputValueRetention: number) =>
      evalRoutes([dexRoute({
        routeKey: "dex:retained-output", outputValueRetention, capacityCurve: [pt(25_000_000, executableUsd, 125)],
      })], { circulatingUsd: 1_000_000_000 }).routes[0];
    expect(evaluate(100_000, 0.9999)).toMatchObject({ capsApplied: expect.arrayContaining(["insufficient-completion:50"]) });
    expect(evaluate(100_000, 0.9999)?.capsApplied).not.toContain("immaterial-executable-capacity");
    expect(evaluate(99_999, 1)).toMatchObject({ score: 0, capsApplied: ["immaterial-executable-capacity"] });
    expect(evaluate(100_000, 0)).toMatchObject({ score: 0, capsApplied: ["zero-executable-capacity"] });
  });

  it("does not award a diversification benefit off a zero-capacity independent route", () => {
    const primary = route();
    const zeroIndependent = dexRoute({
      routeKey: "dex:zero-capacity-independent",
      failureDomains: ["dex-protocol:independent"], physicalResourceKeys: ["pool:independent"],
      capacityCurve: [pt(1_000_000, 0, 200)],
    });
    const alone = evalRoutes([primary]);
    const withZero = evalRoutes([primary, zeroIndependent]);
    expect(withZero.diversificationBonus).toBe(0);
    expect(withZero.score).toBe(alone.score);
  });

  it("uses Unicode route-key ordering to break equal-score ties independent of route order", () => {
    const first = route({ routeKey: "route:ä", failureDomains: ["redemption-rail:umlaut"], physicalResourceKeys: ["rail:umlaut"] });
    const second = dexRoute({ routeKey: "route:z", failureDomains: ["dex-protocol:z"], physicalResourceKeys: ["pool:z"] });
    const forward = evalRoutes([first, second]);
    expect(forward.primaryRouteKey).toBe("route:z");
    expect(forward.diversificationRouteKey).toBe("route:ä");
    expect(forward.routes.map((e) => e.routeKey)).toEqual(["route:z", "route:ä"]);
    expect(evalRoutes([second, first])).toEqual(forward);
  });

  it("selects the same stress capacity when unequal curve points are reversed", () => {
    const forwardRoute = route({ capacityCurve: [pt(100_000, 80_000, 10), pt(1_000_000, 600_000, 20), pt(10_000_000, 2_000_000, 30)] });
    const forward = evalRoutes([forwardRoute]);
    expect(forward.routes[0].capacityPoint).toMatchObject({ requestedNotionalUsd: 1_000_000, executableUsd: 600_000, completionRatio: 0.6, executionCostBps: 20 });
    expect(evalRoutes([{ ...forwardRoute, capacityCurve: [...forwardRoute.capacityCurve].reverse() }])).toEqual(forward);
  });

  it("projects explicit normalized route facts without route-family access inference", () => {
    expect(projectV9ExitEvaluationRoute(makeNormalizedExitRoute())).toMatchObject({
      access: "whitelisted-onchain", holderEligibility: "whitelisted-primary",
      modelConfidence: "high", settlement: "same-day", outputValueRetention: 1,
    });
  });

  it("falls back to the reviewed settlement horizon when the SLA is null", () => {
    const daysRoute = makeNormalizedExitRoute({
      routeKey: "redemption:generation:days", routeId: "days", routeFamily: "eventual-redemption",
      holderAccess: "retail-open", settlementModel: "bounded-delay", settlementSlaSec: null, scoreEligible: false,
      request: { requestedNotionalUsd: 1_000_000, maxCostBps: 200, settlementHorizonSec: 1_209_600 },
    });
    expect(projectV9ExitEvaluationRoute(daysRoute).settlementDelaySec).toBe(1_209_600);
  });
});

describe("reliable non-atomic redemption credit", () => {
  const redemptionRoute = (overrides: Partial<V9ExitEvaluationRoute> = {}) =>
    documentedRedemption({ routeKey: "redemption:eventual", routeFamily: "eventual-redemption", ...overrides });

  it.each(["eventual-redemption", "issuer-redemption", "protocol-redemption"] as const)(
    "credits reliable %s above zero but below atomic redemption",
    (routeFamily) => {
      const result = evalRoutes([redemptionRoute({ routeFamily })]);
      expect(result.primaryRouteKey).toBe("redemption:eventual");
      expect(result.routes[0].routeFamily).toBe(routeFamily);
      expect(result.score).toBeGreaterThan(55);
      const atomic = evalRoutes([redemptionRoute({ settlement: "atomic", settlementDelaySec: 300, routeFamily: "issuer-redemption", scoreEligible: true })]);
      expect(result.score).toBeLessThan(atomic.score!);
    },
  );

  it("scores a slower settlement tier strictly below a same-day tier", () => {
    const sameDay = evalRoutes([redemptionRoute()]);
    const days = evalRoutes([redemptionRoute({ settlement: "days", settlementDelaySec: 1_209_600 })]);
    expect(days.score!).toBeLessThan(sameDay.score!);
    expect(days.score!).toBeGreaterThan(50);
  });

  it.each(["eventual-redemption", "issuer-redemption", "protocol-redemption"] as const)(
    "does not promote documented zero-clearing %s terms to measured adversity",
    (routeFamily) => {
      const result = evalRoutes([redemptionRoute({ routeFamily, capacityCurve: [pt(1_000_000, 0, 200)] })]);
      expect(result.score).toBe(50);
      expect(result.primaryRouteKey).toBeNull();
      expect(result.routes[0]).toMatchObject({ routeFamily, included: false, score: null, exclusionReason: "missing-same-notional-route" });
      expect(result.reasons).toContain("missing-same-notional-route");
      expect(result.reasons).not.toContain("no-viable-exit-path");
    },
  );

  it("keeps an unresolved-output documented redemption excluded", () => {
    expect(evalRoutes([redemptionRoute({ outputResolved: false })]).score).toBe(50);
  });

  it.each([0, 1_000])("does not let a complete inventory turn documented $%i capacity into an exhaustion measurement", (executableUsd) => {
    const candidate = redemptionRoute({ capacityCurve: [pt(1_000_000, executableUsd, 10)] });
    for (const portfolioStatus of ["incomplete", "reviewed-complete"] as const) {
      const result = evalRoutes([candidate], { portfolioStatus });
      expect(result.score).toBe(50);
      expect(result.primaryRouteKey).toBeNull();
      expect(result.reasons).not.toContain("no-viable-exit-path");
      expect(result.routes[0]).toMatchObject({ included: false, score: null, exclusionReason: "missing-same-notional-route" });
    }
  });

  it.each([
    { observationState: "stale" }, { failureDomains: [] }, { evidenceKind: "measured-executable-depth" },
    { lane: "dex" }, { routeFamily: "dex-amm" },
  ] satisfies Partial<V9ExitEvaluationRoute>[])("rejects non-atomic evidence with %j", (overrides) => {
    const valid = evalRoutes([redemptionRoute()]);
    const invalid = evalRoutes([redemptionRoute(overrides)]);
    expect(valid.primaryRouteKey).toBe("redemption:eventual");
    expect(valid.score).toBeGreaterThan(50);
    expect(invalid.primaryRouteKey).toBeNull();
    expect(invalid.routes[0]).toMatchObject({ included: false, score: null, exclusionReason: "unsupported-same-notional-route" });
  });
});

describe("Lever 3 issuer/protocol redemption credit", () => {
  it("applies the settlement haircut: a 7-day issuer redemption scores strictly below a same-day one", () => {
    const sameDay = evalRoutes([documentedRedemption()]);
    const sevenDay = evalRoutes([documentedRedemption({ settlement: "days", settlementDelaySec: 604_800 })]);
    expect(sevenDay.score!).toBeLessThan(sameDay.score!);
    expect(sevenDay.score!).toBeGreaterThan(50);
  });

  it("does not classify an explicitly score-eligible protocol redemption as non-atomic", () => {
    const atomicProtocol = documentedRedemption({
      routeKey: "redemption:protocol-atomic", routeFamily: "protocol-redemption", scoreEligible: true,
      evidenceKind: "onchain-contract-state", settlement: "atomic", settlementDelaySec: 0,
    });
    expect(isV9CreditableNonAtomicRedemption({
      lane: atomicProtocol.lane, routeFamily: atomicProtocol.routeFamily, scoreEligible: atomicProtocol.scoreEligible,
      observationState: atomicProtocol.observationState, outputResolved: atomicProtocol.outputResolved,
      coverageClass: atomicProtocol.coverageClass, evidenceKind: atomicProtocol.evidenceKind,
      failureDomainCount: atomicProtocol.failureDomains.length,
    }, P)).toBe(false);

    const result = evalRoutes([atomicProtocol]);
    expect(result.primaryRouteKey).toBe("redemption:protocol-atomic");
    expect(result.score).toBeGreaterThan(50);
    expect(result.routes[0]?.included).toBe(true);
  });
});

describe("reviewed unquantified fees", () => {
  it.each([
    { name: "hchf-like HBAR-denominated dynamic fee", settlement: "immediate" as const, delay: 300 },
    { name: "usbd-like coreRate plus 75 bps fee", settlement: "atomic" as const, delay: 0 },
  ])("never reduces conservative credit when $name becomes disclosed", ({ settlement, delay }) => {
    const modeled = route({
      scoreEligible: false, coverageClass: "modelled-terms-lower-bound", evidenceKind: "documented-terms",
      settlement, settlementDelaySec: delay,
      capacityCurve: route().capacityCurve.map((p) => ({ ...p, executionCostBps: 200 })),
    });
    const opaque = evalRoutes([{ ...modeled, feeEvidence: "undisclosed-reviewed" }]);
    const disclosed = evalRoutes([{ ...modeled, feeEvidence: "disclosed-unquantified" }]);
    expect(disclosed.score).toBe(opaque.score);
    expect(disclosed.routes[0]).toMatchObject({ included: true, score: opaque.routes[0]!.score, components: opaque.routes[0]!.components });
  });

  it("does not replace a measured over-budget execution cost with the uncertain-fee assumption", () => {
    const measured = route({ feeEvidence: "disclosed-unquantified", capacityCurve: [pt(1_000_000, 0, 250)] });
    const result = evalRoutes([measured], { portfolioStatus: "reviewed-complete" });
    expect(result.score).toBe(0);
    expect(result.routes[0]).toMatchObject({ included: true, score: 0, capacityPoint: { executionCostBps: 250 } });
  });
});

describe("undisclosed-fee routes stay bounded at the portfolio level", () => {
  it.each(["both", "secondary"] as const)("withholds diversification for %s undisclosed fees despite independent routes", (fees) => {
    const routes = [
      route({ routeKey: "redemption:primary" }),
      dexRoute({ routeKey: "dex:backup", failureDomains: ["dex-protocol:backup"], physicalResourceKeys: ["pool:backup"] }),
    ];
    const disclosed = evalRoutes(routes);
    expect(disclosed.diversificationRouteKey).toBe("redemption:primary");
    expect(disclosed.diversificationBonus).toBeGreaterThan(0);

    const opaqueRoutes = routes.map((c) => ({
      ...c, ...(fees === "both" || c.routeKey === disclosed.diversificationRouteKey ? { feeEvidence: "undisclosed-reviewed" as const } : {}),
    }));
    const opaque = evalRoutes(opaqueRoutes);
    expect(opaque.diversificationRouteKey).toBe("redemption:primary");
    expect(opaque.diversificationBonus).toBe(0);
    expect(opaque.primaryRouteKey).toBe("dex:backup");
    expect(opaque.score).toBe(evalRoutes([opaqueRoutes[1]]).score);
  });
});

describe("stale exit-route observations", () => {
  const staleFactor = P.policy.semantic.exit.staleObservationConfidenceFactor;
  const atomicDex = (overrides: Partial<V9ExitEvaluationRoute> = {}) =>
    dexRoute({ settlement: "atomic", execution: "deterministic-onchain", ...overrides });

  it("derates a stale route instead of dropping it out of the capacity denominator", () => {
    const current = evalRoutes([atomicDex()]);
    const stale = evalRoutes([atomicDex({ observationState: "stale" })]);
    expect(stale.primaryRouteKey).toBe(current.primaryRouteKey);
    expect(stale.reasons).not.toContain("missing-runtime-route-evidence");
    expect(stale.reasons).not.toContain("no-viable-exit-path");
    expect(stale.score!).toBeGreaterThan(0);
    expect(stale.score!).toBeLessThan(current.score!);
    expect(staleFactor).toBeGreaterThan(0);
    expect(staleFactor).toBeLessThan(1);
    expect(stale.score!).toBeGreaterThan(current.score! * staleFactor * 0.95);
    expect(stale.score!).toBeLessThanOrEqual(current.score! * staleFactor * 1.05);
  });

  it("keeps a missing observation excluded without inventing exhaustion", () => {
    const missing = evalRoutes([atomicDex({ observationState: "missing" })], { portfolioStatus: "reviewed-complete" });
    expect(missing.primaryRouteKey).toBeNull();
    expect(missing.reasons).toContain("missing-runtime-route-evidence");
    expect(missing.reasons).not.toContain("no-viable-exit-path");
    expect(missing.score).toBe(50);
  });
});

describe("issuer payout output quality", () => {
  it("scores a tracked USDC payout at par like fiat and conservatively discounts a two-output basket", () => {
    const fiatFact = makeNormalizedExitRoute();
    const singleFact = makeNormalizedExitRoute({
      output: {
        ...fiatFact.output, kind: "tracked-stablecoin", assetKeys: ["usdc-circle"],
        valuation: { ...fiatFact.output.valuation!, basis: "price", referenceAssetKey: "usdc-circle" },
      },
    });
    const basketFact = makeNormalizedExitRoute({ output: { ...singleFact.output, assetKeys: ["usdc-circle", "usdt-tether"] } });
    const projected = [fiatFact, singleFact, basketFact].map(projectV9ExitEvaluationRoute);
    expect(projected.map((c) => c.outputQuality)).toEqual(["stable-single", "stable-single", "stable-basket"]);
    const traces = projected.map((c) => evalRoutes([route({
      outputQuality: c.outputQuality, outputValueRetention: c.outputValueRetention, outputResolved: c.outputResolved,
    })]).routes[0]!);
    expect(traces[1].components?.outputAssetQuality).toBe(100);
    expect(traces[1].score).toBe(traces[0].score);
    expect(traces[2].components?.outputAssetQuality).toBe(80);
    expect(traces[1].score! - traces[2].score!).toBeCloseTo(3, 10);
  });
});

describe("cause-aware Exit and max-feasible portfolios", () => {
  it("never loses the previous independent pair when a mutually correlated third route improves", () => {
    const left = route({ routeKey: "a", failureDomains: ["left"], physicalResourceKeys: ["a"] });
    const right = route({ routeKey: "b", failureDomains: ["right"], physicalResourceKeys: ["b"] });
    const correlated = route({
      routeKey: "c", failureDomains: ["left", "right"], physicalResourceKeys: ["c"],
      capacityCurve: route().capacityCurve.map((p) => ({ ...p, executionCostBps: 190 })),
    });
    const before = evalRoutes([left, right, correlated]);
    const after = evalRoutes([left, right, { ...correlated, capacityCurve: route().capacityCurve }]);
    expect(after.score).toBeGreaterThanOrEqual(before.score!);
    expect(after.primaryRouteKey).toBe("a");
    expect(after.diversificationRouteKey).toBe("b");
    expect(evalRoutes([correlated, right, left])).toMatchObject({
      score: before.score, primaryRouteKey: before.primaryRouteKey, diversificationRouteKey: before.diversificationRouteKey,
    });
  });

  it("improving any route never lowers Exit across correlation, 90/headroom and input-order branches", () => {
    for (const seed of [0, 40, 80, 120, 160, 199]) {
      const routes = ["a", "b", "c"].map((routeKey, idx) => route({
        routeKey, failureDomains: idx === 2 ? ["left", "right"] : [idx === 0 ? "left" : "right"],
        physicalResourceKeys: [routeKey],
        capacityCurve: route().capacityCurve.map((p) => ({ ...p, executionCostBps: Math.min(199, seed + idx * 5) })),
      }));
      const baseline = evalRoutes(routes).score!;
      for (let idx = 0; idx < routes.length; idx++) {
        for (const improvement of [1, 10, 50, 199]) {
          const improved = routes.map((c, i) => i !== idx ? c : {
            ...c, capacityCurve: c.capacityCurve.map((p) => ({ ...p, executionCostBps: Math.max(0, p.executionCostBps - improvement) })),
          });
          expect(evalRoutes(improved).score, `${seed}/${idx}/${improvement}`).toBeGreaterThanOrEqual(baseline);
          expect(evalRoutes([...improved].reverse()).score).toBe(evalRoutes(improved).score);
        }
      }
    }
  });

  it("keeps fee-cause refinement monotone but never exempts same-notional cost admission", () => {
    const backup = route({ routeKey: "backup", observationConfidence: "medium", failureDomains: ["backup"], physicalResourceKeys: ["backup"] });
    const price = (cause: "C" | "B", overBudget = false) => {
      const missing = gap(cause, "formula");
      const primary = route({
        routeKey: "primary", observationConfidence: "medium", feeEvidence: "disclosed-unquantified",
        factorStatuses: { cost: missing.status }, gaps: [missing.gap],
        capacityCurve: route().capacityCurve.map((p) => ({ ...p, executionCostBps: overBudget ? p.maxCostBps + 1 : p.executionCostBps })),
      });
      return evalRoutes([primary, backup]);
    };
    const opaque = price("C");
    const publicFormula = price("B");
    expect(publicFormula.score).toBeGreaterThanOrEqual(opaque.score!);
    expect(opaque.diversificationBonus).toBe(0);
    expect(publicFormula.diversificationBonus).toBeGreaterThan(0);
    expect(publicFormula.routes.find((t) => t.routeKey === "primary")).toMatchObject({ rawSameNotionalCostBps: null, components: { cost: null } });
    const overBudget = price("B", true);
    expect(overBudget.routes.find((t) => t.routeKey === "primary")!.included).toBe(false);
    expect(overBudget.diversificationBonus).toBe(0);
  });

  it("uses stable equal-score keys over 64 candidates and rejects unproven overflow without truncation", () => {
    const candidates = Array.from({ length: 64 }, (_, i) => route({
      routeKey: `r:${String(i).padStart(2, "0")}`, observationConfidence: "medium",
      failureDomains: [`domain:${i}`], physicalResourceKeys: [`resource:${i}`],
    }));
    const first = evalRoutes(candidates);
    expect(first.primaryRouteKey).toBe("r:00");
    expect(first.diversificationRouteKey).toBe("r:01");
    expect(evalRoutes([...candidates].reverse()).score).toBe(first.score);
    expect(() => evalRoutes([...candidates, route({ routeKey: "r:64" })])).toThrow("route-inventory-over-limit");
  });

  it.each(["A", "B"] as const)("omits %s holder/fee/confidence gaps while preserving measured restrictions", (cause) => {
    const missing = gap(cause, "gap");
    const unknown = route({
      holderEligibility: "unknown", observationConfidence: "unknown", modelConfidence: "unknown",
      capacityEvidenceTier: "unknown", feeEvidence: "disclosed-unquantified",
      factorStatuses: {
        holderEligibility: missing.status, observationConfidence: missing.status,
        executionConfidence: missing.status, capacityEvidenceTier: missing.status, cost: missing.status,
      },
      gaps: [missing.gap],
    });
    const trace = evalRoutes([unknown]).routes[0]!;
    expect(trace.confidenceFactor).toBe(1);
    expect(trace.components!.cost).toBeNull();
    expect(trace.rawSameNotionalCostBps).toBeNull();
    expect(trace.confidenceDimensions!.capacityMethod).toMatchObject({ cause, factor: 1 });

    const restricted = evalRoutes([route({
      ...unknown, access: "manual", holderEligibility: "issuer-discretionary",
      factorStatuses: { ...unknown.factorStatuses, holderEligibility: undefined },
      queueDepthUsd: 10_000_000, dailyLimitUsd: 1_000_000, minRedeemUsd: 1_000_000,
    })]).routes[0]!;
    expect(restricted.capsApplied).toContain("minimum-redeem:0.75");
    expect(restricted.score).toBeLessThan(trace.score!);
  });

  it.each(["C", "U"] as const)("prices unknown %s subfactors at 50 while retaining their cause", (cause) => {
    const missing = gap(cause, "gap");
    const trace = evalRoutes([route({
      observationConfidence: "unknown", holderEligibility: "unknown", capacityEvidenceTier: "unknown",
      capacityCurve: route().capacityCurve.map((p) => ({ ...p, executionCostBps: 200 })),
      factorStatuses: {
        observationConfidence: missing.status, holderEligibility: missing.status,
        cost: missing.status, capacityEvidenceTier: missing.status,
      },
      gaps: [missing.gap],
    })]).routes[0]!;
    expect(trace.confidenceDimensions!.observation.factor).toBe(0.6);
    expect(trace.confidenceDimensions!.capacityMethod).toMatchObject({ factor: 0.75, cause });
    expect(trace.components).toMatchObject({ access: 50, cost: 50, capacity: 76, outputAssetQuality: 100 });
    expect(trace.capsApplied.some((cap) => cap.startsWith("fee-evidence:"))).toBe(false);
  });

  it.each(["C", "U"] as const)("preserves published %s factor causes with cause-neutral whole-Exit pricing", (cause) => {
    const capacity = gap("U", "capacity");
    const cost = gap(cause, "cost");
    const result = evalRoutes([route({
      observationState: "missing", status: capacity.status, capacityCurve: [],
      factorStatuses: { capacity: capacity.status, cost: cost.status }, gaps: [capacity.gap, cost.gap],
    })]);
    expect(result.limitedEvidenceCauses).toEqual(cause === "C" ? ["C", "U"] : ["U"]);
    expect(result.score).toBe(50);
    expect(result.causeGapIds).toEqual(["capacity", "cost"]);
  });

  it.each(["C", "U"] as const)("prices only uncovered supply at the %s unknown value", (cause) => {
    const missing = gap(cause, "partial-census");
    for (const coveredShare of [0, 0.6, 0.995]) {
      const result = evalExit({
        circulatingUsd: 20_000_000, portfolioStatus: "incomplete", portfolioFactStatus: missing.status,
        verifiedNoPoolsSupplyShare: coveredShare, gaps: [missing.gap], routes: [],
      });
      expect(result.score).toBeCloseTo((1 - coveredShare) * P.policy.semantic.unknownQuality.exit[cause], 2);
      expect(result.limitedEvidenceCauses).toEqual([cause]);
      expect(result.reasons).not.toContain("no-viable-exit-path");
    }
  });

  it("never admits A-stale history as current capacity or as a charged floor", () => {
    const missing = gap("A", "stale");
    const result = evalRoutes([route({ observationState: "stale", status: missing.status, factorStatuses: { capacity: missing.status }, gaps: [missing.gap] })]);
    expect(result).toMatchObject({ score: null, aggregationDisposition: "excluded-a-b", primaryRouteKey: null, limitedEvidenceCauses: [] });
    expect(result.routes[0]!.capacityPoint).toBeNull();
    expect(evalRoutes([route({ observationState: "stale" })]).routes[0]!.confidenceFactor).toBe(0.6);
  });

  it("keeps an admitted exhaustive zero at zero even when A/B alternatives are unavailable", () => {
    const missing = gap("B", "alternative");
    const zero = route({ capacityCurve: route().capacityCurve.map((p) => ({ ...p, executableUsd: 0, completionRatio: 0 })) });
    const alternative = route({ routeKey: "missing", observationState: "missing", status: missing.status, factorStatuses: { capacity: missing.status }, gaps: [missing.gap] });
    const result = evalRoutes([zero, alternative]);
    expect(result.score).toBe(0);
    expect(result.reasons).toContain("no-viable-exit-path");
  });

  it.each(["A", "B", "C", "U"] as const)("retains unknown Exit for negligible DEX capacity and an unmeasured %s rail", (cause) => {
    const missing = gap(cause, "unavailable-rail");
    const unavailable = route({
      routeKey: "redemption:unavailable", observationState: "missing", status: missing.status,
      factorStatuses: { capacity: missing.status }, gaps: [missing.gap], capacityCurve: [],
    });
    for (const executableUsd of [0, 1, 9_999]) {
      const tiny = dexRoute({
        routeKey: "dex:xgz-goldzip",
        capacityCurve: route().capacityCurve.map((p) => ({
          ...p, executableUsd: Math.min(executableUsd, p.requestedNotionalUsd),
          completionRatio: Math.min(executableUsd / p.requestedNotionalUsd, 1),
        })),
      });
      const baseline = evalRoutes([unavailable]);
      for (const routes of [[tiny, unavailable], [unavailable, tiny]]) {
        const result = evalRoutes(routes);
        expect(result).toMatchObject({
          score: baseline.score, aggregationDisposition: baseline.aggregationDisposition,
          limitedEvidenceCauses: baseline.limitedEvidenceCauses, primaryRouteKey: null, supportedComponentKeys: [],
        });
        expect(result.causeGapIds).toContain(missing.gap.gapId);
        expect(result.reasons).toContain("missing-same-notional-route");
        expect(result.reasons).not.toContain("no-viable-exit-path");
        expect(result.routes.find((t) => t.routeKey === tiny.routeKey)).toMatchObject({ score: 0, included: false, capacityPoint: { executableUsd } });
      }
      const exhausted = evalRoutes([tiny, route({ capacityCurve: tiny.capacityCurve })], { portfolioStatus: "reviewed-complete" });
      expect(exhausted.score).toBe(0);
      expect(exhausted.reasons).toContain("no-viable-exit-path");
      expect(evalRoutes([{ ...tiny, capacityCurve: route().capacityCurve, outputValueRetention: 0 }, unavailable]).score).toBe(0);
      expect(evalRoutes([tiny]).score).toBe(50);
      expect(evalRoutes([tiny], { portfolioStatus: "reviewed-complete" }).score).toBe(0);

      const inventory = evalRoutes([tiny], { portfolioStatus: "reviewed-complete", portfolioFactStatus: missing.status, gaps: [missing.gap] });
      expect(inventory.score).toBe(evalRoutes([], { portfolioStatus: "reviewed-complete", portfolioFactStatus: missing.status, gaps: [missing.gap] }).score);
      expect(inventory.reasons).not.toContain("no-viable-exit-path");
    }
  });

  it.each(["C", "U"] as const)("does not turn a bounded %s empty census into measured exhaustion", (cause) => {
    const missing = gap(cause, "unavailable-census");
    const result = evalRoutes([], { portfolioStatus: "reviewed-complete", portfolioFactStatus: missing.status, gaps: [missing.gap] });
    expect(result.score).toBe(P.policy.semantic.unknownQuality.exit[cause]);
    expect(result.limitedEvidenceCauses).toEqual([cause]);
    expect(result.reasons).not.toContain("no-viable-exit-path");
  });

  it("caps cause-U unavailable Exit at priorVerifiedEmptyExitCeiling without fabricating no-viable-exit-path (v10.50)", () => {
    const missing = gap("U", "unavailable-census");
    const ceiling = {
      scoreCeiling: 0,
      verifiedAtSec: 1_795_000_000,
      sourceGenerationId: "dex-liquidity-1795000000",
      maxAgeSec: 172_800,
    };
    const uncapped = evaluateV9Exit({
      circulatingUsd: 20_000_000, portfolioStatus: "incomplete",
      portfolioFactStatus: missing.status, gaps: [missing.gap], routes: [],
    }, V9_CANDIDATE_POLICY_V1);
    expect(uncapped.score).toBe(50);

    const capped = evaluateV9Exit({
      circulatingUsd: 20_000_000, portfolioStatus: "incomplete",
      portfolioFactStatus: missing.status, gaps: [missing.gap], routes: [],
      priorVerifiedEmptyExitCeiling: ceiling,
    }, V9_CANDIDATE_POLICY_V1);
    expect(capped.score).toBe(0);
    expect(capped.aggregationDisposition).toBe("included");
    expect(capped.limitedEvidenceCauses).toEqual(["U"]);
    expect(capped.reasons).toContain("missing-same-notional-route");
    expect(capped.reasons).not.toContain("no-viable-exit-path");

    // Any positive score-eligible route ignores the prior verified-empty ceiling.
    const recovered = evaluateV9Exit({
      circulatingUsd: 20_000_000,
      routes: [route()],
      priorVerifiedEmptyExitCeiling: ceiling,
    }, V9_CANDIDATE_POLICY_V1);
    expect(recovered.score).toBeGreaterThan(0);
    expect(recovered.primaryRouteKey).not.toBeNull();
  });
});

describe("bounded settlement subfactors", () => {
  it("retains live capacity and output while bounding an unresolved completion term", () => {
    const candidate = route({
      scoreEligible: false, settlementBoundUnproven: true, settlement: "queued",
      settlementDelaySec: 30 * 86_400, coverageClass: "exact-lower-bound",
    });
    expect(evalRoutes([candidate]).routes[0]).toMatchObject({
      included: true, score: 70, components: { settlement: 50, capacity: 76, outputAssetQuality: 100 },
    });
    const unsupportedOutput = evalRoutes([{ ...candidate, outputResolved: false }]);
    expect(unsupportedOutput.primaryRouteKey).toBeNull();
    expect(unsupportedOutput.routes[0]!.exclusionReason).toBe("unresolved-exit-output");
  });

  it("excludes physical-delivery routes with not-applicable USD capacity without dollar credit or unresolved-output reasons", () => {
    const missingStatus = gap("U", "physical-placeholder");
    const settlementGap = gap("C", "physical-settlement");
    const projectedPhysical = projectV9ExitEvaluationRoute({
      routeKey: "redemption:gen:redemption:gold:offchain-issuer", routeId: "redemption:gold:offchain-issuer",
      lane: "redemption", sourceGenerationId: "gen", routeFamily: "eventual-redemption",
      holderAccess: "institutional-eligible", executionModel: "discretionary", executionCertainty: "conditional",
      modelConfidence: "low", observationConfidence: "low", capacityEvidenceTier: "documented", observationHistory: null,
      evidenceKind: "documented-terms", coverageClass: "diagnostic", capacityScoringHorizon: "eventual",
      settlementModel: "bounded-delay", settlementSlaSec: null, queueDepthUsd: null, dailyLimitUsd: null, minRedeemUsd: null,
      settlementEvidenceRefIds: ["ev:physical"], physicalResourceKeys: ["issuer:gold"], status: missingStatus.status,
      factorStatuses: {
        capacity: {
          applicability: { state: "not-applicable", policyRuleId: "v9.exit.physical-delivery-capacity", rationale: "Physical-commodity delivery redeems for metal rather than dollars; same-notional USD exit capacity is not applicable.", gapId: null },
          observationState: "known", evidenceRefIds: ["ev:physical"], gapIds: [],
        },
        settlement: settlementGap.status,
      },
      scoreEligible: false, request: null, capacityCurve: [], failureDomains: [{ kind: "redemption-rail", key: "gold" }],
      output: {
        status: { applicability: { state: "required", policyRuleId: "v9.exit.output-valuation", rationale: null, gapId: null }, observationState: "known", evidenceRefIds: ["ev:physical-out"], gapIds: [] },
        kind: "physical-commodity-delivery", sameNotionalEligible: false, assetKeys: ["commodity:xau"], basketWeights: [], valuation: null,
      },
    });
    expect(projectedPhysical).toMatchObject({ applicability: "not-applicable", outputResolved: false });

    const alone = evaluateV9Exit({
      circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete",
      gaps: [missingStatus.gap, settlementGap.gap], routes: [projectedPhysical],
    }, V9_CANDIDATE_POLICY_V1);
    expect(alone).toMatchObject({ score: 50, aggregationDisposition: "included", primaryRouteKey: null, limitedEvidenceCauses: ["U"], causeGapIds: [] });
    expect(alone.reasons).not.toContain("unresolved-exit-output");
    expect(alone.routes[0]).toMatchObject({
      included: false, score: null, scoringDisposition: "not-applicable",
      effectiveScoringWeight: 0, exclusionReason: null, cause: null, causeGapIds: [],
    });

    const usd = dexRoute({ routeKey: "dex:gold:usdc" });
    const withUsd = evalRoutes([usd, projectedPhysical]);
    const usdOnly = evalRoutes([usd]);
    expect(withUsd.score).toBe(usdOnly.score);
    expect(withUsd.primaryRouteKey).toBe(usd.routeKey);
  });
});
