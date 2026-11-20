import { describe, it, expect } from "vitest";
import { activePegPeakBps, depegObservedIntervals, legacyPegEventStart, medianOfRounded, mergeDepegSeconds, worstDeviation, type PegScoreEvent } from "../peg-utils";
import { getReferenceMarket } from "../reference-market-hours";
import { computePegScore } from "../peg-score";
import { makePegEvent } from "../../test-utils/peg-fixtures";

it("admits a closed-session observation using its own fragment's peak", () => {
  const now = Date.parse("2026-11-14T13:00:00Z") / 1000;
  const event: PegScoreEvent = {
    ...makePegEvent({ pegType: "peggedAUD", startedAt: now - 600, peakDeviationBps: -2600, endedAt: null }),
    currentFragmentPeakBps: -437,
    priceCoverage: { intervals: [[now - 600, now]], lastTrustedObservationAt: now, gapStartedAt: null },
  };
  const market = getReferenceMarket("AUD");
  expect(activePegPeakBps(event, now, market)).toBeNull();
  expect(depegObservedIntervals(event, [[now - 600, now + 1]])).toEqual([]);
  expect(computePegScore([event], now - 864000, now)).toMatchObject({ scoredEventCount: 0, worstDeviationBps: null });
  expect(computePegScore([{ ...event, onsetFragmentPeakBps: -2600 }], now - 864000, now))
    .toMatchObject({ scoredEventCount: 1, worstDeviationBps: -2600, pegPct: 100 });
  expect(activePegPeakBps({ ...event, admittedCoverage: [{ fromSec: now - 600, toSec: now + 1 }] }, now, market))
    .toBe(-2600);
});

it("withholds legacy onset admission when the opening fragment peak is unavailable", () => {
  const event = makePegEvent({ pegType: "peggedAUD", startedAt: Date.parse("2026-11-13T13:00:00Z") / 1000,
    endedAt: null, peakDeviationBps: -960, onsetFragmentPeakBps: null });
  expect(legacyPegEventStart(event)).toBeNull();
  expect(computePegScore([event], event.startedAt - 86400, event.startedAt + 600).scoredEventCount).toBe(0);
});

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
      name: "does not invent the end of an uninstrumented active interval",
      events: [{ startedAt: 800, endedAt: null }],
      windowStart: 0,
      now: 1000,
      expected: 0,
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

describe("medianOfRounded", () => {
  it.each([
    { name: "empty cohort", values: [], expected: null },
    { name: "no finite observations", values: [NaN, Infinity, -Infinity], expected: null },
    { name: "observed parity", values: [0], expected: 0 },
    { name: "odd cohort", values: [30.8, 10.2, 20.6], expected: 21 },
    { name: "even cohort", values: [10, 21], expected: 16 },
  ])("preserves absence and rounds the median for $name", ({ values, expected }) => {
    expect(medianOfRounded(values)).toBe(expected);
  });
});
