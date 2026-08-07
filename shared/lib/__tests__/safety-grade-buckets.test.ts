import { describe, expect, it } from "vitest";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { getV9GradeRiskBucket, RISKY_GRADES, SAFE_GRADES, type V9GradeRiskBucket } from "../safety-grade-buckets";

const ALL_V9_GRADES: readonly V9Grade[] = [
  "A+",
  "A",
  "A-",
  "B+",
  "B",
  "B-",
  "C+",
  "C",
  "C-",
  "D",
  "F",
  "NR",
];

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
