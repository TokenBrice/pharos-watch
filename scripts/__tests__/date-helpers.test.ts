import { describe, expect, it } from "vitest";

import { isValidDateOnly } from "../lib/date-helpers.mts";

describe("script date helpers", () => {
  it("accepts real UTC date-only strings and rejects malformed or impossible dates", () => {
    expect(isValidDateOnly("2026-06-15")).toBe(true);
    expect(isValidDateOnly("2026-6-15")).toBe(false);
    expect(isValidDateOnly("2026-02-30")).toBe(false);
    expect(isValidDateOnly(null)).toBe(false);
  });
});
