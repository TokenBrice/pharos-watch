import { describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9AssetFactsBase, V9FactStatusV2, V9FactGapV3 } from "../../types/safety-score-v9-facts";
import { createV9FactGapV3 } from "../safety-score-v9/reasons";
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
  makeDocumentedRedemption,
  makeNormalizedExitRoute,
} from "./safety-score-v9-exit.test-support";
import { admitExitExecutionCertificate, exitExecutionInputGenerationId, exitExecutionReviewDigest, validateExitExecutionModelReviews } from "../safety-score-v9/exit-execution";
import { makeExecutionCertificate } from "./safety-score-v9-exit-execution.test-support";
import executionReviews from "../../data/safety-score-v9/exit-execution-model-reviews-v1.json";
import { domainDigest } from "../safety-score-v9/primitives";

function route(overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute {
  return makeExitRoute({ capacityEvidenceTier: "live-direct", ...overrides });
}
function documentedRedemption(overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute {
  return makeDocumentedRedemption({ capacityEvidenceTier: "documented", ...overrides });
}

describe("typed Exit route identity", () => {
  it("projects fact identity independently of the opaque publication key", () => {
    const fact = makeNormalizedExitRoute({
      routeKey: "redemption:generation:redemption:colliding:coin:offchain-issuer",
      routeId: "redemption:coin:offchain-issuer",
      lane: "redemption",
    });
    expect(projectV9ExitEvaluationRoute(fact)).toMatchObject({
      routeKey: fact.routeKey, routeId: fact.routeId, lane: fact.lane,
    });
  });

  it.each([
    { name: "included", overrides: {}, included: true },
    { name: "excluded capacity", overrides: { scoreEligible: false, evidenceKind: "unsupported", capacityCurve: [] }, included: false },
    { name: "incomparable request", overrides: { capacityCurve: [] }, included: false },
    { name: "immaterial lower bound", overrides: {
      coverageClass: "exact-lower-bound",
      capacityCurve: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1, completionRatio: 0.000001, executionCostBps: 0 }],
    }, included: false },
  ] satisfies { name: string; overrides: Partial<V9ExitEvaluationRoute>; included: boolean }[])(
    "retains exact identity for $name",
    ({ overrides, included }) => {
      const candidate = route({
        routeKey: "opaque:generation", routeId: "redemption:coin:stablecoin-redeem", lane: "redemption",
        ...overrides,
      });
      const result = evaluateV9Exit({
        circulatingUsd: 20_000_000, routes: [candidate],
      }, V9_CANDIDATE_POLICY_V1);
      expect(result.routes[0]).toMatchObject({
        routeKey: candidate.routeKey, routeId: candidate.routeId, lane: candidate.lane, included,
      });
    },
  );
});

describe("selectV9ExitStressRequest", () => {
  it("uses the continuous clamped supply-relative request instead of the observation grid", () => {
    expect(selectV9ExitStressRequest(100_000_000, V9_CANDIDATE_POLICY_V1)).toMatchObject({
      rawSupplyRequestUsd: 5_000_000,
      requestedNotionalUsd: 5_000_000,
      maxCostBps: 200,
    });
    expect(selectV9ExitStressRequest(100_000, V9_CANDIDATE_POLICY_V1)?.requestedNotionalUsd).toBe(100_000);
    expect(selectV9ExitStressRequest(10_000_000_000, V9_CANDIDATE_POLICY_V1)?.requestedNotionalUsd).toBe(25_000_000);
  });

  it.each([null, 0, NaN, -1])("uses maximum stress sizing without usable supply (%s)", (supply) => {
    expect(selectV9ExitStressRequest(supply, V9_CANDIDATE_POLICY_V1))
      .toMatchObject({ requestedNotionalUsd: 25_000_000, rawSupplyRequestUsd: 25_000_000 });
  });

  it("evaluates current routes at maximum stress without usable supply sizing", () => {
    const result = evaluateV9Exit({ circulatingUsd: null, routes: [route()] }, V9_CANDIDATE_POLICY_V1);
    expect(result.stressRequest?.requestedNotionalUsd).toBe(25_000_000);
    expect(result.routes[0]).toMatchObject({ included: true, capacityPoint: { requestedNotionalUsd: 25_000_000 } });
    expect(result.reasons).toContain("missing-same-notional-route");
    const lowerBound = evaluateV9Exit({
      circulatingUsd: null,
      routes: [route({ capacityCurve: route().capacityCurve.filter((point) => point.requestedNotionalUsd < 25_000_000) })],
    }, V9_CANDIDATE_POLICY_V1);
    expect(lowerBound.primaryRouteKey).toBe("redemption:issuer");
    expect(lowerBound.routes[0]!.capacityPoint).toMatchObject({
      requestedNotionalUsd: 25_000_000, executableUsd: 10_000_000, completionRatio: 0.4,
    });
  });

  it.each([2_000_000, 20_000_000, 200_000_000])("has no request-grid cliff around %s supply", (boundary) => {
    const candidate = route({ coverageClass: "exact-lower-bound", capacityCurve: [{
      requestedNotionalUsd: boundary * 0.05, maxCostBps: 200,
      executableUsd: boundary * 0.05, completionRatio: 1, executionCostBps: 0,
    }] });
    const below = evaluateV9Exit({ circulatingUsd: boundary - 1, routes: [candidate] }, V9_CANDIDATE_POLICY_V1);
    const above = evaluateV9Exit({ circulatingUsd: boundary + 1, routes: [candidate] }, V9_CANDIDATE_POLICY_V1);
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
      capacityCurve: [{
        requestedNotionalUsd: point.requestedNotionalUsd, maxCostBps: point.maxCostBps,
        executableUsd, completionRatio: executableUsd / point.requestedNotionalUsd,
        executionCostBps: point.executionCostBps,
      }],
      physicalResourceKeys: ["endpoint:fixture"], failureDomains: ["certified:fixture"],
    });
    const modeled = route({ routeKey: "modeled", physicalResourceKeys: ["endpoint:fixture"],
      failureDomains: ["modeled:fixture"] });
    const request = selectV9ExitStressRequest(2_000_000, V9_CANDIDATE_POLICY_V1);
    const result = resolveV9DistinctExitCapacity([modeled, certified], request, V9_CANDIDATE_POLICY_V1);
    expect(result.includedRouteKeys).toEqual(["certificate"]);
    expect(result.valuedExecutableUsd).toBe(executableUsd);
    const otherRail = { ...modeled, routeKey: "other-rail", physicalResourceKeys: ["endpoint:other"] };
    expect(resolveV9DistinctExitCapacity([certified, otherRail], request, V9_CANDIDATE_POLICY_V1).valuedExecutableUsd)
      .toBe(executableUsd + request.requestedNotionalUsd);
    const expired = { ...certified, observationState: "stale" as const };
    expect(resolveV9DistinctExitCapacity([expired, modeled], request, V9_CANDIDATE_POLICY_V1).includedRouteKeys)
      .toContain(modeled.routeKey);
  });

  it("does not treat issuer identity as exact rail identity or independent capacity", () => {
    const left = route({ routeKey: "left", physicalResourceKeys: ["issuer:fixture"],
      failureDomains: ["issuer:fixture"] });
    const right = { ...left, routeKey: "right" };
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [left, right] }, V9_CANDIDATE_POLICY_V1);
    expect(result.diversificationBonus).toBe(0);
    expect(result.diversificationRouteKey).toBeNull();
  });
});

