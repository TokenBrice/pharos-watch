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
    capacityScoringHorizon: "immediate",
    settlement: "atomic",
    settlementDelaySec: 300,
    queueDepthUsd: null,
    dailyLimitUsd: null,
    minRedeemUsd: null,
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

  it("keeps immediate, near-term, and queued capacity in explicit horizon lanes", () => {
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
      routeScoreCap: "queue-redeem",
    });
    const result = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [queued, nearTerm, immediate] },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.stressRequest?.comparisonWindowSec).toBe(300);
    expect(result.horizons).toEqual({
      immediate: expect.objectContaining({ primaryRouteKey: "redemption:immediate" }),
      "near-term": expect.objectContaining({ primaryRouteKey: "redemption:near-term" }),
      queued: expect.objectContaining({ primaryRouteKey: "redemption:queued" }),
    });
    expect(result.routes.find((entry) => entry.routeKey === "redemption:queued")?.horizon).toBe("queued");
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
            routeScoreCap: "queue-redeem",
          }),
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.score).toBeGreaterThan(0);
    expect(result.horizons.immediate).toEqual({ primaryRouteKey: null, score: null });
    expect(result.horizons.queued.primaryRouteKey).toBe("redemption:30-day-queue");
  });

  it("does not promote a zero-capacity issuer-discretionary queued route as a positive exit path", () => {
    const zeroQueue = route({
      routeKey: "redemption:dusd-async-redeemer",
      routeFamily: "protocol-redemption",
      access: "whitelisted-onchain",
      holderEligibility: "issuer-discretionary",
      settlement: "queued",
      queueDepthUsd: 3_104.889979,
      execution: "opaque",
      capacityScoringHorizon: "queued",
      routeScoreCap: "queue-redeem",
      capacityCurve: [
        { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: 0 },
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: 0 },
      ],
    });

    const result = evaluateV9Exit({ circulatingUsd: 5_800_000, routes: [zeroQueue] }, V9_CANDIDATE_POLICY_V1);

    expect(result.primaryRouteKey).toBeNull();
    expect(result.horizons.queued.primaryRouteKey).toBeNull();
  });

  it("keeps daily capacity in the bounded near-term lane even when transfers settle atomically", () => {
    const result = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        routes: [
          route({
            routeKey: "redemption:daily-capacity",
            capacityScoringHorizon: "daily",
            dailyLimitUsd: 1_000_000,
          }),
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(
      V9_CANDIDATE_POLICY_V1.policy.semantic.exit.routeFamilyCaps.queueRedeem,
    );
    expect(result.horizons.immediate).toEqual({ primaryRouteKey: null, score: null });
    expect(result.horizons["near-term"].primaryRouteKey).toBe("redemption:daily-capacity");
  });

  it("prices queue backlog and minimum redemption gates through the reviewed constraint bands", () => {
    const base = route({
      routeKey: "redemption:queue-terms",
      capacityScoringHorizon: "queued",
      settlement: "queued",
      settlementDelaySec: 30 * 86_400,
      routeScoreCap: "queue-redeem",
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
      horizon: "queued",
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
    expect(incomplete.reasons).toContain("unsupported-same-notional-route");
    expect(incomplete.reasons).not.toContain("missing-same-notional-route");
    expect(incomplete.score!).toBeGreaterThan(reviewed.score!);
  });

  it("still marks a genuinely absent route set as missing evidence", () => {
    const result = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        portfolioStatus: "incomplete",
        routes: [],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
    expect(result.reasons).toEqual(["missing-same-notional-route"]);
  });

  // R4 scope verification (owner ruling 2026-07-29). The zero-evaluated-route
  // return suppresses the default reason only when EVERY per-route diagnostic
  // is `unsupported-same-notional-route`. Diagnostics come from route traces,
  // so a portfolio with no routes at all has none to inspect and the default
  // reason is emitted unconditionally. A fact-set gap carrying
  // `unsupported-same-notional-route` never reaches this predicate, so
  // reclassifying the zero-route branch does NOT self-suppress the echo.
  it("does not self-suppress the missing-route echo when there is no route to diagnose", () => {
    const withDiagnosticRoute = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        portfolioStatus: "incomplete",
        routes: [route({ coverageClass: "diagnostic" })],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(withDiagnosticRoute.reasons).toEqual(["unsupported-same-notional-route"]);

    const withoutAnyRoute = evaluateV9Exit(
      { circulatingUsd: 20_000_000, portfolioStatus: "incomplete", routes: [] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(withoutAnyRoute.reasons).toContain("missing-same-notional-route");
    expect(withoutAnyRoute.reasons).not.toContain("unsupported-same-notional-route");
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
      V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedCostScore,
    );
    expect(favorableMeasured.components?.cost).toBeGreaterThan(boundedUnknown.components!.cost);
    expect(favorableMeasured.score).toBeGreaterThan(boundedUnknown.score!);
    expect(adverseMeasured.components?.cost).toBeLessThan(boundedUnknown.components!.cost);
    expect(adverseMeasured.score).toBeLessThan(boundedUnknown.score!);

    const measuredCosts = [0, 20, 50, 80, 100, 120, 150, 180, 199];
    const measuredScores = measuredCosts.map((cost) => traceAtCost(cost).score!);
    expect(measuredScores.every((score, index) => index === 0 || score <= measuredScores[index - 1]!)).toBe(true);
  });

  it("floors a zero-capacity route to zero instead of letting an undisclosed cost carry it", () => {
    // The exact shape that scored 35.61 before the floor: capacity carries 25%
    // of the ladder, so access/settlement/execution/output plus a
    // boundedCostScore awarded *because* the cost is undisclosed used to carry
    // a route that provably clears $0 at the stress cost. A DEX route exercises
    // this general zero-capacity floor without being intercepted by the
    // non-atomic redemption credit gate (a documented issuer/protocol redemption
    // with zero capacity is now excluded upstream instead — see Lever 3 below).
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

    // Materiality starts at the first positive economic policy breakpoint:
    // either 1% of the request or $100K of absolute executable capacity.
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

});

// Lever 3 (V9 scoring reshape): the exit pillar now credits documented,
// reliable issuer- and protocol-redemption channels — not only the derived
// eventual-redemption family — while every reliability gate and the
// all-zero-capacity floor stay in force. Impaired/frozen routes are excluded by
// reporting zero capacity, so relaxing the family gate cannot lift them.
describe("Lever 3 issuer/protocol redemption credit", () => {
  const floor = V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore;

  function documentedRedemption(overrides: Partial<V9ExitEvaluationRoute> = {}): V9ExitEvaluationRoute {
    return route({
      routeKey: "redemption:issuer-documented",
      routeFamily: "issuer-redemption",
      // A native issuer observation fails the atomic-only score gate; credit now
      // comes from the reliability gate, not scoreEligible.
      scoreEligible: false,
      coverageClass: "exact-lower-bound",
      evidenceKind: "documented-terms",
      access: "issuer-api",
      holderEligibility: "any-holder",
      execution: "rules-based-nav",
      outputQuality: "stable-single",
      settlement: "same-day",
      settlementDelaySec: 86_400, // T+1 → 0.9 settlement-delay multiplier
      capacityCurve: [
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000, completionRatio: 1, executionCostBps: 10 },
        { requestedNotionalUsd: 10_000_000, maxCostBps: 200, executableUsd: 10_000_000, completionRatio: 1, executionCostBps: 10 },
      ],
      failureDomains: ["redemption-rail:issuer"],
      physicalResourceKeys: ["rail:issuer"],
      ...overrides,
    });
  }

  it("credits a documented, nonzero-capacity issuer redemption well above the bounded floor", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [documentedRedemption()] }, V9_CANDIDATE_POLICY_V1);
    expect(result.primaryRouteKey).toBe("redemption:issuer-documented");
    // Previously floored to 35 by the eventual-only family gate; now scored on
    // its evidence with only the T+1 settlement haircut.
    expect(result.score!).toBeGreaterThan(floor);
    expect(result.score!).toBeGreaterThan(55);
  });

  it("credits a documented, nonzero-capacity protocol redemption above the bounded floor", () => {
    const result = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        routes: [
          documentedRedemption({
            routeKey: "redemption:protocol-documented",
            routeFamily: "protocol-redemption",
            failureDomains: ["redemption-rail:protocol"],
            physicalResourceKeys: ["rail:protocol"],
          }),
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.primaryRouteKey).toBe("redemption:protocol-documented");
    expect(result.score!).toBeGreaterThan(floor);
  });

  it("applies the settlement haircut: a 7-day issuer redemption scores strictly below a same-day one", () => {
    const sameDay = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [documentedRedemption()] }, V9_CANDIDATE_POLICY_V1);
    const sevenDay = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [documentedRedemption({ settlement: "days", settlementDelaySec: 604_800 })] },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(sevenDay.score!).toBeLessThan(sameDay.score!);
    expect(sevenDay.score!).toBeGreaterThan(floor);
  });

  it("caps a strong documented-terms route at the credit ceiling while a stronger evidence kind is uncapped", () => {
    const ceiling = V9_CANDIDATE_POLICY_V1.policy.semantic.exit.documentedTermsCreditCeiling;
    // A strong composite (permissionless, immediate, deterministic, par, fast)
    // would score ~92 uncapped — above the ceiling for both evidence kinds.
    const strong = (evidenceKind: string, extra: Partial<V9ExitEvaluationRoute> = {}) =>
      documentedRedemption({
        evidenceKind,
        access: "permissionless-onchain",
        holderEligibility: "any-holder",
        execution: "deterministic-onchain",
        settlement: "immediate",
        settlementDelaySec: 300,
        ...extra,
      });
    const paper = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [strong("documented-terms")] },
      V9_CANDIDATE_POLICY_V1,
    );
    const onchain = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        routes: [strong("onchain-contract-state", { routeKey: "redemption:onchain-strong", scoreEligible: true })],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    const paperTrace = paper.routes.find((entry) => entry.routeKey === "redemption:issuer-documented");
    // Paper promise capped exactly at the ceiling; the on-chain-verifiable route
    // keeps its full credit above it.
    expect(paperTrace?.score).toBe(ceiling);
    expect(paperTrace?.capsApplied).toContain("evidence-kind:documented-terms");
    expect(onchain.score!).toBeGreaterThan(ceiling);
    // A typical same-day documented EMI scores below the ceiling and stays
    // untouched — the ceiling trims only the strongest paper-promise routes.
    const sameDay = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [documentedRedemption()] }, V9_CANDIDATE_POLICY_V1);
    expect(sameDay.score!).toBeLessThan(ceiling);
    const sameDayTrace = sameDay.routes.find((entry) => entry.routeKey === "redemption:issuer-documented");
    expect(sameDayTrace?.capsApplied).not.toContain("evidence-kind:documented-terms");
  });

  it("keeps a zero-capacity issuer redemption floored — the pin-safe data invariant, not the family gate", () => {
    // TUSD / u-united-stables pass every reliability gate but report an
    // all-zero-capacity curve (frozen/impaired), so they must stay excluded even
    // now that the issuer family is admitted.
    const zeroCapacity = documentedRedemption({
      capacityCurve: [
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: 200 },
      ],
    });
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [zeroCapacity] }, V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(floor);
    expect(result.primaryRouteKey).toBeNull();
    expect(result.reasons).toContain("unsupported-same-notional-route");
  });
});

