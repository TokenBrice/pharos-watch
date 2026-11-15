import { expect, it } from "vitest";
import { isFxMarketClosed, isMetalMarketClosed } from "../reference-market-hours";

it.each([
  ["2026-11-13T20:59:59Z", false, false], ["2026-11-13T21:00:00Z", true, true], ["2026-11-15T22:59:59Z", true, true],
  ["2026-11-15T23:00:00Z", false, false], ["2026-04-02T20:59:59Z", false, false], ["2026-04-02T21:00:00Z", false, true],
  ["2026-04-03T12:00:00Z", false, true], ["2026-12-24T22:00:00Z", true, true], ["2026-01-01T23:00:00Z", true, true],
  ["2026-01-02T00:00:00Z", false, false],
])("at %s FX closed %s, metals closed %s", (iso, fx, metal) => {
  const sec = Date.parse(iso) / 1000;
  expect([isFxMarketClosed(sec), isMetalMarketClosed(sec)]).toEqual([fx, metal]);
});