describe("Exit circulating amount admission", () => {
  const supply: V9AssetFactsBase["supply"] = {
    status: {
      applicability: { state: "required", policyRuleId: "v9.supply.bridge-materiality", rationale: null, gapId: null },
      observationState: "bounded-unknown",
      evidenceRefIds: ["aggregate-supply"],
      gapIds: ["bridge-materiality"],
    },
    sourceGenerationId: "fixture-supply",
    sourceKind: "aggregate-circulating",
    circulatingUnits: null,
    referencePriceUsd: null,
    circulatingUsd: 100_000_000,
    chainDistribution: null,
    selectedBridgeRoutes: [],
    selectedRouteSupplyShare: null,
    unknownRouteSupplyShare: null,
    unreviewedRouteSupplyShare: null,
    failureDomains: [],
  };

  it("uses the known amount without claiming that the distribution is known", () => {
    expect(selectV9ExitStressRequest(selectV9ExitCirculatingUsd(supply), V9_CANDIDATE_POLICY_V1))
      .toMatchObject({ rawSupplyRequestUsd: 5_000_000, requestedNotionalUsd: 5_000_000 });
  });

  it.each(["missing", "stale", "unsupported"] as const)("refuses a numeric amount whose observation is %s", (observationState) => {
    expect(selectV9ExitCirculatingUsd({
      ...supply,
      status: { ...supply.status, observationState },
    })).toBeNull();
  });

  it("refuses an unknown amount even when distribution is the attributed gap", () => {
    expect(selectV9ExitCirculatingUsd({ ...supply, circulatingUsd: null })).toBeNull();
    expect(selectV9ExitCirculatingUsd({
      ...supply,
      status: {
        ...supply.status,
        applicability: { state: "required", policyRuleId: "v9.supply.current", rationale: null, gapId: null },
      },
    })).toBeNull();
  });
});

