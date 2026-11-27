import { describe, expect, it } from "vitest";

import { SAFETY_GRADE_VALUES, ReportCardGradeSchema } from "../report-card-grade";

describe("Pharos safety-grade vocabulary", () => {
  it("publishes the grade ladder plus the explicit not-rated outcome", () => {
    expect(ReportCardGradeSchema.options).toEqual([...SAFETY_GRADE_VALUES, "NR"]);
    expect(ReportCardGradeSchema.parse("NR")).toBe("NR");
    expect(() => ReportCardGradeSchema.parse("E")).toThrow();
  });
});
