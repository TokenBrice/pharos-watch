import { describe, it, expect } from "vitest";
import {
  getReportCardGradeRank,
  GRADE_THRESHOLDS,
  REPORT_CARD_GRADE_RANK,
  scoreToGrade,
  UNKNOWN_REPORT_CARD_GRADE_RANK,
} from "../report-cards";

describe("scoreToGrade", () => {
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