describe("SIM-EXIT-L2 undisclosed-fee credit and danger-held exclusion", () => {
  const undisclosed = (overrides: Partial<V9ExitEvaluationRoute> = {}) =>
    route({ routeKey: "redemption:undisclosed", feeEvidence: "undisclosed-reviewed", ...overrides });

  it("ceilings an undisclosed-reviewed route's credit at the policy ceiling", () => {
    const ceiling = V9_CANDIDATE_POLICY_V1.policy.semantic.exit.undisclosedFeeRouteScoreCeiling;
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [undisclosed()] }, V9_CANDIDATE_POLICY_V1);
    const trace = result.routes.find((entry) => entry.routeKey === "redemption:undisclosed");
    // Without the ceiling this strong route scores well above 52; the cap binds.
    expect(trace?.score).not.toBeNull();
    expect(trace!.score!).toBeLessThanOrEqual(ceiling);
    expect(trace!.capsApplied).toContain("fee-evidence:undisclosed-reviewed");
  });

  it("withholds all undisclosed-fee credit from a pre-exit danger-held asset (byte-identical to pre-lever exclusion)", () => {
    const held = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [undisclosed()], preExitDangerHeld: true },
      V9_CANDIDATE_POLICY_V1,
    );
    const heldTrace = held.routes.find((entry) => entry.routeKey === "redemption:undisclosed");
    expect(heldTrace?.score).toBeNull();
    expect(heldTrace?.exclusionReason).toBe("unsupported-same-notional-route");
    expect(heldTrace?.capsApplied).toEqual([]);
    expect(held.primaryRouteKey).toBeNull();
    // The same route on a non-danger-held asset keeps its (ceilinged) credit.
    const credited = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [undisclosed()], preExitDangerHeld: false },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(credited.routes.find((entry) => entry.routeKey === "redemption:undisclosed")?.score).not.toBeNull();
  });

  it("leaves a route without an undisclosed fee untouched by the ceiling and the danger gate", () => {
    const documented = route({ routeKey: "redemption:documented", evidenceKind: "documented-terms" });
    const base = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [documented] }, V9_CANDIDATE_POLICY_V1);
    const baseTrace = base.routes.find((entry) => entry.routeKey === "redemption:documented");
    expect(baseTrace?.capsApplied).not.toContain("fee-evidence:undisclosed-reviewed");
    // The danger gate only excludes the undisclosed-fee class, so a documented
    // route on a danger-held asset scores exactly as it does otherwise.
    const held = evaluateV9Exit(
      { circulatingUsd: 20_000_000, routes: [documented], preExitDangerHeld: true },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(held.routes.find((entry) => entry.routeKey === "redemption:documented")?.score).toEqual(baseTrace?.score);
  });
});

