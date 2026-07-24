import { describe, expect, it } from "vitest";
import {
  boundedAttributionApplies,
  buildV9AggregationCounterfactual,
} from "../maintenance/replay-safety-score-v9-aggregation";

const DIGEST = "a".repeat(64);

function pillar(score: number) {
  return {
    score,
    reasons: [] as Array<{
      code: "bounded-mechanism-review";
      path: string;
      message: string;
      responsibility: "integration-missing";
    }>,
    structuralSignals: [],
    adverseAttribution: [],
  };
}

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
                backing: pillar(80),
                exit: pillar(80),
                control: pillar(80),
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
              adverseAttribution: [],
              boundedUncertaintyAttribution: [],
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
        backing: pillar(100),
        exit: pillar(50),
        control: pillar(control),
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

  it("does not manufacture a D without measured or bounded baseline attribution", () => {
    const input = replay();
    const asset = input.pipeline.evaluatedSet.assets[0]!;
    asset.scoreInput.pillars = {
      backing: pillar(45),
      exit: pillar(45),
      control: pillar(45),
    };
    asset.trace.finalScore = 45;
    asset.trace.finalGrade = "D";
    asset.trace.deploymentAdjustments = [];
    const output = buildV9AggregationCounterfactual(input);
    const candidate = output.results.find(
      (result) => result.candidateId === "smooth-bounded-headroom:policy",
    );
    expect(candidate?.assets[0]).toMatchObject({ score: null, grade: "NR" });
  });

  it("treats missing legacy bounded attribution as empty evidence", () => {
    const input = replay();
    const asset = input.pipeline.evaluatedSet.assets[0]!;
    asset.scoreInput.pillars = {
      backing: pillar(45),
      exit: pillar(45),
      control: pillar(45),
    };
    asset.trace.finalScore = 45;
    asset.trace.finalGrade = "D";
    asset.trace.deploymentAdjustments = [];
    delete (asset.trace as Partial<typeof asset.trace>).boundedUncertaintyAttribution;

    const candidate = buildV9AggregationCounterfactual(input).results.find(
      (result) => result.candidateId === "smooth-bounded-headroom:policy",
    );
    expect(candidate?.assets[0]).toMatchObject({ score: null, grade: "NR" });
  });

  it("retains a bounded-attributed D but never uses uncertainty to authorize F", () => {
    const input = replay();
    const asset = input.pipeline.evaluatedSet.assets[0]!;
    asset.scoreInput.pillars = {
      backing: {
        ...pillar(45),
        reasons: [{
          code: "bounded-mechanism-review",
          path: "backing:review",
          message: "Backing review is bounded.",
          responsibility: "integration-missing",
        }],
      },
      exit: pillar(45),
      control: pillar(45),
    };
    asset.trace.finalScore = 45;
    asset.trace.finalGrade = "D";
    asset.trace.deploymentAdjustments = [];
    Object.assign(asset.trace, {
      boundedUncertaintyAttribution: [{
        source: "reason",
        code: "bounded-mechanism-review",
        path: "backing:review",
        message: "Backing review is bounded.",
        responsibility: "integration-missing",
        boundedness: "exposure-bounded",
      }],
    });
    const output = buildV9AggregationCounterfactual(input);
    const candidate = output.results.find(
      (result) => result.candidateId === "smooth-bounded-headroom:policy",
    );
    expect(candidate?.assets[0]).toMatchObject({ score: 45, grade: "D" });

    asset.scoreInput.pillars = {
      backing: pillar(35),
      exit: pillar(35),
      control: pillar(35),
    };
    asset.trace.finalScore = 35;
    asset.trace.finalGrade = "F";
    const dangerOutput = buildV9AggregationCounterfactual(input);
    const dangerCandidate = dangerOutput.results.find(
      (result) => result.candidateId === "smooth-bounded-headroom:policy",
    );
    expect(dangerCandidate?.assets[0]).toMatchObject({ score: null, grade: "NR" });
  });

  it("rejects malformed attribution instead of using array presence as evidence", () => {
    const input = replay();
    Object.assign(input.pipeline.evaluatedSet.assets[0]!.trace, {
      boundedUncertaintyAttribution: [{ source: "reason" }],
    });
    expect(() => buildV9AggregationCounterfactual(input)).toThrow();
  });

  it("requires exact pillar or evidence-cap provenance for bounded attribution", () => {
    const item = {
      source: "reason" as const,
      code: "bounded-mechanism-review" as const,
      path: "backing:review",
      message: "Backing review is bounded.",
      responsibility: "integration-missing" as const,
      boundedness: "exposure-bounded" as const,
    };
    const pillars = {
      backing: pillar(45),
      exit: pillar(45),
      control: pillar(45),
    };

    expect(boundedAttributionApplies(item, pillars, null)).toBe(false);
    expect(boundedAttributionApplies(item, pillars, {
      source: "evidence",
      kind: "reason:bounded-mechanism-review",
      limit: 69,
      reason: "A different bounded gap.",
    })).toBe(false);
  });

  it("drops structural attribution when its counterfactual cap stops binding", () => {
    const input = replay();
    const asset = input.pipeline.evaluatedSet.assets[0]!;
    asset.scoreInput.pillars = {
      backing: pillar(20),
      exit: pillar(80),
      control: pillar(80),
    };
    Object.assign(asset.scoreInput.pillars.backing, {
      structuralSignals: [{
        kind: "centralized-mint",
        severity: "critical",
        reason: "A single controller can mint without an effective bound.",
        responsibility: "measured-adverse",
      }],
    });
    Object.assign(asset.trace, {
      finalScore: 39,
      finalGrade: "F",
      deploymentAdjustments: [],
      caps: [{
        source: "structural",
        kind: "signal:centralized-mint:critical",
        limit: 39,
        reason: "A single controller can mint without an effective bound.",
      }],
      adverseAttribution: [{
        source: "structural-signal",
        path: "structural:centralized-mint:critical",
        message: "A single controller can mint without an effective bound.",
        responsibility: "measured-adverse",
      }],
      boundedUncertaintyAttribution: [],
    });

    const output = buildV9AggregationCounterfactual(input);
    const stillCapped = output.results.find(
      (result) => result.candidateId === "smooth-bounded-headroom:h45",
    );
    const capNoLongerBinds = output.results.find(
      (result) => result.candidateId === "generalized-mean:p-2",
    );
    expect(stillCapped?.assets[0]).toMatchObject({
      score: 39,
      grade: "F",
      bindingCap: expect.objectContaining({ source: "structural" }),
    });
    expect(capNoLongerBinds?.assets[0]).toMatchObject({
      score: null,
      grade: "NR",
      bindingCap: null,
    });
  });

  it("drops parent attribution when the counterfactual parent cap no longer binds", () => {
    const input = replay();
    const asset = input.pipeline.evaluatedSet.assets[0]!;
    asset.scoreInput.pillars = {
      backing: pillar(40),
      exit: pillar(40),
      control: pillar(40),
    };
    Object.assign(asset.trace, {
      finalScore: 45,
      finalGrade: "D",
      deploymentAdjustments: [],
      caps: [{
        source: "parent",
        kind: "parent",
        limit: 45,
        reason: "Required parent score.",
      }],
      adverseAttribution: [{
        source: "parent-score",
        path: "parent:upstream:pillar:exit",
        message: "Required parent upstream: Measured exit weakness.",
        responsibility: "measured-adverse",
      }],
      boundedUncertaintyAttribution: [],
    });

    const candidate = buildV9AggregationCounterfactual(input).results.find(
      (result) => result.candidateId === "smooth-bounded-headroom:policy",
    );
    expect(candidate?.assets[0]).toMatchObject({
      score: null,
      grade: "NR",
      bindingCap: null,
    });
  });

  it("uses production cap-source priority for equal limits", () => {
    const input = replay();
    const asset = input.pipeline.evaluatedSet.assets[0]!;
    Object.assign(asset.trace, {
      deploymentAdjustments: [],
      caps: [
        {
          source: "evidence",
          kind: "reason:missing-reserve-composition",
          limit: 60,
          reason: "Reserve composition is unavailable.",
        },
        {
          source: "parent",
          kind: "parent",
          limit: 60,
          reason: "Required parent score.",
        },
      ],
    });

    const candidate = buildV9AggregationCounterfactual(input).results.find(
      (result) => result.candidateId === "smooth-bounded-headroom:policy",
    );
    expect(candidate?.assets[0]?.bindingCap).toEqual(
      expect.objectContaining({ source: "parent", limit: 60 }),
    );
  });

  it("does not manufacture F without baseline measured-adverse attribution", () => {
    const input = replay();
    const asset = input.pipeline.evaluatedSet.assets[0]!;
    asset.scoreInput.pillars = {
      backing: pillar(35),
      exit: pillar(35),
      control: pillar(35),
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
        backing: pillar(baseScore),
        exit: pillar(baseScore),
        control: pillar(baseScore),
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
