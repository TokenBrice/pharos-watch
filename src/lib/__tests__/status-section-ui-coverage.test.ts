import { describe, expect, it } from "vitest";
import { STATUS_SECTION_UI_COVERAGE } from "@/lib/status-section-ui-coverage";

describe("status section UI coverage", () => {
  it("assigns every status supplement to an operator workspace", () => {
    expect(Object.keys(STATUS_SECTION_UI_COVERAGE)).toHaveLength(19);
    expect(Object.values(STATUS_SECTION_UI_COVERAGE).every(({ workspace, view }) => workspace && view)).toBe(true);
  });
});
