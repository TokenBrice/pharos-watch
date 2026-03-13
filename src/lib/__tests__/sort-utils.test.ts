import { describe, it, expect } from "vitest";
import { compareNullable } from "../sort-utils";

describe("compareNullable", () => {
  it("returns 0 when both null", () => {
    expect(compareNullable(null, null)).toBe(0);
  });
  it("sorts null after non-null (returns 1 when a is null)", () => {
    expect(compareNullable(null, 5)).toBe(1);
  });
  it("sorts non-null before null (returns -1 when b is null)", () => {
    expect(compareNullable(5, null)).toBe(-1);
  });
  it("returns null when both are non-null (caller should compare)", () => {
    expect(compareNullable(5, 10)).toBeNull();
  });
});
