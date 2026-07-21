import { describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  evaluateV9Exit,
  projectV9ExitEvaluationRoute,
  selectV9ExitStressRequest,
  type V9ExitEvaluationRoute,
} from "../safety-score-v9/exit";

function route(overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute {
  return {
    routeKey: "redemption:issuer",
    lane: "redemption",
    routeFamily: "issuer-redemption",
    applicability: "required",
    observationState: "known",
    scoreEligible: true,
    coverageClass: "exact-complete",
    evidenceKind: "onchain-contract-state",
    observationConfidence: "high",
    modelConfidence: "high",
    access: "permissionless-onchain",
    holderEligibility: "any-holder",
    settlement: "atomic",
    settlementDelaySec: 300,
    execution: "deterministic-onchain",
    outputQuality: "stable-single",
    outputResolved: true,
    outputValueRetention: 1,
    capacityCurve: [
      {
        requestedNotionalUsd: 100_000,
        maxCostBps: 200,
        executableUsd: 100_000,
        completionRatio: 1,
        executionCostBps: 0,
      },
      {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        executableUsd: 1_000_000,
        completionRatio: 1,
        executionCostBps: 0,
      },
      {
        requestedNotionalUsd: 10_000_000,
        maxCostBps: 200,
        executableUsd: 10_000_000,
        completionRatio: 1,
        executionCostBps: 0,
      },
      {
        requestedNotionalUsd: 25_000_000,
        maxCostBps: 200,
        executableUsd: 25_000_000,
        completionRatio: 1,
        executionCostBps: 0,
      },
    ],
    routeScoreCap: null,
    failureDomains: ["redemption-rail:issuer"],
    physicalResourceKeys: ["rail:issuer"],
    ...overrides,
  };
}

describe("selectV9ExitStressRequest", () => {
  it("snaps the supply-relative request upward to the reviewed grid", () => {
    expect(selectV9ExitStressRequest(100_000_000, V9_CANDIDATE_POLICY_V1)).toMatchObject({
      rawSupplyRequestUsd: 5_000_000,
      requestedNotionalUsd: 10_000_000,
      maxCostBps: 200,
    });
    expect(selectV9ExitStressRequest(100_000, V9_CANDIDATE_POLICY_V1)?.requestedNotionalUsd).toBe(100_000);
    expect(selectV9ExitStressRequest(10_000_000_000, V9_CANDIDATE_POLICY_V1)?.requestedNotionalUsd).toBe(25_000_000);
  });

  it("fails closed without valid circulating supply", () => {
    expect(selectV9ExitStressRequest(null, V9_CANDIDATE_POLICY_V1)).toBeNull();
    expect(selectV9ExitStressRequest(0, V9_CANDIDATE_POLICY_V1)).toBeNull();
  });
});

describe("evaluateV9Exit", () => {
  it("lets a complete 1:1 redemption route support a strong exit score despite absent DEX depth", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [route()] }, V9_CANDIDATE_POLICY_V1);
    expect(result.primaryRouteKey).toBe("redemption:issuer");
    expect(result.score).toBeGreaterThanOrEqual(90);
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

  it("adds only a bounded benefit for a disjoint independent route", () => {
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
    expect(result.score).toBeLessThanOrEqual(100);
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
    expect(diagnostic.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
    expect(diagnostic.primaryRouteKey).toBeNull();
    expect(diagnostic.reasons).toContain("unsupported-same-notional-route");
    expect(lowerBound.score!).toBeGreaterThan(diagnostic.score!);
  });

  it("scores a reviewed absence of viable routes poorly and bounds incomplete evidence", () => {
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

    expect(reviewed.score).toBe(0);
    expect(reviewed.reasons).toContain("no-viable-exit-path");
    expect(incomplete.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
    expect(incomplete.primaryRouteKey).toBeNull();
    expect(incomplete.reasons).toContain("missing-same-notional-route");
    expect(incomplete.score!).toBeGreaterThan(reviewed.score!);
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

  it("floors a zero-capacity route to zero instead of letting an undisclosed cost carry it", () => {
    // The exact shape that scored 35.61 before the floor: capacity carries 25%
    // of the ladder, so access/settlement/execution/output plus a
    // boundedCostScore awarded *because* the cost is undisclosed used to carry
    // a route that provably clears $0 at the stress cost.
    const zeroCapacity = route({
      routeKey: "redemption:undisclosed-cost",
      access: "issuer-api",
      holderEligibility: "verified-customer",
      settlement: "same-day",
      settlementDelaySec: 86_400,
      modelConfidence: "medium",
      evidenceKind: "documented-terms",
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
    const trace = result.routes.find((entry) => entry.routeKey === "redemption:undisclosed-cost");
    expect(trace?.included).toBe(true);
    expect(trace?.capacityPoint?.executableUsd).toBe(0);
    // The non-capacity ladder is untouched — the floor, not a component change,
    // is what removes the score.
    expect(trace?.components?.cost).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedCostScore);
    expect(trace?.components?.capacity).toBe(0);
    expect(trace?.score).not.toBeCloseTo(35.61, 2);
    expect(trace?.score).toBe(0);
    expect(trace?.capsApplied).toContain("zero-executable-capacity");
  });

  it("floors a route that fills a vanishing fraction of the stress request", () => {
    // The owner's motivating case: $13.93 against a $25M request scored 46.31,
    // which is not an exit at any portfolio size. The cut is relative, so it
    // scales with the asset instead of encoding a dollar constant.
    const shoulder = (executableUsd: number) =>
      route({
        routeKey: "dex:thin-depth",
        lane: "dex",
        routeFamily: "dex-amm",
        evidenceKind: "measured-executable-depth",
        capacityCurve: [
          {
            requestedNotionalUsd: 25_000_000,
            maxCostBps: 200,
            executableUsd,
            completionRatio: executableUsd / 25_000_000,
            executionCostBps: 200,
          },
        ],
      });
    const evaluate = (executableUsd: number) =>
      evaluateV9Exit({ circulatingUsd: 1_000_000_000, routes: [shoulder(executableUsd)] }, V9_CANDIDATE_POLICY_V1)
        .routes.find((entry) => entry.routeKey === "dex:thin-depth");

    const immaterial = evaluate(13.93);
    expect(immaterial?.included).toBe(true);
    expect(immaterial?.score).not.toBeCloseTo(46.31, 2);
    expect(immaterial?.score).toBe(0);
    expect(immaterial?.capsApplied).toContain("immaterial-executable-capacity");

    // The floor is the ratio at which coverage stops moving the published
    // score: (20 / 0.01) * 0.6 * 0.25 = 300 score per unit ratio, against the
    // 0.005 rounding quantum, so ~1.667e-5 of the request — $416.67 here.
    const exit = V9_CANDIDATE_POLICY_V1.policy.semantic.exit;
    const anchor = exit.coverageRatioBreakpoints.find((point) => point.value > 0 && point.score > 0)!;
    const floorRatio = 0.005 / ((anchor.score / anchor.value) * 0.6 * exit.componentWeights.capacity);
    expect(floorRatio).toBeCloseTo(1.667e-5, 8);

    // Real-but-thin capacity above the floor keeps its credit; the rule removes
    // vanishing routes, not small ones.
    const material = evaluate(25_000_000 * floorRatio * 1.5);
    expect(material?.score).toBeGreaterThan(0);
    expect(material?.capsApplied).not.toContain("immaterial-executable-capacity");
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

  it("is deterministic under route and capacity-curve permutation", () => {
    const first = route();
    const second = route({
      routeKey: "dex:second",
      lane: "dex",
      routeFamily: "dex-amm",
      evidenceKind: "measured-executable-depth",
      failureDomains: ["dex-protocol:second"],
      physicalResourceKeys: ["pool:second"],
      capacityCurve: [...route().capacityCurve].reverse(),
    });
    const forward = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [first, second] }, V9_CANDIDATE_POLICY_V1);
    const reverse = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [second, first] }, V9_CANDIDATE_POLICY_V1);
    expect(reverse).toEqual(forward);
  });

  it("projects explicit normalized route facts without route-family access inference", () => {
    const projected = projectV9ExitEvaluationRoute({
      routeKey: "redemption:generation:route",
      routeId: "route",
      lane: "redemption",
      sourceGenerationId: "generation",
      routeFamily: "issuer-redemption",
      holderAccess: "allowlisted",
      executionModel: "deterministic",
      executionCertainty: "bounded",
      modelConfidence: "high",
      observationConfidence: "medium",
      evidenceKind: "documented-terms",
      coverageClass: "exact-lower-bound",
      settlementModel: "same-day",
      settlementSlaSec: 86_400,
      settlementEvidenceRefIds: ["settlement"],
      physicalResourceKeys: ["rail:issuer"],
      status: {
        applicability: { state: "required", policyRuleId: "route-required", rationale: null, gapId: null },
        observationState: "known",
        evidenceRefIds: ["route"],
        gapIds: [],
      },
      scoreEligible: true,
      request: { requestedNotionalUsd: 1_000_000, maxCostBps: 200, settlementHorizonSec: 300 },
      capacityCurve: [
        {
          requestedNotionalUsd: 1_000_000,
          maxCostBps: 200,
          executableUsd: 1_000_000,
          completionRatio: 1,
          executionCostBps: 10,
        },
      ],
      output: {
        status: {
          applicability: { state: "required", policyRuleId: "output-required", rationale: null, gapId: null },
          observationState: "known",
          evidenceRefIds: ["valuation"],
          gapIds: [],
        },
        kind: "fiat",
        assetKeys: ["USD"],
        basketWeights: [],
        valuation: {
          basis: "reviewed-par",
          referenceAssetKey: "USD",
          unitValueUsd: 1,
          expectedUnitValueUsd: 1,
          valueRetentionRatio: 1,
          sourceId: "valuation-source",
          sourceGenerationId: "valuation-generation",
          observedAtSec: 1,
          asOfSec: 1,
          confidence: "high",
          freshness: { state: "current", ageSec: 0, maxAgeSec: 1 },
          evidenceRefIds: ["valuation"],
        },
      },
      failureDomains: [{ kind: "redemption-rail", key: "issuer" }],
    });
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
    const daysRoute = {
      routeKey: "redemption:generation:days",
      routeId: "days",
      lane: "redemption" as const,
      sourceGenerationId: "generation",
      routeFamily: "eventual-redemption" as const,
      holderAccess: "retail-open" as const,
      executionModel: "deterministic" as const,
      executionCertainty: "bounded" as const,
      modelConfidence: "high" as const,
      observationConfidence: "medium" as const,
      evidenceKind: "documented-terms" as const,
      coverageClass: "exact-lower-bound" as const,
      settlementModel: "bounded-delay" as const,
      settlementSlaSec: null,
      settlementEvidenceRefIds: ["settlement"],
      physicalResourceKeys: ["rail:issuer"],
      status: {
        applicability: { state: "required" as const, policyRuleId: "route-required", rationale: null, gapId: null },
        observationState: "known" as const,
        evidenceRefIds: ["route"],
        gapIds: [],
      },
      scoreEligible: false,
      request: { requestedNotionalUsd: 1_000_000, maxCostBps: 200, settlementHorizonSec: 1_209_600 },
      capacityCurve: [
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000, completionRatio: 1, executionCostBps: 10 },
      ],
      output: {
        status: {
          applicability: { state: "required" as const, policyRuleId: "output-required", rationale: null, gapId: null },
          observationState: "known" as const,
          evidenceRefIds: ["valuation"],
          gapIds: [],
        },
        kind: "fiat" as const,
        assetKeys: ["USD"],
        basketWeights: [],
        valuation: {
          basis: "reviewed-par" as const,
          referenceAssetKey: "USD",
          unitValueUsd: 1,
          expectedUnitValueUsd: 1,
          valueRetentionRatio: 1,
          sourceId: "valuation-source",
          sourceGenerationId: "valuation-generation",
          observedAtSec: 1,
          asOfSec: 1,
          confidence: "high" as const,
          freshness: { state: "current" as const, ageSec: 0, maxAgeSec: 1 },
          evidenceRefIds: ["valuation"],
        },
      },
      failureDomains: [{ kind: "redemption-rail" as const, key: "issuer" }],
    };
    expect(projectV9ExitEvaluationRoute(daysRoute).settlementDelaySec).toBe(1_209_600);
  });
});

describe("reliable non-atomic redemption credit", () => {
  function redemptionRoute(overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute {
    return route({
      routeKey: "redemption:eventual",
      routeFamily: "eventual-redemption",
      scoreEligible: false,
      coverageClass: "exact-lower-bound",
      evidenceKind: "documented-terms",
      access: "issuer-api",
      holderEligibility: "any-holder",
      execution: "rules-based-nav",
      outputQuality: "stable-single",
      settlement: "same-day",
      settlementDelaySec: 86_400,
      capacityCurve: [
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000, completionRatio: 1, executionCostBps: 10 },
        { requestedNotionalUsd: 10_000_000, maxCostBps: 200, executableUsd: 10_000_000, completionRatio: 1, executionCostBps: 10 },
      ],
      failureDomains: ["redemption-rail:issuer"],
      physicalResourceKeys: ["rail:issuer"],
      ...overrides,
    });
  }

  it("credits a documented, reliable, non-atomic redemption above zero", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [redemptionRoute()] }, V9_CANDIDATE_POLICY_V1);
    // Above the bounded-unknown floor but below an atomic same-notional path.
    expect(result.score).toBeGreaterThan(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
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
    expect(days.score!).toBeGreaterThan(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
  });

  it("keeps a zero-clearing (unbounded-cost) documented redemption excluded at the bounded floor", () => {
    const zeroCost = redemptionRoute({
      capacityCurve: [
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: 200 },
      ],
    });
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [zeroCost] }, V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
    expect(result.reasons).toContain("unsupported-same-notional-route");
  });

  it("keeps an unresolved-output documented redemption excluded", () => {
    const result = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [redemptionRoute({ outputResolved: false })] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
  });

  it("does not credit a native non-eventual redemption family that failed the score gate", () => {
    // Native issuer/protocol observations carry scoreEligible=false for
    // reliability reasons (impairment, closed route); only the derived
    // eventual-redemption family is admitted to the relaxed credit.
    const result = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [redemptionRoute({ routeFamily: "issuer-redemption" })] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
  });
});
