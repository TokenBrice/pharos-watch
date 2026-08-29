import { describe, it, expect } from "vitest";
import { mergeDepegSeconds, worstDeviation } from "../peg-utils";

describe("mergeDepegSeconds", () => {
  const cases = [
    {
      name: "returns 0 for no events",
      events: [],
      windowStart: 0,
      now: 1000,
      expected: 0,
    },
    {
      name: "computes duration of a single resolved event",
      events: [{ startedAt: 100, endedAt: 500 }],
      windowStart: 0,
      now: 1000,
      expected: 400,
    },
    {
      name: "sums non-overlapping intervals",
      events: [
        { startedAt: 100, endedAt: 200 },
        { startedAt: 400, endedAt: 500 },
      ],
      windowStart: 0,
      now: 1000,
      expected: 200,
    },
    {
      name: "merges overlapping intervals",
      events: [
        { startedAt: 100, endedAt: 400 },
        { startedAt: 300, endedAt: 600 },
      ],
      windowStart: 0,
      now: 1000,
      expected: 500,
    },
    {
      name: "merges adjacent intervals",
      events: [
        { startedAt: 100, endedAt: 300 },
        { startedAt: 300, endedAt: 500 },
      ],
      windowStart: 0,
      now: 1000,
      expected: 400,
    },
    {
      name: "handles fully nested intervals",
      events: [
        { startedAt: 100, endedAt: 600 },
        { startedAt: 200, endedAt: 400 },
      ],
      windowStart: 0,
      now: 1000,
      expected: 500,
    },
    {
      name: "merges multiple overlapping intervals out of order",
      events: [
        { startedAt: 500, endedAt: 700 },
        { startedAt: 100, endedAt: 300 },
        { startedAt: 250, endedAt: 550 },
      ],
      windowStart: 0,
      now: 1000,
      expected: 600,
    },
    {
      name: "clamps events to window boundaries",
      events: [{ startedAt: 50, endedAt: 300 }],
      windowStart: 100,
      now: 1000,
      expected: 200,
    },
    {
      name: "filters intervals that end before the window",
      events: [{ startedAt: 10, endedAt: 50 }],
      windowStart: 100,
      now: 1000,
      expected: 0,
    },
    {
      name: "treats active events as ending at now",
      events: [{ startedAt: 800, endedAt: null }],
      windowStart: 0,
      now: 1000,
      expected: 200,
    },
  ];

  it.each(cases)("$name", ({ events, windowStart, now, expected }) => {
    expect(mergeDepegSeconds(events as never, windowStart, now)).toBe(expected);
  });
});

describe("worstDeviation", () => {
  const cases = [
    { name: "returns null for empty array", events: [], expected: null },
    { name: "returns the signed value for a single event", events: [{ peakDeviationBps: -350 }], expected: -350 },
    {
      name: "returns the event with the largest absolute negative deviation",
      events: [{ peakDeviationBps: -200 }, { peakDeviationBps: -500 }, { peakDeviationBps: -100 }],
      expected: -500,
    },
    {
      name: "returns the event with the largest absolute positive deviation",
      events: [{ peakDeviationBps: 200 }, { peakDeviationBps: 600 }, { peakDeviationBps: -100 }],
      expected: 600,
    },
    {
      name: "compares absolute values across signs",
      events: [{ peakDeviationBps: 300 }, { peakDeviationBps: -400 }],
      expected: -400,
    },
    {
      name: "keeps the first signed value when absolute values tie",
      events: [{ peakDeviationBps: -100 }, { peakDeviationBps: 100 }],
      expected: -100,
    },
  ];

  it.each(cases)("$name", ({ events, expected }) => {
    expect(worstDeviation(events as never)).toBe(expected);
  });
});
