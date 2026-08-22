import { describe, expect, it } from "vitest";
import { ReportCardGradeSchema } from "@shared/types/report-card-grade";
import { V9GradeSchema, type V9Grade } from "@shared/types/safety-score-v9";
import { REPORT_CARD_GRADE_RANK, scoreToGrade } from "../report-card-core";
import { getV9GradeRiskBucket, RISKY_GRADES, SAFE_GRADES, type V9GradeRiskBucket } from "../safety-grade-buckets";

const ALL_V9_GRADES: readonly V9Grade[] = V9GradeSchema.options;

const EXPECTED_BUCKETS: Record<V9Grade, V9GradeRiskBucket> = {
  "A+": "safe",
  A: "safe",
  "A-": "safe",
  "B+": "safe",
  B: "safe",
  "B-": "safe",
  "C+": "neutral",
  C: "neutral",
  "C-": "neutral",
  D: "risky",
  F: "risky",
  NR: "unavailable",
};

describe("safety grade buckets", () => {
  // The buckets are encoded twice: `SAFE_GRADES` / `RISKY_GRADES` as explicit
  // sets (what the worker's flight-to-quality classification reads) and
  // `getV9GradeRiskBucket` as rank thresholds (what the frontend reads). These
  // cases pin the two encodings to each other, and pin the enumeration used to
  // compare them against the grade vocabulary itself — otherwise a new grade
  // could land in one encoding and be missed by the other without failing.
  it("aliases the report-card schema and uses the clamped grade converter", () => {
    expect(V9GradeSchema).toBe(ReportCardGradeSchema);
    expect(scoreToGrade(-10)).toBe("F");
    expect(scoreToGrade(150)).toBe("A+");
    expect(scoreToGrade(null)).toBe("NR");
  });

  it("enumerates the whole published grade vocabulary", () => {
    expect([...ALL_V9_GRADES].sort()).toEqual(Object.keys(REPORT_CARD_GRADE_RANK).sort());
  });

  it("keeps the set encoding and the threshold encoding the same size", () => {
    expect(SAFE_GRADES.size).toBe(
      ALL_V9_GRADES.filter((grade) => getV9GradeRiskBucket(grade) === "safe").length,
    );
    expect(RISKY_GRADES.size).toBe(
      ALL_V9_GRADES.filter((grade) => getV9GradeRiskBucket(grade) === "risky").length,
    );
  });

  it("buckets every V9 grade per the reviewed safe/neutral/risky/unavailable boundaries", () => {
    for (const grade of ALL_V9_GRADES) {
      expect(getV9GradeRiskBucket(grade)).toBe(EXPECTED_BUCKETS[grade]);
    }
  });

  it("SAFE_GRADES matches exactly the grades getV9GradeRiskBucket buckets as safe", () => {
    for (const grade of ALL_V9_GRADES) {
      expect(SAFE_GRADES.has(grade)).toBe(getV9GradeRiskBucket(grade) === "safe");
    }
  });

  it("RISKY_GRADES matches exactly the grades getV9GradeRiskBucket buckets as risky", () => {
    for (const grade of ALL_V9_GRADES) {
      expect(RISKY_GRADES.has(grade)).toBe(getV9GradeRiskBucket(grade) === "risky");
    }
  });
});
