import { describe, expect, it } from "vitest";
import { BLUECHIP_GRADE_VALUES, BluechipGradeSchema } from "../core";
import type { BluechipGrade } from "../core";
import { SAFETY_GRADE_VALUES, ReportCardGradeSchema } from "../report-card-grade";
import type { ReportCardGrade, SafetyGrade } from "../report-card-grade";

describe("Pharos safety-grade vocabulary", () => {
  it("owns its own grade ladder rather than deriving it from the vendor enum", () => {
    // The assertion runs in this direction on purpose: SAFETY_GRADE_VALUES is
    // the Pharos source of truth, and BLUECHIP_GRADE_VALUES is a third-party
    // vendor scale that happens to coincide with it. A vendor change must fail
    // here — visibly, in one place — instead of silently re-shaping every
    // Pharos grade type, schema, threshold table, and rank ladder.
    expect([...BLUECHIP_GRADE_VALUES]).toEqual([...SAFETY_GRADE_VALUES]);
    expect(BluechipGradeSchema.options).toEqual([...SAFETY_GRADE_VALUES]);
  });

  it("keeps the two scales mutually assignable while they coincide", () => {
    const vendorAsSafety: SafetyGrade = "A+" satisfies BluechipGrade;
    const safetyAsVendor: BluechipGrade = "F" satisfies SafetyGrade;
    expect([vendorAsSafety, safetyAsVendor]).toEqual(["A+", "F"]);
  });

  it("publishes the grade ladder plus the explicit not-rated outcome", () => {
    expect(ReportCardGradeSchema.options).toEqual([...SAFETY_GRADE_VALUES, "NR"]);
    expect(ReportCardGradeSchema.parse("NR")).toBe("NR");
    expect(() => ReportCardGradeSchema.parse("E")).toThrow();
    const notRated: ReportCardGrade = "NR";
    expect(notRated).toBe("NR");
  });
});