describe("evaluateV9Exit", () => {
  it.each(["missing-supply", "stale-supply", "unusable-supply"] as const)(
    "retains %s sizing uncertainty independently of route evidence",
    (sizingUncertaintyReason) => {
      const result = evaluateV9Exit({
        circulatingUsd: null,
        supplyObservedAtSec: 1_700_000_000,
        sizingUncertaintyReason,
        routes: [route()],
      }, V9_CANDIDATE_POLICY_V1);
      expect(result.stressRequest).toMatchObject({
        requestedNotionalUsd: 25_000_000,
        supplyObservedAtSec: 1_700_000_000,
        sizingUncertaintyReason,
      });
      expect(result.routes).toHaveLength(1);
    },
  );
  it("lets a complete 1:1 redemption route support a strong exit score despite absent DEX depth", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [route()] }, V9_CANDIDATE_POLICY_V1);
    expect(result.primaryRouteKey).toBe("redemption:issuer");
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("scores a reviewed terms gap with a usable curve and caps only bounded recovery", () => {
    const candidate = route({
      routeKey: "redemption:terms-gap", scoreEligible: false, coverageClass: "diagnostic",
      evidenceKind: "documented-terms", feeEvidence: "disclosed-unquantified",
    });
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [candidate] }, V9_CANDIDATE_POLICY_V1);
    expect(result.primaryRouteKey).toBe(candidate.routeKey);
    expect(result.routes[0]).toMatchObject({ included: true, score: 70, components: { cost: 50 } });
    const missingCurve = evaluateV9Exit({
      circulatingUsd: 20_000_000, routes: [{ ...candidate, capacityCurve: [] }],
    }, V9_CANDIDATE_POLICY_V1);
    expect(missingCurve.score).toBe(50);
    expect(missingCurve.primaryRouteKey).toBeNull();
  });

  it("does not lift a measured zero because an alternative has no usable curve", () => {
    const measured = route({ capacityCurve: route().capacityCurve.map((point) => ({
      ...point, executableUsd: 0, completionRatio: 0,
    })) });
    const missing = route({ routeKey: "missing", capacityCurve: [], feeEvidence: "disclosed-unquantified" });
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [measured, missing] }, V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(0);
    expect(result.primaryRouteKey).toBe(measured.routeKey);
  });

  it("charges institutional access once and keeps reviewed unquantified fees at unknown quality", () => {
    const result = evaluateV9Exit({
      circulatingUsd: 1_000_000_000,
      routes: [route({
        routeKey: "redemption:institutional", evidenceKind: "documented-terms",
        access: "issuer-api", holderEligibility: "verified-customer",
        settlement: "same-day", settlementDelaySec: 86_400,
        modelConfidence: "medium", feeEvidence: "disclosed-unquantified",
      })],
    }, V9_CANDIDATE_POLICY_V1);
    expect(result.routes[0]).toMatchObject({
      components: { access: 55, cost: 50, capacity: 78.3 },
      supportedComponentCeiling: 75.325, confidenceFactor: 0.85,
    });
    expect(result.routes[0]!.score).toBeCloseTo(64.02625, 10);
  });

  it("keeps a measured route score of 25 below bounded unknown rather than applying a floor", () => {
    const result = evaluateV9Exit({
      circulatingUsd: 20_000_000,
      routes: [route({ access: "manual", modelConfidence: "low",
        capacityCurve: route().capacityCurve.map((point) => ({ ...point, executionCostBps: 920 / 7 })),
      })],
    }, V9_CANDIDATE_POLICY_V1);
    expect(result.routes[0]!.score).toBeCloseTo(25, 10);
    expect(result.score).toBe(25);
    expect(result.primaryRouteKey).not.toBeNull();
  });

  it("preserves route settlement delays independently of the request window", () => {
    const immediate = route({ routeKey: "redemption:immediate" });
    const nearTerm = route({
      routeKey: "redemption:near-term",
      settlement: "same-day",
      settlementDelaySec: 86_400,
    });
    const queued = route({
      routeKey: "redemption:queued",
      settlement: "queued",
      settlementDelaySec: 30 * 86_400,
    });
    const result = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [queued, nearTerm, immediate] },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.stressRequest?.comparisonWindowSec).toBe(300);
    expect(result.primaryRouteKey).toBe(immediate.routeKey);
    const queuedTrace = result.routes.find((entry) => entry.routeKey === queued.routeKey)!;
    expect(queuedTrace.settlementDelaySec).toBe(30 * 86_400);
    expect(result.routes.find((entry) => entry.routeKey === nearTerm.routeKey)?.settlementDelaySec).toBe(86_400);
  });

  it("credits a 30-day queue without treating it as immediate capacity", () => {
    const result = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        routes: [
          route({
            routeKey: "redemption:30-day-queue",
            settlement: "queued",
            settlementDelaySec: 30 * 86_400,
          }),
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.score).toBeGreaterThan(0);
    expect(result.primaryRouteKey).toBe("redemption:30-day-queue");
    expect(result.routes[0]?.settlementDelaySec).toBe(30 * 86_400);
  });

  it("treats an eEARN-like route with an unproven settlement bound as a bounded gap", () => {
    const zeroQueue = route({
      routeKey: "redemption:eearn-operator-queue",
      routeFamily: "protocol-redemption",
      scoreEligible: false,
      settlementBoundUnproven: true,
      evidenceKind: "live-reserve-state",
      access: "whitelisted-onchain",
      holderEligibility: "issuer-discretionary",
      settlement: "queued",
      queueDepthUsd: 3_104.889979,
      execution: "opaque",
      capacityScoringHorizon: "queued",
      capacityCurve: [
        { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: 0 },
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: 0 },
      ],
    });

    const result = evaluateV9Exit(
      { circulatingUsd: 5_800_000, portfolioStatus: "reviewed-complete", routes: [zeroQueue] },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.score).toBe(50);
    expect(result.primaryRouteKey).toBeNull();
    expect(result.reasons).toContain("unproven-settlement-bound");
    expect(result.reasons).not.toContain("no-viable-exit-path");
    expect(result.routes[0]).toMatchObject({
      included: false,
      exclusionReason: "unproven-settlement-bound",
      score: null,
      observationConfidence: "high",
      modelConfidence: "high",
      confidenceFactor: null,
      capacityPoint: null,
      components: null,
    });
  });

  it("keeps a non-score-eligible queued zero as bounded uncertainty", () => {
    const zeroQueue = route({
      routeKey: "redemption:eearn-operator-queue",
      routeFamily: "protocol-redemption",
      scoreEligible: false,
      evidenceKind: "live-reserve-state",
      access: "whitelisted-onchain",
      holderEligibility: "issuer-discretionary",
      settlement: "queued",
      queueDepthUsd: 3_104.889979,
      execution: "opaque",
      capacityScoringHorizon: "queued",
      capacityCurve: [
        { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: 0 },
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: 0 },
      ],
    });

    const result = evaluateV9Exit(
      { circulatingUsd: 5_800_000, portfolioStatus: "reviewed-complete", routes: [zeroQueue] },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.score).toBe(50);
    expect(result.primaryRouteKey).toBeNull();
    expect(result.reasons).toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("no-viable-exit-path");
    expect(result.routes[0]).toMatchObject({
      included: false, score: null, exclusionReason: "missing-same-notional-route",
    });
  });

  it("does not treat an immaterial reserve lower bound as exhaustion", () => {
    const immaterialQueue = route({
      routeKey: "redemption:autousd-operator-queue",
      routeFamily: "protocol-redemption",
      scoreEligible: false,
      evidenceKind: "live-reserve-state",
      settlement: "queued",
      settlementDelaySec: 30 * 86_400,
      capacityScoringHorizon: "queued",
      capacityCurve: [
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000, completionRatio: 0.001, executionCostBps: 5 },
      ],
    });

    const result = evaluateV9Exit(
      { circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete", routes: [immaterialQueue] },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.score).toBe(50);
    expect(result.primaryRouteKey).toBeNull();
    expect(result.reasons).toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("no-viable-exit-path");
    expect(result.routes[0]).toMatchObject({
      included: false, score: null, exclusionReason: "missing-same-notional-route",
    });
  });


  it("prices queue backlog and minimum redemption gates through the reviewed constraint bands", () => {
    const base = route({
      routeKey: "redemption:queue-terms",
      capacityScoringHorizon: "queued",
      settlement: "queued",
      settlementDelaySec: 30 * 86_400,
      access: "issuer-api",
      dailyLimitUsd: 1_000_000,
    });
    const unconstrained = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [base] },
      V9_CANDIDATE_POLICY_V1,
    );
    const constrained = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        routes: [
          {
            ...base,
            queueDepthUsd: 1_500_000,
            minRedeemUsd: 1_000_000,
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(constrained.score!).toBeLessThan(unconstrained.score!);
    expect(constrained.routes[0]).toMatchObject({
      capacityScoringHorizon: "queued",
      settlementDelaySec: 30 * 86_400,
      queueDepthUsd: 1_500_000,
      dailyLimitUsd: 1_000_000,
      minRedeemUsd: 1_000_000,
      capsApplied: expect.arrayContaining(["queue-backlog:0.65", "minimum-redeem:0.75"]),
    });
  });

  it("does not let a weak optional route lower the best credible route", () => {
    const strong = route();
    const baseline = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [strong] }, V9_CANDIDATE_POLICY_V1);
    const withWeak = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        routes: [
          strong,
          route({
            routeKey: "dex:weak",
            lane: "dex",
            routeFamily: "dex-amm",
            evidenceKind: "measured-executable-depth",
            capacityCurve: [
              {
                requestedNotionalUsd: 1_000_000,
                maxCostBps: 200,
                executableUsd: 10_000,
                completionRatio: 0.01,
                executionCostBps: 150,
              },
            ],
            failureDomains: ["redemption-rail:issuer"],
            physicalResourceKeys: ["rail:issuer"],
          }),
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(withWeak.score).toBe(baseline.score);
    expect(withWeak.reasons).toContain("correlated-exit-routes");
  });

  it("scales bounded redundancy credit by the independent route's own quality", () => {
    const result = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        routes: [
          route(),
          route({
            routeKey: "dex:independent",
            lane: "dex",
            routeFamily: "dex-amm",
            evidenceKind: "measured-executable-depth",
            failureDomains: ["dex-protocol:independent"],
            physicalResourceKeys: ["pool:independent"],
          }),
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.diversificationRouteKey).not.toBeNull();
    expect(result.diversificationBonus).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
    const primaryScore = result.routes.find((entry) => entry.routeKey === result.primaryRouteKey)?.score;
    const backupScore = result.routes.find((entry) => entry.routeKey === result.diversificationRouteKey)?.score;
    expect(result.diversificationBonus).toBeCloseTo(
      Math.min(
        100 - primaryScore!,
        100 * V9_CANDIDATE_POLICY_V1.policy.semantic.exit.independentRouteBenefitLimit,
      ) * (backupScore! / 100),
      2,
    );
  });

  it("accepts a conservative exact lower bound and excludes diagnostic coverage", () => {
    const lowerBound = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [route({ coverageClass: "exact-lower-bound" })] },
      V9_CANDIDATE_POLICY_V1,
    );
    const diagnostic = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [route({ coverageClass: "diagnostic" })] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(lowerBound.score).not.toBeNull();
    expect(diagnostic.score).toBe(50);
    expect(diagnostic.primaryRouteKey).toBeNull();
    expect(diagnostic.reasons).toContain("unsupported-same-notional-route");
    expect(lowerBound.score!).toBeGreaterThan(diagnostic.score!);
  });

  it("does not infer measured absence from a reviewed diagnostic inventory", () => {
    const diagnosticRoute = route({ coverageClass: "diagnostic" });
    const reviewed = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        portfolioStatus: "reviewed-complete",
        routes: [diagnosticRoute],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    const incomplete = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        portfolioStatus: "incomplete",
        routes: [diagnosticRoute],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(reviewed.score).toBe(50);
    expect(reviewed.reasons).not.toContain("no-viable-exit-path");
    expect(incomplete.score).toBe(reviewed.score);
    expect(incomplete.primaryRouteKey).toBeNull();
    expect(incomplete.reasons).toContain("unsupported-same-notional-route");
    expect(incomplete.reasons).toContain("missing-same-notional-route");
  });

  it("does not self-suppress the missing-route echo when there is no route to diagnose", () => {
    const withDiagnosticRoute = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        portfolioStatus: "incomplete",
        routes: [route({ coverageClass: "diagnostic" })],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(withDiagnosticRoute.reasons).toEqual(["missing-same-notional-route", "unsupported-same-notional-route"]);
    expect(withDiagnosticRoute.primaryRouteKey).toBeNull();
    expect(withDiagnosticRoute.routes[0]).toMatchObject({
      included: false, score: null, capacityPoint: null,
      exclusionReason: "unsupported-same-notional-route",
    });
    expect(withDiagnosticRoute.reasons).not.toContain("no-viable-exit-path");

    const withoutAnyRoute = evaluateV9Exit(
      { circulatingUsd: 20_000_000, portfolioStatus: "incomplete", routes: [] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(withoutAnyRoute.reasons).toEqual(["missing-same-notional-route"]);
    expect(withoutAnyRoute.score).toBe(50);
    expect(withoutAnyRoute.score).toBe(withDiagnosticRoute.score);
  });

  it("keeps unresolved optional output visible without invalidating a resolved route", () => {
    const result = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        routes: [route(), route({ routeKey: "dex:unknown-output", outputResolved: false })],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.score).not.toBeNull();
    // A scored route carries the exit claim, so the excluded optional route's
    // diagnostic stays on its per-route trace rather than the top-level reasons.
    expect(result.reasons).not.toContain("unresolved-exit-output");
    const unresolvedTrace = result.routes.find((trace) => trace.routeKey === "dex:unknown-output");
    expect(unresolvedTrace?.exclusionReason).toBe("unresolved-exit-output");
  });

  it("applies output-value loss to capacity and route quality", () => {
    const par = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [route()] }, V9_CANDIDATE_POLICY_V1);
    const impaired = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [route({ outputValueRetention: 0.6 })] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(impaired.score).toBeLessThan(par.score!);
  });

  it("distinguishes the bounded-unknown cost sentinel from measured execution costs", () => {
    const traceAtCost = (executionCostBps: number) => {
      const result = evaluateV9Exit(
        {
          circulatingUsd: 20_000_000,
          routes: [
            route({
              routeKey: "dex:measured-cost",
              lane: "dex",
              routeFamily: "dex-amm",
              evidenceKind: "measured-executable-depth",
              feeEvidence: executionCostBps === 200 ? "disclosed-unquantified" : null,
              capacityCurve: [
                {
                  requestedNotionalUsd: 1_000_000,
                  maxCostBps: 200,
                  executableUsd: 1_000_000,
                  completionRatio: 1,
                  executionCostBps,
                },
              ],
            }),
          ],
        },
        V9_CANDIDATE_POLICY_V1,
      );
      return result.routes.find((entry) => entry.routeKey === "dex:measured-cost")!;
    };

    const boundedUnknown = traceAtCost(200);
    const favorableMeasured = traceAtCost(80);
    const adverseMeasured = traceAtCost(180);

    expect(boundedUnknown.components?.cost).toBe(
      50,
    );
    expect(favorableMeasured.components?.cost).toBeGreaterThan(boundedUnknown.components!.cost!);
    expect(favorableMeasured.score).toBeGreaterThan(boundedUnknown.score!);
    expect(adverseMeasured.components?.cost).toBeLessThan(boundedUnknown.components!.cost!);
    expect(adverseMeasured.score).toBeLessThan(boundedUnknown.score!);

    const measuredCosts = [0, 20, 50, 80, 100, 120, 150, 180, 199];
    const measuredScores = measuredCosts.map((cost) => traceAtCost(cost).score!);
    expect(measuredScores.every((score, index) => index === 0 || score <= measuredScores[index - 1]!)).toBe(true);
  });

  it("prices admitted measured certificate cost monotonically through the exact request budget", () => {
    const review = validateExitExecutionModelReviews(executionReviews, V9_CANDIDATE_POLICY_V1)
      .find((entry) => entry.identity.assetId === "susds-sky")!;
    const clockSec = Math.ceil(Date.parse(review.reviewedAt) / 1000);
    const model = V9_CANDIDATE_POLICY_V1.policy.semantic.exit.executionModels[review.modelId]!;
    const traces = [199.99, 200].map((executionCostBps) => {
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
      certificate.inputGenerationId = exitExecutionInputGenerationId(review.identity.assetId, { requestedNotionalUsd: 100_000, maxCostBps: 200 }, certificate.inputReference);
      certificate.gates = model.requiredGates.map((gateId) => ({
        gateId, verdict: "passed", evidenceId: `observed:${gateId}`, observedAtSec: clockSec, reason: null,
      }));
      const point = certificate.points[0]!;
      Object.assign(point, {
        executionCostBps, allInCostBps: executionCostBps,
        requestedRawInput: "100000000000000000000000", executedRawInput: "100000000000000000000000",
        fees: [],
      });
      Object.assign(point.outputs[0]!, {
        assetKey: review.identity.outputAssetKeys[0], deployment: `${review.producer.chain}:${review.producer.outputToken}`,
        decimals: review.producer.outputDecimals, observedAtSec: clockSec,
        rawUnits: executionCostBps === 200 ? "98000000000000000000000" : "98000100000000000000000",
      });
      const admitted = admitExitExecutionCertificate({
        certificate, envelope: V9_CANDIDATE_POLICY_V1, assetId: review.identity.assetId,
        clockSec, inputGenerationId: certificate.inputGenerationId,
        observationGenerationId: certificate.observationGenerationId,
        request: { requestedNotionalUsd: 100_000, maxCostBps: 200 },
      });
      expect(admitted.state).toBe("observed");
      const result = evaluateV9Exit({
        circulatingUsd: 2_000_000, assetId: review.identity.assetId, clockSec,
        routes: [route({
          executionModelId: certificate.modelId, executionCertificate: certificate,
          coverageClass: point.certification,
          capacityCurve: [{
            requestedNotionalUsd: point.requestedNotionalUsd, maxCostBps: point.maxCostBps,
            executableUsd: point.executableUsd, completionRatio: 1, executionCostBps,
          }],
        }), route({ routeKey: "modeled:duplicate", evidenceKind: "documented-terms" })],
      }, V9_CANDIDATE_POLICY_V1);
      expect(result.primaryRouteKey).toBe("redemption:issuer");
      expect(result.diversificationBonus).toBe(0);
      expect(result.routes.find((entry) => entry.routeKey === "modeled:duplicate")!.included).toBe(false);
      return result.routes.find((entry) => entry.routeKey === "redemption:issuer")!;
    });
    // Components round to two decimals; factor contributions retain the formula.
    expect(traces[0]!.factorContributions!.cost!.score).toBeCloseTo(0.005, 6);
    expect(traces[1]!.components!.cost).toBe(0);
    expect(traces[1]!.score).toBeLessThanOrEqual(traces[0]!.score!);
  });

  it("floors a zero-capacity route to zero instead of letting an undisclosed cost carry it", () => {
    // The exact shape that scored 35.61 before the floor: capacity carries 25%
    // of the ladder, so access/settlement/execution/output plus a
    // boundedCostScore awarded *because* the cost is undisclosed used to carry
    // a route that provably clears $0 at the stress cost. A DEX route exercises
    // this general zero-capacity floor independently of the discounted
    // redemption-credit path.
    const zeroCapacity = route({
      routeKey: "dex:undisclosed-cost",
      lane: "dex",
      routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      access: "issuer-api",
      holderEligibility: "verified-customer",
      settlement: "same-day",
      settlementDelaySec: 86_400,
      modelConfidence: "medium",
      capacityCurve: [
        {
          requestedNotionalUsd: 1_000_000,
          maxCostBps: 200,
          executableUsd: 0,
          completionRatio: 0,
          // At or above the request bound, so the cost component is the
          // bounded-unknown midpoint rather than a measurement.
          executionCostBps: 200,
        },
      ],
    });
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [zeroCapacity] }, V9_CANDIDATE_POLICY_V1);
    const trace = result.routes.find((entry) => entry.routeKey === "dex:undisclosed-cost");
    expect(trace?.included).toBe(true);
    expect(trace?.capacityPoint?.executableUsd).toBe(0);
    // The non-capacity ladder is untouched — the floor, not a component change,
    // is what removes the score.
    expect(trace?.components?.cost).toBe(50);
    expect(trace?.components?.capacity).toBe(0);
    expect(trace?.score).not.toBeCloseTo(35.61, 2);
    expect(trace?.score).toBe(0);
    expect(trace?.capsApplied).toContain("zero-executable-capacity");
  });

  it("floors a route that fills a vanishing fraction of the stress request", () => {
    const shoulder = (executableUsd: number) =>
      route({
        routeKey: "dex:thin-depth",
        lane: "dex",
        routeFamily: "dex-amm",
        evidenceKind: "measured-executable-depth",
        capacityCurve: [{
          requestedNotionalUsd: 25_000_000,
          maxCostBps: 200,
          executableUsd,
          completionRatio: executableUsd / 25_000_000,
          executionCostBps: 200,
        }],
      });
    const evaluate = (executableUsd: number) =>
      evaluateV9Exit({ circulatingUsd: 1_000_000_000, routes: [shoulder(executableUsd)] }, V9_CANDIDATE_POLICY_V1)
        .routes.find((entry) => entry.routeKey === "dex:thin-depth");
    const immaterial = evaluate(13.93);
    expect(immaterial?.included).toBe(true);
    expect(immaterial?.score).toBe(0);
    expect(immaterial?.capsApplied).toContain("immaterial-executable-capacity");
    const exit = V9_CANDIDATE_POLICY_V1.policy.semantic.exit;
    const absoluteFloor = exit.absoluteCapacityBreakpoints.find(
      (point) => point.value > 0 && point.score > 0,
    )!.value;
    expect(absoluteFloor).toBe(100_000);
    const material = evaluate(absoluteFloor);
    expect(material?.score).toBeGreaterThan(0);
    expect(material?.score).toBeLessThanOrEqual(50);
    expect(material?.capsApplied).toContain("insufficient-completion:50");
    expect(material?.capsApplied).not.toContain("immaterial-executable-capacity");
  });

  it("tests materiality before output-value retention", () => {
    const evaluate = (executableUsd: number, outputValueRetention: number) =>
      evaluateV9Exit({
        circulatingUsd: 1_000_000_000,
        routes: [route({
          routeKey: "dex:retained-output", lane: "dex", routeFamily: "dex-amm",
          evidenceKind: "measured-executable-depth", outputValueRetention,
          capacityCurve: [{
            requestedNotionalUsd: 25_000_000, maxCostBps: 200, executableUsd,
            completionRatio: executableUsd / 25_000_000, executionCostBps: 125,
          }],
        })],
      }, V9_CANDIDATE_POLICY_V1).routes[0];
    expect(evaluate(100_000, 0.9999)).toMatchObject({
      capsApplied: expect.arrayContaining(["insufficient-completion:50"]),
    });
    expect(evaluate(100_000, 0.9999)?.capsApplied).not.toContain("immaterial-executable-capacity");
    expect(evaluate(99_999, 1)).toMatchObject({ score: 0, capsApplied: ["immaterial-executable-capacity"] });
    expect(evaluate(100_000, 0)).toMatchObject({ score: 0, capsApplied: ["zero-executable-capacity"] });
  });

  it("does not award a diversification benefit off a zero-capacity independent route", () => {
    const primary = route();
    const zeroCapacityIndependent = route({
      routeKey: "dex:zero-capacity-independent",
      lane: "dex",
      routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      failureDomains: ["dex-protocol:independent"],
      physicalResourceKeys: ["pool:independent"],
      capacityCurve: [
        {
          requestedNotionalUsd: 1_000_000,
          maxCostBps: 200,
          executableUsd: 0,
          completionRatio: 0,
          executionCostBps: 200,
        },
      ],
    });
    const alone = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [primary] }, V9_CANDIDATE_POLICY_V1);
    const withZero = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [primary, zeroCapacityIndependent] },
      V9_CANDIDATE_POLICY_V1,
    );
    // A failure-domain-independent route that can move no value is not
    // diversification: it cannot lift the pillar above the single-route score.
    expect(withZero.diversificationBonus).toBe(0);
    expect(withZero.score).toBe(alone.score);
  });

  it("uses Unicode route-key ordering to break equal-score ties independent of route order", () => {
    const first = route({
      routeKey: "route:ä",
      failureDomains: ["redemption-rail:umlaut"],
      physicalResourceKeys: ["rail:umlaut"],
    });
    const second = route({
      routeKey: "route:z",
      lane: "dex",
      routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      failureDomains: ["dex-protocol:z"],
      physicalResourceKeys: ["pool:z"],
    });
    const forward = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [first, second] }, V9_CANDIDATE_POLICY_V1);
    const reverse = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [second, first] }, V9_CANDIDATE_POLICY_V1);
    expect(forward.primaryRouteKey).toBe("route:z");
    expect(forward.diversificationRouteKey).toBe("route:ä");
    expect(forward.routes.map((entry) => entry.routeKey)).toEqual(["route:z", "route:ä"]);
    expect(reverse).toEqual(forward);
  });

  it("selects the same stress capacity when unequal curve points are reversed", () => {
    const forwardRoute = route({
      capacityCurve: [
        { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 80_000, completionRatio: 0.8, executionCostBps: 10 },
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 600_000, completionRatio: 0.6, executionCostBps: 20 },
        { requestedNotionalUsd: 10_000_000, maxCostBps: 200, executableUsd: 2_000_000, completionRatio: 0.2, executionCostBps: 30 },
      ],
    });
    const forward = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [forwardRoute] }, V9_CANDIDATE_POLICY_V1);
    const reverse = evaluateV9Exit({
      circulatingUsd: 20_000_000,
      routes: [{ ...forwardRoute, capacityCurve: [...forwardRoute.capacityCurve].reverse() }],
    }, V9_CANDIDATE_POLICY_V1);
    expect(forward.routes[0].capacityPoint).toMatchObject({
      requestedNotionalUsd: 1_000_000,
      executableUsd: 600_000,
      completionRatio: 0.6,
      executionCostBps: 20,
    });
    expect(reverse).toEqual(forward);
  });

  it("projects explicit normalized route facts without route-family access inference", () => {
    const projected = projectV9ExitEvaluationRoute(makeNormalizedExitRoute());
    expect(projected).toMatchObject({
      access: "whitelisted-onchain",
      holderEligibility: "whitelisted-primary",
      modelConfidence: "high",
      settlement: "same-day",
      outputValueRetention: 1,
    });
  });

  it("falls back to the reviewed settlement horizon when the SLA is null", () => {
    // The `days`/`queued` models publish a null settlement SLA; the delay the
    // settlement multiplier prices must fall back to the reviewed horizon rather
    // than reading as instantaneous.
    const daysRoute = makeNormalizedExitRoute({
      routeKey: "redemption:generation:days",
      routeId: "days",
      routeFamily: "eventual-redemption",
      holderAccess: "retail-open",
      settlementModel: "bounded-delay",
      settlementSlaSec: null,
      scoreEligible: false,
      request: { requestedNotionalUsd: 1_000_000, maxCostBps: 200, settlementHorizonSec: 1_209_600 },
    });
    expect(projectV9ExitEvaluationRoute(daysRoute).settlementDelaySec).toBe(1_209_600);
  });
});

