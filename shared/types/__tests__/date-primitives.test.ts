import { describe, expect, it } from "vitest";

import { isValidIsoDateOnly, parseIsoDateOrUtcInstantSec, reviewAdmissionSec } from "@shared/types/date-primitives";

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

describe("reviewAdmissionSec", () => {
  it("preserves the original pin while admitting dates next day and UTC instants exactly", () => {
    const midnight = Date.parse("2026-10-18T00:00:00Z") / 1_000;
    expect(parseIsoDateOrUtcInstantSec("2026-10-18")).toBe(midnight);
    expect(reviewAdmissionSec("2026-10-18")).toBe(midnight + 86_400);
    expect(reviewAdmissionSec("2026-10-18T12:30:01Z")).toBe(midnight + 45_001);
    expect(reviewAdmissionSec("2026-10-18T12:30:01.125Z")).toBe(midnight + 45_001.125);
    expect(Number.isNaN(reviewAdmissionSec("2026-02-30T12:30:01Z"))).toBe(true);
  });
});
