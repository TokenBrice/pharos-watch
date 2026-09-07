import { describe, expect, it } from "vitest";

import { isValidIsoDateOnly } from "@shared/types/date-primitives";

describe("isValidIsoDateOnly", () => {
  it("accepts real UTC date-only strings and rejects malformed or impossible dates", () => {
    expect(isValidIsoDateOnly("2026-06-15")).toBe(true);
    expect(isValidIsoDateOnly("2026-6-15")).toBe(false);
    expect(isValidIsoDateOnly("2026-02-30")).toBe(false);
    expect(isValidIsoDateOnly("2024-02-29")).toBe(true);
    expect(isValidIsoDateOnly("2025-02-29")).toBe(false);
    expect(isValidIsoDateOnly("0000-01-01")).toBe(false);
    expect(isValidIsoDateOnly(null)).toBe(false);
    expect(isValidIsoDateOnly(undefined)).toBe(false);
  });
});
