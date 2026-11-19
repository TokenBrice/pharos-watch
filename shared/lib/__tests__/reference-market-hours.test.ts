import { expect, it } from "vitest";
import {
  getReferenceMarketClosureStart, getReferenceMarketReopen, getReferenceSessionState, isFxMarketClosed,
  isMetalMarketClosed, isReferenceDeviationHeld, isTargetFixingDay, replayReferenceMarketEventStart,
} from "../reference-market-hours";

const sec = (iso: string) => Date.parse(iso) / 1000;

it.each([
  ["2026-11-13T21:30:00Z", false, false], ["2026-11-13T22:00:00Z", true, true],
  ["2026-11-15T21:59:59Z", true, true], ["2026-11-15T22:00:00Z", false, true],
  ["2026-11-15T23:00:00Z", false, false], ["2026-06-07T22:30:00Z", false, false],
  ["2026-11-18T21:59:59Z", false, false], ["2026-11-18T22:30:00Z", false, true],
  ["2026-11-18T23:00:00Z", false, false], ["2027-03-12T21:30:00Z", false, false],
  ["2027-03-14T21:00:00Z", false, true], ["2027-03-14T22:00:00Z", false, false],
  ["2027-03-19T21:30:00Z", true, true], ["2027-03-21T21:30:00Z", false, true],
  ["2027-03-25T20:59:59Z", false, false], ["2027-03-25T21:00:00Z", false, true],
  ["2027-03-26T12:00:00Z", false, true], ["2027-03-27T12:00:00Z", true, true],
  ["2027-03-28T21:00:00Z", false, true], ["2027-03-28T22:00:00Z", false, false],
  ["2027-03-29T12:00:00Z", false, false], ["2026-12-24T21:59:59Z", false, true],
  ["2026-12-24T22:00:00Z", true, true], ["2026-01-01T22:59:59Z", true, true],
  ["2026-01-01T23:00:00Z", true, false], ["2026-01-02T04:59:59Z", true, false],
  ["2026-01-02T05:00:00Z", false, false], ["2027-12-23T21:59:59Z", false, false],
  ["2027-12-31T21:59:59Z", false, false],
] as const)("at %s FX closed %s, metals closed %s", (iso, fx, metal) => {
  expect([isFxMarketClosed(sec(iso)), isMetalMarketClosed(sec(iso))]).toEqual([fx, metal]);
});

it.each([
  ["2026-01-19T19:30:00Z", "2026-01-19T23:00:00Z"], ["2026-02-16T19:30:00Z", "2026-02-16T23:00:00Z"],
  ["2026-05-25T18:30:00Z", "2026-05-25T22:00:00Z"], ["2026-06-19T17:00:00Z", "2026-06-21T22:00:00Z"],
  ["2026-07-03T17:00:00Z", "2026-07-05T22:00:00Z"], ["2026-09-07T18:30:00Z", "2026-09-07T22:00:00Z"],
  ["2026-11-26T19:30:00Z", "2026-11-26T23:00:00Z"], ["2026-11-27T19:45:00Z", "2026-11-29T23:00:00Z"],
  ["2026-12-24T18:45:00Z", "2026-12-27T23:00:00Z"], ["2026-12-31T22:00:00Z", "2027-01-03T23:00:00Z"], ["2027-03-25T21:00:00Z", "2027-03-28T22:00:00Z"],
  ["2027-06-18T17:00:00Z", "2027-06-20T22:00:00Z"], ["2027-07-05T18:30:00Z", "2027-07-05T22:00:00Z"],
  ["2027-11-26T19:45:00Z", "2027-11-28T23:00:00Z"], ["2027-12-23T22:00:00Z", "2027-12-26T23:00:00Z"],
  ["2028-07-03T21:00:00Z", "2028-07-04T22:00:00Z"], ["2028-11-22T22:00:00Z", "2028-11-26T23:00:00Z"],
  ["2029-07-03T21:00:00Z", "2029-07-04T22:00:00Z"],
])("metals closure [%s, %s) has exact edges", (close, open) => {
  const start = sec(close), end = sec(open);
  for (const now of [start, end - 1]) {
    expect(getReferenceSessionState("metal", now)).toEqual({
      open: false, closureStartSec: start, nextOpenSec: end, sessionOpenedAtSec: null,
    });
    expect(getReferenceMarketClosureStart("metal", now)).toBe(start);
    expect(getReferenceMarketReopen("metal", now)).toBe(end);
  }
  expect(isMetalMarketClosed(start - 1)).toBe(false);
  expect(getReferenceSessionState("metal", end)).toEqual({
    open: true, sessionOpenedAtSec: end, nextOpenSec: null, closureStartSec: null,
  });
});

it.each([
  ["2027-03-26T20:59:59Z", "2027-03-21T21:00:00Z"], ["2027-03-29T00:00:00Z", "2027-03-28T21:00:00Z"],
  ["2026-01-02T21:59:59Z", "2026-01-02T05:00:00Z"], ["2026-11-13T21:59:59Z", "2026-11-08T22:00:00Z"],
])("FX reading at %s belongs to the uninterrupted session opened at %s", (now, opened) => {
  expect(getReferenceSessionState("fx", sec(now))).toEqual({
    open: true, sessionOpenedAtSec: sec(opened), closureStartSec: null, nextOpenSec: null,
  });
});

it.each([
  ["2027-03-25", true], ["2027-03-26", false], ["2027-03-27", false], ["2027-03-28", false], ["2027-03-29", false],
  ["2027-03-30", true], ["2026-05-01", false], ["2028-12-25", false], ["2028-12-26", false], ["2027-01-01", false],
])("TARGET fixing date %s publishes %s", (date, publish) => {
  expect(isTargetFixingDay(sec(date + "T23:59:59Z"))).toBe(publish);
});

it.each([
  ["EUR", "2026-11-16T04:00:00Z", 300, null], ["GOLD", "2026-11-16T05:00:00Z", -300, null],
  ["EUR", "2026-11-16T04:00:01Z", 300, "2026-11-15T22:00:00Z"],
  ["EUR", null, 300, "2026-11-15T22:00:00Z"], ["EUR", null, -2500, "2026-11-14T12:00:00Z"],
  ["USD", null, 300, "2026-11-14T12:00:00Z"], ["SILVER", null, 2500, "2026-11-14T12:00:00Z"],
] as const)("replays a %s weekend event ending %s with peak %s", (peg, ended, peak, expected) => {
  const started = sec("2026-11-14T12:00:00Z");
  expect(replayReferenceMarketEventStart(peg, started, ended && sec(ended), peak)).toBe(expected && sec(expected));
  expect(isReferenceDeviationHeld(peg, started, peak)).toBe(expected !== "2026-11-14T12:00:00Z");
});

it("holds an unknown metal deviation through a break and ignores pegs without a reference market", () => {
  const now = sec("2026-11-18T22:30:00Z");
  expect(isReferenceDeviationHeld("GOLD", now, NaN)).toBe(true);
  expect([getReferenceMarketReopen(null, now), getReferenceMarketClosureStart(null, now)]).toEqual([null, null]);
});
