import { describe, expect, it } from "vitest";
import { isQuietHoursActive } from "../telegram-quiet-hours";

const hour = (hourUtc: number) => hourUtc * 3600;

describe("isQuietHoursActive", () => {
  it("returns false when disabled or invalid", () => {
    expect(isQuietHoursActive(hour(12), false, 9, 17)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, null, 17)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, 9, null)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, -1, 17)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, 9, 24)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, 9, 9)).toBe(false);
  });

  it("handles same-day quiet windows", () => {
    expect(isQuietHoursActive(hour(10), true, 9, 17)).toBe(true);
    expect(isQuietHoursActive(hour(17), true, 9, 17)).toBe(false);
    expect(isQuietHoursActive(hour(8), true, 9, 17)).toBe(false);
  });

  it("handles quiet windows that wrap midnight", () => {
    expect(isQuietHoursActive(hour(23), true, 22, 6)).toBe(true);
    expect(isQuietHoursActive(hour(2), true, 22, 6)).toBe(true);
    expect(isQuietHoursActive(hour(6), true, 22, 6)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, 22, 6)).toBe(false);
  });
});
