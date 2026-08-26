import { describe, expect, it } from "vitest";
import { MATCHED_V9_INVARIANTS, type MatchedV9Invariant } from "@shared/data/safety-score-v9/matched-invariants-v1";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { CompiledV9AssetInput, V9ScoringInput, V9StructuralSignal } from "@shared/types/safety-score-v9";
import { evaluateV9Exit, type V9ExitEvaluationRoute } from "../safety-score-v9/exit";
import {
  V9_CANDIDATE_POLICY_V1,
  deriveV9ReserveLossSignal,
  resolveV9StructuralCaps,
  scoreCompiledAssetSet,
  scoreV9Input,
} from "../safety-score-v9-research";
import { makeCompiledV9AssetInput } from "./safety-score-v9-score.test-support";

/**
 * Supply chosen so the pillar's grid-snapped stress request lands on the
 * corpus routes' own `requestedNotionalUsd` (5% of 20M = 1M, already a grid
 * point), keeping every corpus capacity point an exact match.
 */
const MATCHED_CIRCULATING_USD = 20_000_000;

/**
 * Project a corpus route observation into the Exit pillar's evaluation
 * vocabulary. The corpus fixes the route facts under test — family, evidence
 * kind, confidence, failure domains, and the capacity point — and this fills the
 * remaining fields with a neutral reviewed shape so the invariant measures the
 * route difference rather than the surrounding scaffolding.
 */
function evaluationRoute(observation: ExitRouteObservation): V9ExitEvaluationRoute {
  const lane =
    observation.routeFamily === "dex-amm" || observation.routeFamily === "dex-orderbook" ? "dex" : "redemption";
  return {
    routeKey: observation.routeId,
    lane,
    routeFamily: observation.routeFamily as V9ExitEvaluationRoute["routeFamily"],
    applicability: "required",
    settlementBoundUnproven: false,
    observationState: "known",
    scoreEligible: observation.scoreEligible,
    coverageClass: "exact-complete",
    evidenceKind: observation.evidenceKind,
    feeEvidence: null,
    observationConfidence: observation.confidence,
    modelConfidence: "high",
    observationHistory: null,
    access: lane === "dex" ? "permissionless-onchain" : "issuer-api",
    holderEligibility: lane === "dex" ? "any-holder" : "verified-customer",
    capacityScoringHorizon: "immediate",
    settlement: lane === "dex" ? "atomic" : "same-day",
    settlementDelaySec: 0,
    queueDepthUsd: null,
    dailyLimitUsd: null,
    minRedeemUsd: null,
    execution: "deterministic-onchain",
    outputQuality: "stable-single",
    outputResolved: true,
    outputValueRetention: 1,
    capacityCurve: [
      {
        requestedNotionalUsd: observation.requestedNotionalUsd,
        maxCostBps: observation.maxCostBps,
        executableUsd: observation.executableUsd,
        completionRatio: observation.completionRatio,
        executionCostBps: 0,
      },
    ],
    routeScoreCap: null,
    failureDomains: [...observation.commonModeKeys],
    physicalResourceKeys: [...observation.commonModeKeys],
  };
}

function scoringInput(overrides: Partial<V9ScoringInput> = {}): V9ScoringInput {
  return {
    assetId: "matched",
    pillars: { backing: 90, exit: 90, control: 90 },
    pegScore: 100,
    pegApplicable: true,
    evidenceLevel: "strong",
    trackRecordMonths: 48,
    activeDepegBps: null,
    parentRequired: false,
    parentScore: null,
    structuralSignals: [],
    unresolved: [],
    ...overrides,
  };
}

function scoreSignals(structuralSignals: readonly V9StructuralSignal[], overrides: Partial<V9ScoringInput> = {}) {
  return scoreV9Input(
    scoringInput({
      structuralSignals: [...structuralSignals],
      ...overrides,
    }),
    V9_CANDIDATE_POLICY_V1,
  );
}

function minimumCap(signals: readonly V9StructuralSignal[]): number {
  return Math.min(
    ...resolveV9StructuralCaps(signals, V9_CANDIDATE_POLICY_V1).map((cap) => cap.limit),
    Number.POSITIVE_INFINITY,
  );
}

const compiledInput = (assetId: string, pillarScore: number, parent: CompiledV9AssetInput["parent"] = null) =>
  makeCompiledV9AssetInput({ assetId, pillarScore, parent, sourceKey: "matched" });