describe("reliable non-atomic redemption credit", () => {
  function redemptionRoute(overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute {
    return documentedRedemption({
      routeKey: "redemption:eventual",
      routeFamily: "eventual-redemption",
      ...overrides,
    });
  }

  it.each(["eventual-redemption", "issuer-redemption", "protocol-redemption"] as const)("credits reliable %s above zero but below atomic redemption", (routeFamily) => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [redemptionRoute({ routeFamily })] }, V9_CANDIDATE_POLICY_V1);
    expect(result.primaryRouteKey).toBe("redemption:eventual");
    expect(result.routes[0].routeFamily).toBe(routeFamily);
    expect(result.score).toBeGreaterThan(55);
    // Above the bounded-unknown floor but below an atomic same-notional path.
    expect(result.score).toBeGreaterThan(50);
    const atomic = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [redemptionRoute({ settlement: "atomic", settlementDelaySec: 300, routeFamily: "issuer-redemption", scoreEligible: true })] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.score).toBeLessThan(atomic.score!);
  });

  it("scores a slower settlement tier strictly below a same-day tier", () => {
    const sameDay = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [redemptionRoute()] }, V9_CANDIDATE_POLICY_V1);
    const days = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [redemptionRoute({ settlement: "days", settlementDelaySec: 1_209_600 })] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(days.score!).toBeLessThan(sameDay.score!);
    expect(days.score!).toBeGreaterThan(50);
  });

  it.each(["eventual-redemption", "issuer-redemption", "protocol-redemption"] as const)("does not promote documented zero-clearing %s terms to measured adversity", (routeFamily) => {
    const zeroCost = redemptionRoute({
      routeFamily,
      capacityCurve: [
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: 200 },
      ],
    });
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [zeroCost] }, V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(50);
    expect(result.primaryRouteKey).toBeNull();
    expect(result.routes[0].routeFamily).toBe(routeFamily);
    expect(result.reasons).toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("no-viable-exit-path");
    expect(result.routes[0]).toMatchObject({
      included: false, score: null, exclusionReason: "missing-same-notional-route",
    });
  });

  it("keeps an unresolved-output documented redemption excluded", () => {
    const result = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [redemptionRoute({ outputResolved: false })] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.score).toBe(50);
  });

  it.each([0, 1_000])("does not let a complete inventory turn documented $%i capacity into an exhaustion measurement", (executableUsd) => {
    const candidate = redemptionRoute({
      capacityCurve: [{
        requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd,
        completionRatio: executableUsd / 1_000_000, executionCostBps: 10,
      }],
    });
    const incomplete = evaluateV9Exit({
      circulatingUsd: 20_000_000, portfolioStatus: "incomplete", routes: [candidate],
    }, V9_CANDIDATE_POLICY_V1);
    const reviewed = evaluateV9Exit({
      circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete", routes: [candidate],
    }, V9_CANDIDATE_POLICY_V1);
    expect(incomplete.score).toBe(50);
    expect(incomplete.primaryRouteKey).toBeNull();
    expect(incomplete.routes[0]).toMatchObject({ included: false, score: null, exclusionReason: "missing-same-notional-route" });
    expect(incomplete.reasons).not.toContain("no-viable-exit-path");
    expect(reviewed.score).toBe(incomplete.score);
    expect(reviewed.primaryRouteKey).toBeNull();
    expect(reviewed.reasons).not.toContain("no-viable-exit-path");
    expect(reviewed.routes[0]).toMatchObject({
      included: false, score: null, exclusionReason: "missing-same-notional-route",
    });
  });

  it.each([
    { observationState: "stale" },
    { failureDomains: [] },
    { evidenceKind: "measured-executable-depth" },
    { lane: "dex" },
    { routeFamily: "dex-amm" },
  ] satisfies Partial<V9ExitEvaluationRoute>[])("rejects non-atomic evidence with %j", (overrides) => {
    const valid = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [redemptionRoute()] }, V9_CANDIDATE_POLICY_V1);
    const invalid = evaluateV9Exit({
      circulatingUsd: 20_000_000, routes: [redemptionRoute(overrides)],
    }, V9_CANDIDATE_POLICY_V1);
    expect(valid.primaryRouteKey).toBe("redemption:eventual");
    expect(valid.score).toBeGreaterThan(50);
    expect(invalid.primaryRouteKey).toBeNull();
    expect(invalid.routes[0]).toMatchObject({
      included: false, score: null, exclusionReason: "unsupported-same-notional-route",
    });
  });

});

