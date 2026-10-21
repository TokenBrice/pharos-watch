import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isQuietHoursActive,
  isValidIanaTimezone,
  resetQuietHoursFallbackTelemetryForTests,
} from "../../../../telegram/common/quiet-hours";

const hour = (hourUtc: number) => hourUtc * 3600;

afterEach(() => {
  resetQuietHoursFallbackTelemetryForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    expect(isQuietHoursActive(hour(9), true, 9, 17)).toBe(true);
    expect(isQuietHoursActive(hour(17), true, 9, 17)).toBe(false);
    expect(isQuietHoursActive(hour(8), true, 9, 17)).toBe(false);
  });

  it("handles quiet windows that wrap midnight", () => {
    expect(isQuietHoursActive(hour(23), true, 22, 6)).toBe(true);
    expect(isQuietHoursActive(hour(2), true, 22, 6)).toBe(true);
    expect(isQuietHoursActive(hour(6), true, 22, 6)).toBe(false);
    expect(isQuietHoursActive(hour(12), true, 22, 6)).toBe(false);
  });

  it("resolves the local hour in the provided IANA timezone", () => {
    // 2026-01-15 12:00:00 UTC. In Europe/Paris (UTC+1 in winter) the local
    // hour is 13; in America/Los_Angeles (UTC-8) it is 04.
    const noonUtcWinter = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
    expect(isQuietHoursActive(noonUtcWinter, true, 13, 14, "Europe/Paris")).toBe(true);
    expect(isQuietHoursActive(noonUtcWinter, true, 4, 5, "America/Los_Angeles")).toBe(true);
    // Same instant, UTC interpretation only matches 12.
    expect(isQuietHoursActive(noonUtcWinter, true, 13, 14, null)).toBe(false);
    expect(isQuietHoursActive(noonUtcWinter, true, 12, 13, null)).toBe(true);
  });

  it("follows the spring-forward offset and both occurrences of the fall-back hour", () => {
    const active = (iso: string, start: number, end: number) =>
      isQuietHoursActive(Date.parse(iso) / 1000, true, start, end, "America/New_York");
    expect(active("2026-03-08T06:59:59Z", 3, 4)).toBe(false);
    expect(active("2026-03-08T07:00:00Z", 3, 4)).toBe(true);
    expect(active("2026-11-01T05:00:00Z", 1, 2)).toBe(true);
    expect(active("2026-11-01T06:00:00Z", 1, 2)).toBe(true);
    expect(active("2026-11-01T07:00:00Z", 1, 2)).toBe(false);
  });

  it("falls back to UTC when the timezone is rejected by ICU", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // 2026-01-15 12:00:00 UTC. Bogus zone -> falls back to UTC, so hour=12.
    const noonUtcWinter = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
    expect(isQuietHoursActive(noonUtcWinter, true, 12, 13, "Mars/Olympus_Mons")).toBe(true);
    expect(isQuietHoursActive(noonUtcWinter, true, 13, 14, "Mars/Olympus_Mons")).toBe(false);
  });
});

describe("isValidIanaTimezone", () => {
  it("rejects empty, too-long, or unrecognized inputs", () => {
    expect(isValidIanaTimezone("")).toBe(false);
    expect(isValidIanaTimezone("not a zone")).toBe(false);
    expect(isValidIanaTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidIanaTimezone("a".repeat(65))).toBe(false);
  });
});
