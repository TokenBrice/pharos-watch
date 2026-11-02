import { describe, expect, it } from "vitest";
import { DEPEG_OPTIONS } from "@/lib/selector-options";

describe("DEPEG_OPTIONS", () => {
  it("keeps the owner-approved labels and states the one admitted band", () => {
    expect(DEPEG_OPTIONS.map((option) => option.label)).toEqual([
      "Zero tolerance",
      "Within 1%",
      "Moderate",
    ]);
  });
});
