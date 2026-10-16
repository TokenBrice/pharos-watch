import { describe, expect, expectTypeOf, it } from "vitest";

import type { BluechipGrade } from "../core";
import { SAFETY_GRADE_VALUES, ReportCardGradeSchema } from "../report-card-grade";
import type { SafetyGrade } from "../report-card-grade";

describe("Pharos safety-grade vocabulary", () => {
  // Checked by tsconfig.test-typecheck.json, not by Vitest's runtime transpilation.
  expectTypeOf<BluechipGrade>().toEqualTypeOf<SafetyGrade>();
  expectTypeOf<SafetyGrade>().toEqualTypeOf<BluechipGrade>();

  it("publishes the grade ladder plus the explicit not-rated outcome", () => {
    expect(ReportCardGradeSchema.options).toEqual([...SAFETY_GRADE_VALUES, "NR"]);
    expect(ReportCardGradeSchema.parse("NR")).toBe("NR");
    expect(() => ReportCardGradeSchema.parse("E")).toThrow();
  });
});