function executeInvariant(invariant: MatchedV9Invariant): void {
  switch (invariant.kind) {
    case "exit-routes": {
      // The route-scoring engine under test is the Exit pillar: it is the one
      // surviving same-notional route grader, so the matched corpus measures
      // the shipped engine rather than a parallel shadow of it.
      const evaluate = (routes: readonly ExitRouteObservation[]) =>
        evaluateV9Exit(
          {
            circulatingUsd: MATCHED_CIRCULATING_USD,
            portfolioStatus: "reviewed-complete",
            routes: routes.map(evaluationRoute),
          },
          V9_CANDIDATE_POLICY_V1,
        );
      const before = evaluate(invariant.before);
      const after = evaluate(invariant.after);
      expect(after.score, invariant.id).not.toBeNull();
      expect(after.score!, invariant.id).toBeGreaterThanOrEqual(before.score ?? 0);
      if (invariant.id === "redemption-present") expect(after.score!, invariant.id).toBeGreaterThan(before.score ?? 0);
      return;
    }
    case "reserve-loss": {
      const before = scoreSignals([deriveV9ReserveLossSignal(invariant.before, V9_CANDIDATE_POLICY_V1)]);
      const after = scoreSignals([deriveV9ReserveLossSignal(invariant.after, V9_CANDIDATE_POLICY_V1)]);
      expect(after.finalScore!, invariant.id).toBeLessThan(before.finalScore ?? 0);
      expect(after.structuralSignals[0]?.materialSharePct, invariant.id).toBeGreaterThan(
        before.structuralSignals[0]?.materialSharePct ?? 0,
      );
      return;
    }
    case "structural-signals": {
      const before = minimumCap(invariant.before);
      const after = minimumCap(invariant.after);
      expect(after, invariant.id).toBeLessThan(before);
      return;
    }
    case "scoring-facts": {
      const score = (variant: (typeof invariant.variants)[keyof typeof invariant.variants]) =>
        scoreSignals(variant.structuralSignals, { unresolved: [...variant.unresolved] });
      const absent = score(invariant.variants.absent);
      const strong = score(invariant.variants.strong);
      const weak = score(invariant.variants.weak);
      const unavailable = score(invariant.variants.unavailable);
      expect(strong.finalScore, invariant.id).toBe(absent.finalScore);
      expect(weak.finalScore!, invariant.id).toBeLessThan(strong.finalScore ?? 0);
      // An integration-owned unavailable dependency stays rateable under its
      // configured bounded-evidence ceiling.
      expect(unavailable.finalGrade, invariant.id).not.toBe("NR");
      expect(unavailable.finalScore!, invariant.id).toBeLessThanOrEqual(weak.finalScore!);
      expect(unavailable.caps, invariant.id).toContainEqual(
        expect.objectContaining({
          kind: "reason:material-dependency-unavailable",
          limit: 69,
        }),
      );
      expect(unavailable.unresolvedFacts, invariant.id).toContainEqual(
        expect.objectContaining({
          code: "material-dependency-unavailable",
          responsibility: "integration-missing",
        }),
      );
      return;
    }
    case "evidence-facts": {
      const score = (variant: (typeof invariant.variants)[keyof typeof invariant.variants]) =>
        scoreSignals(variant.structuralSignals, {
          evidenceLevel: variant.evidenceLevel,
          unresolved: [...variant.unresolved],
        });
      const complete = score(invariant.variants.complete);
      const bounded = score(invariant.variants.boundedUnknown);
      const noncritical = score(invariant.variants.noncriticalMissing);
      const critical = score(invariant.variants.criticalMissing);
      expect(complete.finalScore!, invariant.id).toBeGreaterThanOrEqual(bounded.finalScore ?? 0);
      expect(bounded.finalScore!, invariant.id).toBeGreaterThanOrEqual(noncritical.finalScore ?? 0);
      expect(noncritical.finalGrade, invariant.id).not.toBe("NR");
      expect(critical.finalGrade, invariant.id).toBe("NR");
      expect(critical.nrReasons, invariant.id).toContainEqual(
        expect.objectContaining({ code: "insufficient-evidence" }),
      );
      return;
    }
    case "parent-graph": {
      const parent = compiledInput(invariant.parent.assetId, invariant.parent.pillarScore);
      const child = compiledInput(invariant.child.assetId, invariant.child.pillarScore, {
        assetId: invariant.parent.assetId,
        required: true,
        relationship: "wrapper",
      });
      const withParent = scoreCompiledAssetSet([child, parent], V9_CANDIDATE_POLICY_V1);
      const parentTrace = withParent.traces.find((trace) => trace.assetId === invariant.parent.assetId)!;
      const childTrace = withParent.traces.find((trace) => trace.assetId === invariant.child.assetId)!;
      expect(withParent.evaluatedOrder, invariant.id).toEqual([invariant.parent.assetId, invariant.child.assetId]);
      expect(childTrace.finalScore!, invariant.id).toBeLessThanOrEqual(parentTrace.finalScore ?? 0);
      expect(childTrace.bindingCap, invariant.id).toMatchObject({ source: "parent", limit: parentTrace.finalScore });

      const missingParent = scoreCompiledAssetSet([child], V9_CANDIDATE_POLICY_V1).traces[0]!;
      expect(missingParent.finalGrade, invariant.id).toBe("NR");
      expect(missingParent.nrReasons, invariant.id).toContainEqual(
        expect.objectContaining({ code: "missing-parent-score" }),
      );
      return;
    }
  }
}

describe("separate matched v9 invariant corpus", () => {
  it("keeps the transformation registry versioned, unique, and fully executable", () => {
    expect(MATCHED_V9_INVARIANTS).toHaveLength(8);
    expect(new Set(MATCHED_V9_INVARIANTS.map((entry) => entry.id)).size).toBe(8);
    for (const invariant of MATCHED_V9_INVARIANTS) executeInvariant(invariant);
  });

  it("validates reserve-loss fact percentages before deriving a signal", () => {
    expect(() =>
      deriveV9ReserveLossSignal(
        { exposurePct: 101, lossAbsorptionPct: 0, failureDomainKey: "reserve:test" },
        V9_CANDIDATE_POLICY_V1,
      ),
    ).toThrow("exposurePct must be a finite percentage between 0 and 100");
  });
});
