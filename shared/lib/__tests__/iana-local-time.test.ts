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
});
