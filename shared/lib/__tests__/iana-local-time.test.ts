import { describe, expect, it, vi } from "vitest";
import {
  isValidIanaTimezone,
  localDateInIanaTimezone,
  nextIanaLocalHourDueAt,
} from "../iana-local-time";

const REFERENCE_FORMATTER_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};

const referenceFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock fields rendered onto a synthetic UTC timeline, so ordering is plain numeric. */
function referenceWallClockMs(atMs: number, timezone: string): number {
  let formatter = referenceFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { ...REFERENCE_FORMATTER_OPTIONS, timeZone: timezone });
    referenceFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(atMs));
  const fields: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of parts) fields[part.type] = Number(part.value);
  return Date.UTC(fields.year!, fields.month! - 1, fields.day!, fields.hour!, fields.minute!, fields.second!);
}

/** Exhaustive minute-scan reference for the documented "first instant at or after date hour:00" rule. */
function referenceNextDueAt(nowMs: number, timezone: string, hour: number): number | null {
  const crossing = (dateStartMs: number): number | null => {
    const target = dateStartMs + hour * 3_600_000;
    for (let atMs = target - 14 * 3_600_000; atMs <= target + 36 * 3_600_000; atMs += 60_000) {
      if (referenceWallClockMs(atMs, timezone) >= target) return atMs;
    }
    return null;
  };
  const nowWallMs = referenceWallClockMs(nowMs, timezone);
  const todayStartMs = Math.floor(nowWallMs / 86_400_000) * 86_400_000;
  const todayCrossing = crossing(todayStartMs);
  if (todayCrossing != null && todayCrossing > nowMs) return todayCrossing;
  return crossing(todayStartMs + 86_400_000);
}

const DUE_SCAN_ZONES = [
  "UTC",
  "America/New_York",
  "Europe/Dublin",
  "Australia/Lord_Howe",
  "Asia/Kathmandu",
  "Pacific/Chatham",
];
const DUE_SCAN_HOURS = [0, 1, 2, 3, 9, 23];
const DUE_SCAN_ANCHORS = [
  "2026-03-08T06:30:00Z", // before the New York spring-forward gap
  "2026-03-08T07:00:00Z", // inside that gap
  "2026-11-01T04:30:00Z", // before the New York fall-back fold
  "2026-11-01T05:30:00Z", // inside that repeated hour
  "2026-03-28T23:30:00Z", // before the European spring-forward gap
  "2026-10-25T00:30:00Z", // inside the European fall-back fold
  "2026-04-04T15:00:00Z", // Lord Howe 30-minute fall-back fold
  "2026-10-03T15:30:00Z", // Lord Howe 30-minute spring-forward gap
  "2026-04-04T13:45:00Z", // Chatham 45-minute fall-back fold
  "2026-09-26T14:00:00Z", // Chatham 45-minute spring-forward gap
  "2026-01-15T08:00:00Z",
  "2026-07-15T20:00:00Z",
  "1880-06-15T08:00:00Z", // Kathmandu local mean time, an offset that is not a whole 15-minute step
];

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

  it("computes zone-specific instants when timezones interleave and repeat", () => {
    const nowMs = Date.UTC(2026, 0, 1, 12);
    const zones = ["America/New_York", "Asia/Kathmandu", "UTC", "America/New_York"];
    expect(zones.map((zone) => nextIanaLocalHourDueAt(nowMs, zone, 9))).toEqual([
      Date.UTC(2026, 0, 1, 14),
      Date.UTC(2026, 0, 2, 3, 15),
      Date.UTC(2026, 0, 2, 9),
      Date.UTC(2026, 0, 1, 14),
    ]);
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

  it("matches the exhaustive minute scan through gaps, folds, and fractional offsets", () => {
    const cases = DUE_SCAN_ZONES.flatMap((zone) =>
      DUE_SCAN_HOURS.flatMap((hour) => DUE_SCAN_ANCHORS.map((anchor) => ({ zone, hour, anchor }))));
    const observed = cases.map(({ zone, hour, anchor }) => ({
      zone,
      hour,
      anchor,
      due: nextIanaLocalHourDueAt(Date.parse(anchor), zone, hour),
    }));
    const expected = cases.map(({ zone, hour, anchor }) => ({
      zone,
      hour,
      anchor,
      due: referenceNextDueAt(Date.parse(anchor), zone, hour),
    }));
    expect(observed).toEqual(expected);
  });
});

it("reuses a formatter for case variants of the same zone", () => {
  const construct = vi.spyOn(Intl, "DateTimeFormat");
  try {
    expect(isValidIanaTimezone("Pacific/Chatham")).toBe(true);
    const count = construct.mock.calls.length;
    expect(isValidIanaTimezone("pAcIfIc/ChAtHaM")).toBe(true);
    expect(construct.mock.calls.length).toBe(count);
  } finally {
    construct.mockRestore();
  }
});

it("evicts old formatter entries instead of retaining an unbounded cache", () => {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });
  const construct = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () { return formatter; });
  try {
    for (let index = 0; index < 257; index++) expect(isValidIanaTimezone(`Test/${index}`)).toBe(true);
    const count = construct.mock.calls.length;
    expect(isValidIanaTimezone("Test/256")).toBe(true);
    expect(construct.mock.calls.length).toBe(count);
    expect(isValidIanaTimezone("Test/0")).toBe(true);
    expect(construct.mock.calls.length).toBe(count + 1);
  } finally {
    construct.mockRestore();
  }
});
