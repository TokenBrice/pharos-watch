import { describe, expect, it } from "vitest";
import { buildV9AggregationCounterfactual } from "../maintenance/replay-safety-score-v9-aggregation";

const DIGEST = "a".repeat(64);

function pillar(score: number) {
  return {
    score,
    evidenceLevel: "strong" as const,
    reasons: [],
    structuralSignals: [],
    adverseAttribution: [],
  };
}

function replay(score = 80): any {
  return {
    pipeline: {
      evaluatedSet: {
        policyId: "safety-score-v9",
        policyDigest: DIGEST,
        evaluationBuildDigest: DIGEST,
        factSetDigest: DIGEST,
        baseInputGenerationId: `report-cards-input:v1:${DIGEST}`,
        asOfSec: 1_700_000_000,
        assets: [
          {
            assetId: "counterfactual-asset",
            scoreInput: {
              assetId: "counterfactual-asset",
              identity: {
                factSetDigest: DIGEST,
                baseInputGenerationId: `report-cards-input:v1:${DIGEST}`,
                evaluationBuildDigest: DIGEST,
                asOfSec: 1_700_000_000,
                sourceGenerations: {},
              },
              pillars: {
                backing: pillar(score),
                exit: pillar(score),
                control: pillar(score),
              },
              peg: {
                applicable: false,
                score: null,
                activeDepegBps: null,
                reasons: [],
              },
              trackRecordMonths: 120,
              parent: {
                required: false,
                score: null,
                propagatedReasons: [],
                propagatedAdverseAttribution: [],
                propagatedBoundedUncertaintyAttribution: [],
                wrapperParentLimit: null,
              },
              dependencyReasons: [],
              dependencyStructuralSignals: [],
              methodologyReasons: [],
              unresolvedEvidence: [],
              operationalResilience: null,
            },
            trace: {
              finalScore: score,
              finalGrade: "B",
              pegMultiplier: 1,
              deploymentAdjustments: [],
              caps: [],
              adverseAttribution: [],
              boundedUncertaintyAttribution: [],
            },
          },
        ],
      },
    },
  };
}

function policyCandidate(input: ReturnType<typeof replay>) {
  return buildV9AggregationCounterfactual(input).results.find(
    (result) => result.candidateId === "smooth-bounded-headroom:policy",
  )!;
}

describe("Safety Score v9 aggregation counterfactual", () => {
  it("uses the canonical evaluator instead of replaying stale trace adjustments", () => {
    const input = replay();
    input.pipeline.evaluatedSet.assets[0]!.trace.deploymentAdjustments = [{
      signalKey: "stale:trace-only",
      exposureKey: "deployment:stale",
      riskEventKey: "chain-failure:stale",
      failureDomainKey: "chain:stale",
      nominalExposureShare: 0.5,
      exposureShare: 0.5,
      exposedScore: 60,
    }];

    expect(policyCandidate(input).assets[0]).toMatchObject({
      score: 80,
      grade: "A-",
      baseAssetScore: 80,
      deploymentAdjustedScore: 80,
    });
  });

  it("derives scoped deployment loss from the canonical score input", () => {
    const input = replay();
    input.pipeline.evaluatedSet.assets[0]!.scoreInput.dependencyStructuralSignals = [{
      kind: "material-bridge",
      severity: "high",
      reason: "A measured deployment depends on one bridge.",
      materialSharePct: 50,
      economicLossScope: "deployment",
      exposureKey: "deployment:test",
      riskEventKey: "bridge-failure:test",
      responsibility: "measured-adverse",
      failureDomainKeys: ["bridge:test"],
      evidence: [],
    }];

    expect(policyCandidate(input).assets[0]).toMatchObject({
      baseAssetScore: 80,
      deploymentAdjustedScore: 69.5,
      score: 70,
      grade: "B",
    });
  });

  it("derives caps and their tie-breaking from the canonical score input", () => {
    const input = replay();
    const asset = input.pipeline.evaluatedSet.assets[0]!;
    asset.scoreInput.parent.required = true;
    asset.scoreInput.parent.score = 60;

    expect(policyCandidate(input).assets[0]).toMatchObject({
      score: 60,
      grade: "C+",
      bindingCap: expect.objectContaining({
        source: "parent",
        kind: "parent",
        limit: 60,
      }),
    });
  });

  it("uses canonical grade and NR-attribution eligibility", () => {
    const input = replay(45);
    expect(policyCandidate(input).assets[0]).toMatchObject({ score: null, grade: "NR" });

    for (const pillarInput of Object.values(
      input.pipeline.evaluatedSet.assets[0]!.scoreInput.pillars,
    )) {
      pillarInput.score = 35;
    }
    expect(policyCandidate(input).assets[0]).toMatchObject({ score: null, grade: "NR" });
  });

  it("includes the exact policy and research aggregation strategies", () => {
    const ids = buildV9AggregationCounterfactual(replay()).results.map(
      (result) => result.candidateId,
    );
    expect(ids).toEqual(expect.arrayContaining([
      "smooth-bounded-headroom:policy",
      "smooth-bounded-headroom:legacy-control-selector",
      "generalized-mean:p-2",
      "generalized-mean:p-4",
    ]));
  });

  it("keeps the policy candidate monotonic across a weakest-pillar crossover", () => {
    const scoreAt = (control: number) => {
      const input = replay();
      input.pipeline.evaluatedSet.assets[0]!.scoreInput.pillars = {
        backing: pillar(100),
        exit: pillar(50),
        control: pillar(control),
      };
      return policyCandidate(input).assets[0]!.score!;
    };

    expect(scoreAt(50.1)).toBeGreaterThanOrEqual(scoreAt(49.9));
  });

  it("rejects an incomplete production score input", () => {
    const input = replay();
    delete (input.pipeline.evaluatedSet.assets[0]!.scoreInput as Partial<
      typeof input.pipeline.evaluatedSet.assets[0]["scoreInput"]
    >).identity;
    expect(() => buildV9AggregationCounterfactual(input)).toThrow();
  });
});