// Lever 3 (V9 scoring reshape): the exit pillar now credits documented,
// reliable issuer- and protocol-redemption channels — not only the derived
// eventual-redemption family — while every reliability gate and the
// all-zero-capacity floor stay in force. Impaired/frozen routes remain included
// as adverse observations and receive zero credit.
describe("Lever 3 issuer/protocol redemption credit", () => {
  const floor = 50;

  it("applies the settlement haircut: a 7-day issuer redemption scores strictly below a same-day one", () => {
    const sameDay = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [documentedRedemption()] }, V9_CANDIDATE_POLICY_V1);
    const sevenDay = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [documentedRedemption({ settlement: "days", settlementDelaySec: 604_800 })] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(sevenDay.score!).toBeLessThan(sameDay.score!);
    expect(sevenDay.score!).toBeGreaterThan(floor);
  });



  it("does not classify an explicitly score-eligible protocol redemption as non-atomic", () => {
    const atomicProtocol = documentedRedemption({
      routeKey: "redemption:protocol-atomic",
      routeFamily: "protocol-redemption",
      scoreEligible: true,
      evidenceKind: "onchain-contract-state",
      settlement: "atomic",
      settlementDelaySec: 0,
    });

    expect(
      isV9CreditableNonAtomicRedemption(
        {
          lane: atomicProtocol.lane,
          routeFamily: atomicProtocol.routeFamily,
          scoreEligible: atomicProtocol.scoreEligible,
          observationState: atomicProtocol.observationState,
          outputResolved: atomicProtocol.outputResolved,
          coverageClass: atomicProtocol.coverageClass,
          evidenceKind: atomicProtocol.evidenceKind,
          failureDomainCount: atomicProtocol.failureDomains.length,
        },
        V9_CANDIDATE_POLICY_V1,
      ),
    ).toBe(false);

    const result = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [atomicProtocol] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.primaryRouteKey).toBe("redemption:protocol-atomic");
    expect(result.score).toBeGreaterThan(floor);
    expect(result.routes[0]?.included).toBe(true);
  });
});

