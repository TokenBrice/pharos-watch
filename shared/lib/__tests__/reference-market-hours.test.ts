import { expect, it } from "vitest";
import { isFxMarketClosed, isMetalMarketClosed, replayReferenceMarketEventStart } from "../reference-market-hours";

it.each([
  ["2026-11-13T20:59:59Z", false, false], ["2026-11-13T21:00:00Z", true, true], ["2026-11-15T22:59:59Z", true, true],
  ["2026-11-15T23:00:00Z", false, false], ["2026-04-02T20:59:59Z", false, false], ["2026-04-02T21:00:00Z", false, true],
  ["2026-04-03T12:00:00Z", false, true], ["2026-12-24T22:00:00Z", true, true], ["2026-01-01T23:00:00Z", true, true],
  ["2026-01-02T00:00:00Z", false, false],
])("at %s FX closed %s, metals closed %s", (iso, fx, metal) => {
  const sec = Date.parse(iso) / 1000;
  expect([isFxMarketClosed(sec), isMetalMarketClosed(sec)]).toEqual([fx, metal]);
});

// Saturday 2026-11-14 12:00 UTC; FX and metals reopen Sunday 23:00 (1_794_783_600).
it.each([
  ["EUR", 1_794_785_400, 300, null], ["GOLD", 1_794_805_200, -300, null], ["EUR", 1_794_805_201, 300, 1_794_783_600],
  ["EUR", null, 300, 1_794_783_600], ["EUR", 1_794_785_400, -2_500, 1_794_657_600], ["USD", 1_794_785_400, 300, 1_794_657_600],
] as const)("replays the closure rule over a %s event ending %s with peak %s", (peg, endedAt, peakBps, expected) => {
  expect(replayReferenceMarketEventStart(peg, 1_794_657_600, endedAt, peakBps)).toBe(expected);
});
