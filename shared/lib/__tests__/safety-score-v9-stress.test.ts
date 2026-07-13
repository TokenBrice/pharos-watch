import { describe, expect, it } from "vitest";
import type { V9ExitEvaluationRoute } from "../safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9ProductionScoreInput } from "../safety-score-v9/score";
import {
  createV9PublicStressState,
  evaluateV9StressState,
} from "../safety-score-v9/stress";

function route(routeKey: string, failureDomain: string): V9ExitEvaluationRoute {
  return {
    routeKey,
    lane: routeKey.startsWith("dex") ? "dex" : "redemption",
    routeFamily: routeKey.startsWith("dex") ? "dex-amm" : "issuer-redemption",
    applicability: "required",
    observationState: "known",
    scoreEligible: true,
    coverageClass: "exact-complete",
    evidenceKind: routeKey.startsWith("dex") ? "measured-executable-depth" : "onchain-contract-state",
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
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        executableUsd: 1_000_000,
        completionRatio: 1,
        executionCostBps: 0,
      },
    ],
    routeScoreCap: null,
    failureDomains: [failureDomain],
    physicalResourceKeys: [failureDomain],
  };
}

function scoreInput(): V9ProductionScoreInput {
  const pillar = { score: 90, evidenceLevel: "strong" as const, reasons: [], structuralSignals: [] };
  return {
    assetId: "asset",
    identity: {
      factSetDigest: "a".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
      evaluationBuildDigest: "c".repeat(64),
      asOfSec: 1_000,
      sourceGenerations: { dex: "dex:1" },
    },
    pillars: { backing: { ...pillar }, exit: { ...pillar }, control: { ...pillar } },
    peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [] },
    trackRecordMonths: 48,
    parent: { required: false, score: null, propagatedReasons: [] },
    dependencyReasons: [],
    dependencyStructuralSignals: [],
  };
}

describe("V9 public stress state", () => {
  it("uses the production scorer unchanged at baseline", () => {
    const state = createV9PublicStressState(scoreInput(), null);
    const result = evaluateV9StressState(state, V9_CANDIDATE_POLICY_V1);
    expect(result.finalScore).toBe(90);
  });

  it("re-evaluates the same Exit portfolio after route removal", () => {
    const primary = route("redemption:primary", "rail:primary");
    const alternative = route("dex:alternative", "pool:alternative");
    const state = createV9PublicStressState(scoreInput(), {
      circulatingUsd: 20_000_000,
      portfolioStatus: "reviewed-complete",
      routes: [primary, alternative],
    });
    const baseline = evaluateV9StressState(state, V9_CANDIDATE_POLICY_V1);
    const stressed = evaluateV9StressState(state, V9_CANDIDATE_POLICY_V1, {
      kind: "route-removal",
      routeKey: "redemption:primary",
    });
    expect(stressed.finalScore).not.toBeNull();
    expect(stressed.finalScore).toBeLessThanOrEqual(baseline.finalScore!);
  });

  it("routes backing, control, upstream, and common-mode shocks through the same cap formula", () => {
    const state = createV9PublicStressState(scoreInput(), null);
    expect(
      evaluateV9StressState(state, V9_CANDIDATE_POLICY_V1, { kind: "backing-haircut", haircutPct: 50 })
        .finalScore,
    ).toBeLessThan(90);
    expect(
      evaluateV9StressState(state, V9_CANDIDATE_POLICY_V1, {
        kind: "control-compromise",
        compromisedScore: 20,
        severity: "critical",
        failureDomainKey: "mint:admin",
      }).finalScore,
    ).toBeLessThan(90);
    expect(
      evaluateV9StressState(state, V9_CANDIDATE_POLICY_V1, {
        kind: "upstream-result-loss",
        upstreamAssetId: "parent",
      }).finalGrade,
    ).toBe("NR");
    expect(
      evaluateV9StressState(state, V9_CANDIDATE_POLICY_V1, {
        kind: "common-mode-failure",
        failureDomainKey: "custodian:bank",
        severity: "critical",
      }).bindingCap?.source,
    ).toBe("structural");
  });

  it("rejects tampered state and unknown routes", () => {
    const state = createV9PublicStressState(scoreInput(), {
      circulatingUsd: 20_000_000,
      portfolioStatus: "reviewed-complete",
      routes: [route("redemption:primary", "rail:primary")],
    });
    expect(() => evaluateV9StressState({ ...state, stateDigest: "0".repeat(64) }, V9_CANDIDATE_POLICY_V1)).toThrow(
      /digest mismatch/,
    );
    expect(() =>
      evaluateV9StressState(state, V9_CANDIDATE_POLICY_V1, { kind: "route-removal", routeKey: "missing" }),
    ).toThrow(/Unknown.*route/);
  });
});