describe("reviewed unquantified fees", () => {



  it.each([
    { name: "hchf-like HBAR-denominated dynamic fee", settlement: "immediate" as const, delay: 300 },
    { name: "usbd-like coreRate plus 75 bps fee", settlement: "atomic" as const, delay: 0 },
  ])("never reduces conservative credit when $name becomes disclosed", ({ settlement, delay }) => {
    const modeled = route({
      scoreEligible: false, coverageClass: "modelled-terms-lower-bound",
      evidenceKind: "documented-terms", settlement, settlementDelaySec: delay,
      capacityCurve: route().capacityCurve.map((point) => ({ ...point, executionCostBps: 200 })),
    });
    const opaque = evaluateV9Exit({
      circulatingUsd: 20_000_000, routes: [{ ...modeled, feeEvidence: "undisclosed-reviewed" }],
    }, V9_CANDIDATE_POLICY_V1);
    const disclosed = evaluateV9Exit({
      circulatingUsd: 20_000_000, routes: [{ ...modeled, feeEvidence: "disclosed-unquantified" }],
    }, V9_CANDIDATE_POLICY_V1);
    expect(disclosed.score).toBe(opaque.score);
    expect(disclosed.routes[0]).toMatchObject({
      included: true, score: opaque.routes[0]!.score,
      components: opaque.routes[0]!.components,
    });
  });


  it("does not replace a measured over-budget execution cost with the uncertain-fee assumption", () => {
    const measured = route({
      feeEvidence: "disclosed-unquantified",
      capacityCurve: [{
        requestedNotionalUsd: 1_000_000, maxCostBps: 200,
        executableUsd: 0, completionRatio: 0, executionCostBps: 250,
      }],
    });
    const result = evaluateV9Exit({
      circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete", routes: [measured],
    }, V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(0);
    expect(result.routes[0]).toMatchObject({
      included: true, score: 0, capacityPoint: { executionCostBps: 250 },
    });
  });
});

describe("undisclosed-fee routes stay bounded at the portfolio level", () => {
  it.each(["both", "secondary"] as const)("withholds diversification for %s undisclosed fees despite independent routes", (fees) => {
    const routes = [
      route({ routeKey: "redemption:primary" }),
      route({
        routeKey: "dex:backup",
        lane: "dex",
        routeFamily: "dex-amm",
        evidenceKind: "measured-executable-depth",
        failureDomains: ["dex-protocol:backup"],
        physicalResourceKeys: ["pool:backup"],
      }),
    ];
    const disclosed = evaluateV9Exit({ circulatingUsd: 20_000_000, routes }, V9_CANDIDATE_POLICY_V1);
    expect(disclosed.diversificationRouteKey).toBe("redemption:primary");
    expect(disclosed.diversificationBonus).toBeGreaterThan(0);
    const opaqueRoutes = routes.map((candidate) => ({
      ...candidate,
      ...(fees === "both" || candidate.routeKey === disclosed.diversificationRouteKey
        ? { feeEvidence: "undisclosed-reviewed" as const }
        : {}),
    }));
    const opaque = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: opaqueRoutes }, V9_CANDIDATE_POLICY_V1);
    expect(opaque.diversificationRouteKey).toBe("redemption:primary");
    expect(opaque.diversificationBonus).toBe(0);
    const solo = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [opaqueRoutes[1]] }, V9_CANDIDATE_POLICY_V1);
    expect(opaque.primaryRouteKey).toBe("dex:backup");
    expect(opaque.score).toBe(solo.score);
  });
});

describe("stale exit-route observations", () => {
  const staleFactor =
    V9_CANDIDATE_POLICY_V1.policy.semantic.exit.staleObservationConfidenceFactor;

  // The instability this lever exists for is DEX-lane: a measured route whose
  // producer window expired used to leave the capacity denominator outright.
  // Creditable non-atomic redemption keeps its stricter `known` requirement.
  function dexRoute(overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute {
    return route({
      routeKey: "dex:usdc-circle:pool",
      lane: "dex",
      routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      settlement: "atomic",
      execution: "deterministic-onchain",
      ...overrides,
    });
  }

  it("derates a stale route instead of dropping it out of the capacity denominator", () => {
    const current = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [dexRoute()] },
      V9_CANDIDATE_POLICY_V1,
    );
    const stale = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [dexRoute({ observationState: "stale" })] },
      V9_CANDIDATE_POLICY_V1,
    );

    // The route still carries the exit path: an expired producer window is
    // weaker evidence, not absent evidence.
    expect(stale.primaryRouteKey).toBe(current.primaryRouteKey);
    expect(stale.reasons).not.toContain("missing-runtime-route-evidence");
    expect(stale.reasons).not.toContain("no-viable-exit-path");
    expect(stale.score!).toBeGreaterThan(0);
    expect(stale.score!).toBeLessThan(current.score!);
  });

  it("keeps a missing observation excluded without inventing exhaustion", () => {
    const missing = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        portfolioStatus: "reviewed-complete",
        routes: [dexRoute({ observationState: "missing" })],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(missing.primaryRouteKey).toBeNull();
    expect(missing.reasons).toContain("missing-runtime-route-evidence");
    expect(missing.reasons).not.toContain("no-viable-exit-path");
    expect(missing.score).toBe(50);
  });

  it("prices the stale derate off the reviewed policy lever", () => {
    expect(staleFactor).toBeGreaterThan(0);
    expect(staleFactor).toBeLessThan(1);
    const current = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [dexRoute()] },
      V9_CANDIDATE_POLICY_V1,
    );
    const stale = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [dexRoute({ observationState: "stale" })] },
      V9_CANDIDATE_POLICY_V1,
    );
    // Not exactly linear: the factor derates the route's own score AND the
    // capacity it contributes, and the capacity component is non-linear in
    // executable notional. The derate is bounded near the lever either way.
    expect(stale.score!).toBeLessThan(current.score!);
    expect(stale.score!).toBeGreaterThan(current.score! * staleFactor * 0.95);
    expect(stale.score!).toBeLessThanOrEqual(current.score! * staleFactor * 1.05);
  });
});