describe("undisclosed-fee routes stay bounded at the portfolio level", () => {
  const undisclosedAt = (routeKey: string, routeFamily: V9ExitEvaluationRoute["routeFamily"]) =>
    route({
      routeKey,
      feeEvidence: "undisclosed-reviewed",
      routeFamily,
    });

  it("two independent undisclosed-fee routes cannot stack past the ceiling via the diversification bonus", () => {
    const ceiling = V9_CANDIDATE_POLICY_V1.policy.semantic.exit.undisclosedFeeRouteScoreCeiling;
    const result = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        routes: [undisclosedAt("redemption:opaque-a", "issuer-redemption"), undisclosedAt("dex:opaque-b", "dex-amm")],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.diversificationBonus).toBe(0);
    expect(result.score).toBeLessThanOrEqual(ceiling);
  });

  it("an undisclosed-fee secondary donates no diversification bonus to a disclosed primary", () => {
    const disclosedPrimary = route({ routeKey: "dex:disclosed-primary" });
    const solo = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [disclosedPrimary] }, V9_CANDIDATE_POLICY_V1);
    const paired = evaluateV9Exit(
      {
        circulatingUsd: 20_000_000,
        routes: [route({ routeKey: "dex:disclosed-primary" }), undisclosedAt("redemption:opaque-c", "issuer-redemption")],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(paired.diversificationBonus).toBe(0);
    expect(paired.score).toBe(solo.score);
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

  it("keeps a missing observation excluded so absent evidence still fails closed", () => {
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
    expect(missing.score).toBe(0);
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
