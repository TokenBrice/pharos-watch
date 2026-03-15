import { describe, it, expect } from "vitest";
import { mergeDepegSeconds, worstDeviation } from "../peg-utils";

const NOW = 1_700_000_000;
const DAY = 86400;

describe("mergeDepegSeconds", () => {
  it("returns 0 for no events", () => {
    expect(mergeDepegSeconds([], NOW - 30 * DAY, NOW)).toBe(0);
  });

  it("computes duration of a single resolved event", () => {
    const events = [{ startedAt: NOW - 10 * DAY, endedAt: NOW - 9 * DAY }];
    expect(mergeDepegSeconds(events as never, NOW - 30 * DAY, NOW)).toBe(DAY);
  });

  it("merges overlapping intervals", () => {
    const events = [
      { startedAt: NOW - 10 * DAY, endedAt: NOW - 8 * DAY },
      { startedAt: NOW - 9 * DAY, endedAt: NOW - 7 * DAY },
    ];
    // Merged: one interval spanning 3 days
    expect(mergeDepegSeconds(events as never, NOW - 30 * DAY, NOW)).toBe(3 * DAY);
  });

  it("clamps events to window boundaries", () => {
    const windowStart = NOW - 5 * DAY;
    const events = [{ startedAt: NOW - 10 * DAY, endedAt: NOW - 3 * DAY }];
    // Clamped: only 2 days within window
    expect(mergeDepegSeconds(events as never, windowStart, NOW)).toBe(2 * DAY);
  });

  it("treats active events (endedAt=null) as ending at now", () => {
    const events = [{ startedAt: NOW - 2 * DAY, endedAt: null }];
    expect(mergeDepegSeconds(events as never, NOW - 30 * DAY, NOW)).toBe(2 * DAY);
  });
});

describe("worstDeviation", () => {
  it("returns null for empty array", () => {
    expect(worstDeviation([])).toBeNull();
  });

  it("returns the largest absolute deviation", () => {
    const events = [
      { peakDeviationBps: -200 },
      { peakDeviationBps: 150 },
      { peakDeviationBps: -300 },
    ];
    expect(worstDeviation(events as never)).toBe(-300);
  });
});