describe("issuer payout output quality", () => {
  it("scores a tracked USDC payout at par like fiat and conservatively discounts a two-output basket", () => {
    const fiatFact = makeNormalizedExitRoute();
    const singleFact = makeNormalizedExitRoute({
      output: {
        ...fiatFact.output,
        kind: "tracked-stablecoin",
        assetKeys: ["usdc-circle"],
        valuation: {
          ...fiatFact.output.valuation!,
          basis: "price",
          referenceAssetKey: "usdc-circle",
        },
      },
    });
    const basketFact = makeNormalizedExitRoute({
      output: { ...singleFact.output, assetKeys: ["usdc-circle", "usdt-tether"] },
    });
    const projected = [fiatFact, singleFact, basketFact].map(projectV9ExitEvaluationRoute);
    expect(projected.map((candidate) => candidate.outputQuality))
      .toEqual(["stable-single", "stable-single", "stable-basket"]);
    // Isolate output economics from holder/confidence/family caps.
    const traces = projected.map((candidate) => evaluateV9Exit({
      circulatingUsd: 20_000_000,
      routes: [route({
        outputQuality: candidate.outputQuality,
        outputValueRetention: candidate.outputValueRetention,
        outputResolved: candidate.outputResolved,
      })],
    }, V9_CANDIDATE_POLICY_V1).routes[0]!);
    expect(traces[1].components?.outputAssetQuality).toBe(100);
    expect(traces[1].score).toBe(traces[0].score);
    expect(traces[2].components?.outputAssetQuality).toBe(80);
    expect(traces[1].score! - traces[2].score!).toBeCloseTo(3, 10);
  });
});

