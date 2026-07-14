import { describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  scoreV9EvaluatedAsset,
  type V9PillarEvaluation,
  type V9ProductionScoreInput,
} from "../safety-score-v9/score";
import { computeV9ResultDigest, projectCompactV9ScoreTrace } from "../safety-score-v9/trace";

const DIGEST = "a".repeat(64);
const BUILD_DIGEST = "b".repeat(64);
const BASE_ID = `report-cards-input:v1:${"c".repeat(64)}`;

function pillar(score: number | null, overrides: Partial<V9PillarEvaluation> = {}): V9PillarEvaluation {
  return { score, evidenceLevel: "strong", reasons: [], structuralSignals: [], ...overrides };
}

function input(overrides: Partial<V9ProductionScoreInput> = {}): V9ProductionScoreInput {
  return {
    assetId: "asset",
    identity: {
      factSetDigest: DIGEST,
      baseInputGenerationId: BASE_ID,
      evaluationBuildDigest: BUILD_DIGEST,
      asOfSec: 1_000,
      sourceGenerations: { peg: "peg:1", dex: "dex:1" },
    },
    pillars: { backing: pillar(95), exit: pillar(95), control: pillar(95) },
    peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [] },
    trackRecordMonths: 48,
    parent: { required: false, score: null, propagatedReasons: [] },
    dependencyReasons: [],
    dependencyStructuralSignals: [],
    ...overrides,
  };
}

describe("scoreV9EvaluatedAsset", () => {
  it("binds the score to fact, policy, build, clock, and source identities", () => {
    const trace = scoreV9EvaluatedAsset(input(), V9_CANDIDATE_POLICY_V1);
    expect(trace).toMatchObject({
      finalScore: 95,
      finalGrade: "A+",
      factSetDigest: DIGEST,
      baseInputGenerationId: BASE_ID,
      evaluationBuildDigest: BUILD_DIGEST,
      asOfSec: 1_000,
      sourceGenerations: { dex: "dex:1", peg: "peg:1" },
    });
  });

  it("does not redistribute a missing pillar", () => {
    const trace = scoreV9EvaluatedAsset(
      input({ pillars: { backing: pillar(100), exit: pillar(null), control: pillar(100) } }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons.map((reason) => reason.code)).toContain("missing-pillar");
  });

  it("applies bounded-compensability to the weakest pillar", () => {
    const trace = scoreV9EvaluatedAsset(
      input({ pillars: { backing: pillar(30), exit: pillar(100), control: pillar(100) } }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(trace.finalScore).toBe(50);
    expect(trace.bindingCap?.kind).toBe("bounded-compensability");
  });

  it("resolves reason-coded critical facts and evidence ceilings through policy", () => {
    const critical = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(90, {
            reasons: [{ code: "missing-pillar-evidence", path: "reserve", message: "Missing review" }],
          }),
          exit: pillar(90),
          control: pillar(90),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(critical.finalGrade).toBe("NR");

    const bounded = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(90, {
            reasons: [{
              code: "material-unknown-reserve-exposure",
              path: "reserve:slice",
              message: "Bounded unknown",
            }],
          }),
          exit: pillar(90),
          control: pillar(90),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(bounded.finalScore).toBe(69);
    expect(bounded.bindingCap?.kind).toBe("reason:material-unknown-reserve-exposure");
  });

  it("creates stable compact traces and result digests across input order", () => {
    const left = scoreV9EvaluatedAsset(input({ assetId: "left" }), V9_CANDIDATE_POLICY_V1);
    const right = scoreV9EvaluatedAsset(input({ assetId: "right" }), V9_CANDIDATE_POLICY_V1);
    expect(projectCompactV9ScoreTrace(left)).toMatchObject({ assetId: "left", score: 95, grade: "A+" });
    expect(computeV9ResultDigest([left, right])).toBe(computeV9ResultDigest([right, left]));
  });
});
