import { describe, it, expect } from "vitest";
import {
  getReportCardGradeRank,
  REPORT_CARD_GRADE_RANK,
  scoreToGrade,
  UNKNOWN_REPORT_CARD_GRADE_RANK,
} from "../report-card-core";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

describe("scoreToGrade", () => {
  it("keeps the grade conversion bound to policy thresholds", () => {
    for (const { grade, minScore } of V9_CANDIDATE_POLICY_V1.policy.semantic.formula.gradeThresholds) {
      expect(scoreToGrade(minScore)).toBe(grade);
      if (minScore > 0) expect(scoreToGrade(minScore - 0.1)).not.toBe(grade);
    }
    expect(scoreToGrade(null)).toBe("NR");
  });

  it("clamps scores to 0-100 range", () => {
    expect(scoreToGrade(-10)).toBe("F");
    expect(scoreToGrade(150)).toBe("A+");
  });

});

describe("getReportCardGradeRank", () => {
  it("orders unknown grades below NR when the unknown sentinel fallback is requested", () => {
    expect(UNKNOWN_REPORT_CARD_GRADE_RANK).toBeLessThan(REPORT_CARD_GRADE_RANK.NR);
    expect(getReportCardGradeRank("mystery", UNKNOWN_REPORT_CARD_GRADE_RANK)).toBe(
      UNKNOWN_REPORT_CARD_GRADE_RANK,
    );
  });

  it("preserves nullable semantics by default for absent or unknown grades", () => {
    expect(getReportCardGradeRank(undefined)).toBeNull();
    expect(getReportCardGradeRank("mystery")).toBeNull();
  });
});