describe("cause-aware Exit and max-feasible portfolios", () => {
  function gap(cause: "A" | "B" | "C" | "U", id: string): { status: V9FactStatusV2; gap: V9FactGapV3 } {
    const proof = cause === "A" ? {
      cause, producerState: "stale-producer" as const, sourceId: "route-producer", sourceGenerationId: "captured",
      observedAtSec: 100, rejectionCode: "route-observation-stale", evidenceRefIds: ["attempt"],
    } : cause === "U" ? { cause, reason: "not-yet-researched" as const, evidenceRefIds: [] as [] }
      : cause === "B" ? {
        cause, proofOrigin: "typed-review" as const, classificationId: id, reviewedAt: "2026-10-01",
        sources: [{ url: "https://issuer.example/terms", assertion: "The exact route datum is public." }],
        evidenceRefIds: ["review"], assertion: "required-data-public" as const,
      } : {
        cause, proofOrigin: "typed-review" as const, classificationId: id, reviewedAt: "2026-10-01",
        sources: [{ url: "https://issuer.example/terms", assertion: "The exact route datum was researched." }],
        evidenceRefIds: ["review"], assertion: "researched-nondisclosure" as const,
        rationale: "The required current datum is not published.",
      };
    return {
      status: { applicability: { state: "required", policyRuleId: "route-factor", rationale: null, gapId: null },
        observationState: "bounded-unknown", evidenceRefIds: [], gapIds: [id] },
      gap: createV9FactGapV3({ gapId: id, reasonCode: "missing-same-notional-route", ownerDomain: "exit",
        policyRuleId: "route-factor", responsibility: "unresearched", observationState: "bounded-unknown",
        path: { kind: "optional-exit", routeKey: "route" }, message: "Scoped datum gap.", causeProof: proof }),
    };
  }
  const evaluate = (routes: V9ExitEvaluationRoute[], policy = V9_CANDIDATE_POLICY_V1) =>
    evaluateV9Exit({ circulatingUsd: 20_000_000, routes }, policy);

  it("never loses the previous independent pair when a mutually correlated third route improves", () => {
    const left = route({ routeKey: "a", failureDomains: ["left"], physicalResourceKeys: ["a"] });
    const right = route({ routeKey: "b", failureDomains: ["right"], physicalResourceKeys: ["b"] });
    const correlated = route({ routeKey: "c", failureDomains: ["left", "right"], physicalResourceKeys: ["c"],
      capacityCurve: route().capacityCurve.map((point) => ({ ...point, executionCostBps: 190 })) });
    const before = evaluate([left, right, correlated]);
    const after = evaluate([left, right, { ...correlated, capacityCurve: route().capacityCurve }]);
    expect(after.score).toBeGreaterThanOrEqual(before.score!);
    expect(after.primaryRouteKey).toBe("a");
    expect(after.diversificationRouteKey).toBe("b");
    expect(evaluate([correlated, right, left])).toMatchObject({
      score: before.score, primaryRouteKey: before.primaryRouteKey, diversificationRouteKey: before.diversificationRouteKey,
    });
  });

  it("improving any route never lowers Exit across correlation, 90/headroom and input-order branches", () => {
    for (const seed of [0, 40, 80, 120, 160, 199]) {
      const routes = ["a", "b", "c"].map((routeKey, index) => route({
        routeKey, failureDomains: index === 2 ? ["left", "right"] : [index === 0 ? "left" : "right"],
        physicalResourceKeys: [routeKey],
        capacityCurve: route().capacityCurve.map((point) => ({ ...point, executionCostBps: Math.min(199, seed + index * 5) })),
      }));
      const baseline = evaluate(routes).score!;
      for (let index = 0; index < routes.length; index++) {
        for (const improvement of [1, 10, 50, 199]) {
          const improved = routes.map((candidate, i) => i !== index ? candidate : {
            ...candidate, capacityCurve: candidate.capacityCurve.map((point) => ({
              ...point, executionCostBps: Math.max(0, point.executionCostBps - improvement),
            })),
          });
          expect(evaluate(improved).score, `${seed}/${index}/${improvement}`).toBeGreaterThanOrEqual(baseline);
          expect(evaluate([...improved].reverse()).score).toBe(evaluate(improved).score);
        }
      }
    }
  });


  it("keeps fee-cause refinement monotone but never exempts same-notional cost admission", () => {
    const backup = route({ routeKey: "backup", observationConfidence: "medium",
      failureDomains: ["backup"], physicalResourceKeys: ["backup"] });
    const price = (cause: "C" | "B", overBudget = false) => {
      const missing = gap(cause, "formula");
      const primary = route({ routeKey: "primary", observationConfidence: "medium", feeEvidence: "disclosed-unquantified",
        factorStatuses: { cost: missing.status }, gaps: [missing.gap],
        capacityCurve: route().capacityCurve.map((point) => ({ ...point,
          executionCostBps: overBudget ? point.maxCostBps + 1 : point.executionCostBps })) });
      return evaluate([primary, backup]);
    };
    const opaque = price("C");
    const publicFormula = price("B");
    expect(publicFormula.score).toBeGreaterThanOrEqual(opaque.score!);
    expect(opaque.diversificationBonus).toBe(0);
    expect(publicFormula.diversificationBonus).toBeGreaterThan(0);
    expect(publicFormula.routes.find((trace) => trace.routeKey === "primary")).toMatchObject({
      rawSameNotionalCostBps: null, components: { cost: null },
    });
    const overBudget = price("B", true);
    expect(overBudget.routes.find((trace) => trace.routeKey === "primary")!.included).toBe(false);
    expect(overBudget.diversificationBonus).toBe(0);
  });

  it("uses stable equal-score keys over 64 candidates and rejects unproven overflow without truncation", () => {
    const candidates = Array.from({ length: 64 }, (_, index) => route({
      routeKey: `r:${String(index).padStart(2, "0")}`, observationConfidence: "medium",
      failureDomains: [`domain:${index}`], physicalResourceKeys: [`resource:${index}`],
    }));
    const first = evaluate(candidates);
    expect(first.primaryRouteKey).toBe("r:00");
    expect(first.diversificationRouteKey).toBe("r:01");
    expect(evaluate([...candidates].reverse()).score).toBe(first.score);
    const tooMany = [...candidates, route({ routeKey: "r:64" })];
    expect(() => evaluate(tooMany)).toThrow("route-inventory-over-limit");
  });

  it.each(["A", "B"] as const)("omits %s holder/fee/confidence gaps while preserving measured restrictions", (cause) => {
    const missing = gap(cause, "gap");
    const unknown = route({ holderEligibility: "unknown", observationConfidence: "unknown", modelConfidence: "unknown",
      capacityEvidenceTier: "unknown", feeEvidence: "disclosed-unquantified",
      factorStatuses: { holderEligibility: missing.status, observationConfidence: missing.status,
        executionConfidence: missing.status, capacityEvidenceTier: missing.status, cost: missing.status },
      gaps: [missing.gap] });
    const trace = evaluate([unknown]).routes[0]!;
    expect(trace.confidenceFactor).toBe(1);
    expect(trace.components!.cost).toBeNull();
    expect(trace.rawSameNotionalCostBps).toBeNull();
    expect(trace.confidenceDimensions!.capacityMethod.cause).toBe(cause);
    expect(trace.confidenceDimensions!.capacityMethod.factor).toBe(1);
    const restricted = evaluate([route({ ...unknown, access: "manual", holderEligibility: "issuer-discretionary",
      factorStatuses: { ...unknown.factorStatuses, holderEligibility: undefined }, queueDepthUsd: 10_000_000,
      dailyLimitUsd: 1_000_000, minRedeemUsd: 1_000_000 })]).routes[0]!;
    expect(restricted.capsApplied).toContain("minimum-redeem:0.75");
    expect(restricted.score).toBeLessThan(trace.score!);
  });

  it.each([{ cause: "C", quality: 35 }, { cause: "U", quality: 50 }] as const)("prices only unknown $cause subfactors", ({ cause, quality }) => {
    const missing = gap(cause, "gap");
    const trace = evaluate([route({ observationConfidence: "unknown", holderEligibility: "unknown",
      capacityEvidenceTier: "unknown", capacityCurve: route().capacityCurve.map((point) => ({ ...point, executionCostBps: 200 })),
      factorStatuses: { observationConfidence: missing.status, holderEligibility: missing.status, cost: missing.status,
        capacityEvidenceTier: missing.status },
      gaps: [missing.gap] })]).routes[0]!;
    expect(trace.confidenceDimensions!.observation.factor).toBe(0.6);
    expect(trace.confidenceDimensions!.capacityMethod.factor).toBe(0.75);
    expect(trace.confidenceDimensions!.capacityMethod.cause).toBe(cause);
    expect(trace.components!.access).toBe(quality);
    expect(trace.components!.cost).toBe(quality);
    expect(trace.components!.capacity).toBe(76);
    expect(trace.components!.outputAssetQuality).toBe(100);
    expect(trace.capsApplied.some((cap) => cap.startsWith("fee-evidence:"))).toBe(false);
  });

  it.each(["C", "U"] as const)("uses the same %s factor causes for whole-Exit pricing and publication", (cause) => {
    const capacity = gap("U", "capacity");
    const cost = gap(cause, "cost");
    const result = evaluate([route({
      observationState: "missing", status: capacity.status, capacityCurve: [],
      factorStatuses: { capacity: capacity.status, cost: cost.status },
      gaps: [capacity.gap, cost.gap],
    })]);
    expect(result.limitedEvidenceCauses).toEqual(cause === "C" ? ["C", "U"] : ["U"]);
    expect(result.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.unknownQuality.exit[cause]);
    expect(result.causeGapIds).toEqual(["capacity", "cost"]);
  });

  it.each(["C", "U"] as const)("prices only uncovered supply at the %s unknown value", (cause) => {
    const missing = gap(cause, "partial-census");
    for (const coveredShare of [0, 0.6, 0.995]) {
      const result = evaluateV9Exit({
        circulatingUsd: 20_000_000, portfolioStatus: "incomplete",
        portfolioFactStatus: missing.status, verifiedNoPoolsSupplyShare: coveredShare,
        gaps: [missing.gap], routes: [],
      }, V9_CANDIDATE_POLICY_V1);
      expect(result.score).toBeCloseTo((1 - coveredShare) *
        V9_CANDIDATE_POLICY_V1.policy.semantic.unknownQuality.exit[cause], 2);
      expect(result.limitedEvidenceCauses).toEqual([cause]);
      expect(result.reasons).not.toContain("no-viable-exit-path");
    }
  });

  it("never admits A-stale history as current capacity or as a charged floor", () => {
    const missing = gap("A", "stale");
    const stale = route({ observationState: "stale", status: missing.status,
      factorStatuses: { capacity: missing.status }, gaps: [missing.gap] });
    const result = evaluate([stale]);
    expect(result.score).toBeNull();
    expect(result.aggregationDisposition).toBe("excluded-a-b");
    expect(result.routes[0]!.capacityPoint).toBeNull();
    expect(result.primaryRouteKey).toBeNull();
    expect(result.limitedEvidenceCauses).toEqual([]);
    expect(evaluate([route({ observationState: "stale" })]).routes[0]!.confidenceFactor).toBe(0.6);
  });

  it("keeps an admitted exhaustive zero at zero even when A/B alternatives are unavailable", () => {
    const missing = gap("B", "alternative");
    const zero = route({ capacityCurve: route().capacityCurve.map((point) => ({ ...point, executableUsd: 0, completionRatio: 0 })) });
    const alternative = route({ routeKey: "missing", observationState: "missing", status: missing.status,
      factorStatuses: { capacity: missing.status }, gaps: [missing.gap] });
    const result = evaluate([zero, alternative]);
    expect(result.score).toBe(0);
    expect(result.reasons).toContain("no-viable-exit-path");
  });

  it.each(["C", "U"] as const)("prices an unavailable %s rail when only immaterial DEX measurements remain", (cause) => {
    const missing = gap(cause, "unavailable-rail");
    const tiny = route({
      routeKey: "dex:immaterial", lane: "dex", routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      capacityCurve: route().capacityCurve.map((point) => ({
        ...point, executableUsd: 1, completionRatio: 1 / point.requestedNotionalUsd,
      })),
    });
    const unavailable = route({
      routeKey: "redemption:unavailable", observationState: "missing", status: missing.status,
      factorStatuses: { capacity: missing.status }, gaps: [missing.gap], capacityCurve: [],
    });
    for (const routes of [[tiny, unavailable], [unavailable, tiny]]) {
      const result = evaluate(routes);
      expect(result.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.unknownQuality.exit[cause]);
      expect(result.primaryRouteKey).toBeNull();
      expect(result.supportedComponentKeys).toEqual([]);
      expect(result.limitedEvidenceCauses).toEqual([cause]);
      expect(result.causeGapIds).toContain(missing.gap.gapId);
      expect(result.reasons).toContain("missing-same-notional-route");
      expect(result.reasons).not.toContain("no-viable-exit-path");
      expect(result.routes.find((candidate) => candidate.routeKey === tiny.routeKey)).toMatchObject({
        score: 0, capsApplied: ["immaterial-executable-capacity"],
      });
    }
    const measuredZero = evaluate([{
      ...tiny, capacityCurve: tiny.capacityCurve.map((point) => ({ ...point, executableUsd: 0, completionRatio: 0 })),
    }, unavailable]);
    expect(measuredZero.score).toBe(0);
    expect(measuredZero.reasons).toContain("no-viable-exit-path");
  });

  it.each(["C", "U"] as const)("does not turn a bounded %s empty census into measured exhaustion", (cause) => {
    const missing = gap(cause, "unavailable-census");
    const result = evaluateV9Exit({
      circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete",
      portfolioFactStatus: missing.status, gaps: [missing.gap], routes: [],
    }, V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.unknownQuality.exit[cause]);
    expect(result.limitedEvidenceCauses).toEqual([cause]);
    expect(result.reasons).not.toContain("no-viable-exit-path");
  });
});

describe("bounded settlement subfactors", () => {
  it("retains live capacity and output while bounding an unresolved completion term", () => {
    const candidate = route({ scoreEligible: false, settlementBoundUnproven: true,
      settlement: "queued", settlementDelaySec: 30 * 86_400, coverageClass: "exact-lower-bound" });
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [candidate] }, V9_CANDIDATE_POLICY_V1);
    expect(result.routes[0]).toMatchObject({
      included: true, score: 70, components: { settlement: 50, capacity: 76, outputAssetQuality: 100 },
    });
    const unsupportedOutput = evaluateV9Exit({
      circulatingUsd: 20_000_000, routes: [{ ...candidate, outputResolved: false }],
    }, V9_CANDIDATE_POLICY_V1);
    expect(unsupportedOutput.primaryRouteKey).toBeNull();
    expect(unsupportedOutput.routes[0]!.exclusionReason).toBe("unresolved-exit-output");
  });
});
