import { describe, it, expect } from "vitest";
import {
  getReportCardGradeRank,
  GRADE_THRESHOLDS,
  REPORT_CARD_GRADE_RANK,
  scoreToV9Grade,
  scoreToGrade,
  UNKNOWN_REPORT_CARD_GRADE_RANK,
  V9_GRADE_THRESHOLDS,
} from "../report-cards";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

describe("scoreToGrade", () => {
  it("derives presentation thresholds from the active scoring policy", () => {
    const expected = V9_CANDIDATE_POLICY_V1.policy.semantic.formula.gradeThresholds.map(({ grade, minScore }) => ({
      grade,
      min: minScore,
    }));
    expect(GRADE_THRESHOLDS).toEqual(expected);
    expect(V9_GRADE_THRESHOLDS).toEqual(expected);
  });

  it("keeps the V9 grade conversion bound to policy thresholds", () => {
    for (const { grade, minScore } of V9_CANDIDATE_POLICY_V1.policy.semantic.formula.gradeThresholds) {
      expect(scoreToV9Grade(minScore)).toBe(grade);
      if (minScore > 0) expect(scoreToV9Grade(minScore - 0.1)).not.toBe(grade);
    }
    expect(scoreToV9Grade(null)).toBe("NR");
  });

  it("returns NR for null", () => {
    expect(scoreToGrade(null)).toBe("NR");
  });

  it("returns A+ for scores >= 87", () => {
    expect(scoreToGrade(87)).toBe("A+");
    expect(scoreToGrade(100)).toBe("A+");
  });

  it("returns correct grade at each threshold boundary", () => {
    for (const { grade, min } of GRADE_THRESHOLDS) {
      expect(scoreToGrade(min)).toBe(grade);
      if (min > 0) expect(scoreToGrade(min - 0.1)).not.toBe(grade);
    }
  });

  it("clamps scores to 0-100 range", () => {
    expect(scoreToGrade(-10)).toBe("F");
    expect(scoreToGrade(150)).toBe("A+");
  });

  it("returns F for score 0", () => {
    expect(scoreToGrade(0)).toBe("F");
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
