import { describe, expect, it } from "vitest";
import { buildV9AggregationCounterfactual } from "../maintenance/replay-safety-score-v9-aggregation";

const DIGEST = "a".repeat(64);

function replay() {
  return {
    pipeline: {
      evaluatedSet: {
        policyId: "safety-score-v9-candidate-v2",
        policyDigest: DIGEST,
        evaluationBuildDigest: DIGEST,
        factSetDigest: DIGEST,
        baseInputGenerationId: `report-cards-input:v1:${DIGEST}`,
        asOfSec: 1_700_000_000,
        assets: [
          {
            assetId: "deployment-scoped",
            scoreInput: {
              pillars: {
                backing: { score: 80 },
                exit: { score: 80 },
                control: { score: 80 },
              },
            },
            trace: {
              finalScore: 70,
              finalGrade: "B",
              pegMultiplier: 1,
              deploymentAdjustments: [
                {
                  signalKey: "chain:test",
                  exposureKey: "deployment:test",
                  riskEventKey: "chain-failure:test",
                  failureDomainKey: "chain:test",
                  nominalExposureShare: 0.5,
                  exposureShare: 0.5,
                  exposedScore: 60,
                },
              ],
              caps: [],
            },
          },
        ],
      },
    },
  };
}

describe("Safety Score v9 aggregation counterfactual", () => {
  it("replays scoped deployment adjustments before caps", () => {
    const output = buildV9AggregationCounterfactual(replay());
    const candidate = output.results.find(
      (result) => result.candidateId === "smooth-bounded-headroom:h30",
    );
    expect(candidate?.assets[0]).toMatchObject({
      assetId: "deployment-scoped",
      baseAssetScore: 80,
      deploymentAdjustedScore: 70,
      score: 70,
      grade: "B",
    });
  });

  it("includes the exact policy-selected headroom candidate", () => {
    const output = buildV9AggregationCounterfactual(replay());
    expect(output.results.map((result) => result.candidateId)).toContain(
      "smooth-bounded-headroom:policy",
    );
    expect(output.results.map((result) => result.candidateId)).toContain(
      "smooth-bounded-headroom:legacy-control-selector",
    );
  });

  it("keeps the policy candidate monotonic across a weakest-pillar crossover", () => {
    const scoreAt = (control: number) => {
      const input = replay();
      const asset = input.pipeline.evaluatedSet.assets[0]!;
      asset.scoreInput.pillars = {
        backing: { score: 100 },
        exit: { score: 50 },
        control: { score: control },
      };
      asset.trace.deploymentAdjustments = [];
      const output = buildV9AggregationCounterfactual(input);
      return output.results.find(
        (result) => result.candidateId === "smooth-bounded-headroom:policy",
      )!.assets[0]!.score!;
    };

    expect(scoreAt(50.1)).toBeGreaterThanOrEqual(scoreAt(49.9));
  });

  it("uses the production additive loss model for disjoint deployment events", () => {
    const input = replay();
    input.pipeline.evaluatedSet.assets[0]!.trace.deploymentAdjustments = [
      {
        signalKey: "chain:a",
        exposureKey: "deployment:a",
        riskEventKey: "chain-failure:a",
        failureDomainKey: "chain:a",
        nominalExposureShare: 0.2,
        exposureShare: 0.2,
        exposedScore: 40,
      },
      {
        signalKey: "chain:b",
        exposureKey: "deployment:b",
        riskEventKey: "chain-failure:b",
        failureDomainKey: "chain:b",
        nominalExposureShare: 0.5,
        exposureShare: 0.5,
        exposedScore: 70,
      },
    ];
    const output = buildV9AggregationCounterfactual(input);
    const candidate = output.results.find(
      (result) => result.candidateId === "smooth-bounded-headroom:policy",
    );
    expect(candidate?.assets[0]).toMatchObject({
      baseAssetScore: 80,
      deploymentAdjustedScore: 67,
      score: 67,
    });
  });

  it("does not manufacture a D or F without baseline measured-adverse attribution", () => {
    const input = replay();
    const asset = input.pipeline.evaluatedSet.assets[0]!;
    asset.scoreInput.pillars = {
      backing: { score: 35 },
      exit: { score: 35 },
      control: { score: 35 },
    };
    asset.trace.finalScore = 35;
    asset.trace.finalGrade = "F";
    asset.trace.deploymentAdjustments = [];
    const output = buildV9AggregationCounterfactual(input);
    const candidate = output.results.find(
      (result) => result.candidateId === "smooth-bounded-headroom:policy",
    );
    expect(candidate?.assets[0]).toMatchObject({ score: null, grade: "NR" });
  });

  it("keeps counterfactual deployment adjustment monotonic above one nominal exposure", () => {
    const scoreAt = (baseScore: number) => {
      const input = replay();
      const asset = input.pipeline.evaluatedSet.assets[0]!;
      asset.scoreInput.pillars = {
        backing: { score: baseScore },
        exit: { score: baseScore },
        control: { score: baseScore },
      };
      asset.trace.deploymentAdjustments = [
        {
          signalKey: "chain:a",
          exposureKey: "deployment:a",
          riskEventKey: "chain-failure:a",
          failureDomainKey: "chain:a",
          nominalExposureShare: 0.6,
          exposureShare: 0.6,
          exposedScore: 50,
        },
        {
          signalKey: "chain:b",
          exposureKey: "deployment:b",
          riskEventKey: "chain-failure:b",
          failureDomainKey: "chain:b",
          nominalExposureShare: 0.6,
          exposureShare: 0.6,
          exposedScore: 50,
        },
      ];
      return buildV9AggregationCounterfactual(input).results.find(
        (result) => result.candidateId === "smooth-bounded-headroom:policy",
      )!.assets[0]!.deploymentAdjustedScore!;
    };

    expect(scoreAt(60)).toBe(50);
    expect(scoreAt(70)).toBeGreaterThanOrEqual(scoreAt(60));
    expect(scoreAt(70)).toBe(50);
  });
});
