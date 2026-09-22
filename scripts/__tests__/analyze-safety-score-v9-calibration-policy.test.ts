import { describe, expect, it } from "vitest";

import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import {
  distributionGates,
  deriveCalibrationGradePolicy,
  summarizeDistribution,
} from "../maintenance/analyze-safety-score-v9-calibration.mjs";

describe("Safety Score V9 calibration policy", () => {
  it("derives grade order, boundaries, and ranges from the supplied policy", () => {
    const formula = structuredClone(V9_CANDIDATE_POLICY_V1.policy.semantic.formula);
    const gradeA = formula.gradeThresholds.find((threshold) => threshold.grade === "A")!;
    const gradeAPlus = formula.gradeThresholds.find((threshold) => threshold.grade === "A+")!;
    gradeA.minScore = 82;
    gradeAPlus.minScore = 88;

    const derived = deriveCalibrationGradePolicy(formula);

    expect(derived.order).toEqual([
      ...formula.gradeThresholds.map((threshold) => threshold.grade),
      "NR",
    ]);
    expect(derived.boundaries).toContain(82);
    expect(derived.boundaries).toContain(88);
    expect(derived.boundaries).not.toContain(83);
    expect(derived.boundaries).not.toContain(87);
    expect(derived.ranges.A).toEqual({ minScore: 82, maxScore: 87 });
    expect(derived.ranges["A+"]).toEqual({ minScore: 88, maxScore: 100 });
  });

  it("fails D3b closed when unattributed F supply mixes known and unknown observations", () => {
    const cards = [
      { id: "material-known", grade: "B", score: 80 },
      { id: "unattributed-known", grade: "F", score: 10 },
      { id: "unattributed-unknown", grade: "F", score: 10 },
    ].map((card) => ({
      ...card,
      pillars: {
        backing: { score: V9_CANDIDATE_POLICY_V1.policy.semantic.backing.boundedUnknownQuality },
        exit: { score: V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore },
        control: { score: V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality },
      },
      pegMultiplier: 1,
      caps: [],
      bindingCap: null,
      reasonCodes: [],
    }));
    const replay = {
      pipeline: {
        candidate: { cards },
        evaluatedSet: { assets: [] },
        compiledFacts: {
          assets: [
            {
              assetId: "material-known",
              supply: { status: { observationState: "known" }, circulatingUsd: 1_000_000 },
            },
            {
              assetId: "unattributed-known",
              supply: { status: { observationState: "known" }, circulatingUsd: 100 },
            },
            {
              assetId: "unattributed-unknown",
              supply: { status: { observationState: "unknown" } },
            },
          ],
        },
      },
    };

    const metrics = summarizeDistribution(replay).distributionMetrics;

    expect(metrics.unattributedFCount).toBe(2);
    expect(metrics.unattributedFSupplyShare).toBeNull();
    expect(distributionGates(metrics).d3bUnattributedFSupplyShare).toBe(false);
  });
});
