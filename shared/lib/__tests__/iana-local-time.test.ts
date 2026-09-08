import { describe, expect, it } from "vitest";
import {
  isValidIanaTimezone,
  localDateInIanaTimezone,
  nextIanaLocalHourDueAt,
} from "../iana-local-time";

describe("IANA local time helpers", () => {
  it("validates zones and derives a stable local date", () => {
    expect(isValidIanaTimezone("UTC")).toBe(true);
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(localDateInIanaTimezone(Date.UTC(2026, 0, 1, 1), "America/New_York")).toBe("2025-12-31");
  });

  it("calculates the next ordinary local-hour due instant", () => {
    const due = nextIanaLocalHourDueAt(Date.UTC(2026, 0, 1, 12), "America/New_York", 9);
    expect(due).toBe(Date.UTC(2026, 0, 1, 14));
    const following = nextIanaLocalHourDueAt(Date.UTC(2026, 0, 1, 15), "America/New_York", 9);
    expect(following).toBe(Date.UTC(2026, 0, 2, 14));
  });

  it("uses the first valid instant after a spring-forward gap", () => {
    const beforeGap = Date.UTC(2026, 2, 8, 5, 30); // 00:30 EST
    expect(nextIanaLocalHourDueAt(beforeGap, "America/New_York", 2)).toBe(Date.UTC(2026, 2, 8, 7));
  });

  it("selects the first occurrence of a fall-back hour", () => {
    const beforeFold = Date.UTC(2026, 10, 1, 3); // 23:00 EDT on the previous local date
    expect(nextIanaLocalHourDueAt(beforeFold, "America/New_York", 1)).toBe(Date.UTC(2026, 10, 1, 5));
  });

  it("schedules tomorrow at the exact delivery instant", () => {
    expect(nextIanaLocalHourDueAt(Date.UTC(2026, 0, 1, 14), "America/New_York", 9))
      .toBe(Date.UTC(2026, 0, 2, 14));
  });

  it("does not deliver again during the repeated fall-back hour", () => {
    expect(nextIanaLocalHourDueAt(Date.UTC(2026, 10, 1, 5, 30), "America/New_York", 1))
      .toBe(Date.UTC(2026, 10, 2, 6));
  });

  it("aligns delivery in a fractional-offset zone", () => {
    expect(nextIanaLocalHourDueAt(Date.UTC(2026, 0, 1, 0), "Asia/Kathmandu", 9))
      .toBe(Date.UTC(2026, 0, 1, 3, 15));
  });

  it("rejects invalid scheduling inputs", () => {
    for (const [now, zone, hour] of [
      [0, "Mars/Olympus_Mons", 9],
      [Infinity, "UTC", 9],
      [NaN, "UTC", 9],
      [0, "UTC", 9.5],
      [0, "UTC", 24],
      [0, "UTC", -1],
    ] as const) {
      expect(nextIanaLocalHourDueAt(now, zone, hour)).toBeNull();
    }
  });
});
