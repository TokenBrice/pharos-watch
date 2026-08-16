import { describe, expect, it } from "vitest";

import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { deriveCalibrationGradePolicy } from "../maintenance/analyze-safety-score-v9-calibration.mjs";

describe("Safety Score V9 calibration grade policy", () => {
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
});
