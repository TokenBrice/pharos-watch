import { expect, it } from "vitest";
import { isMetalMarketClosed } from "../metal-market-hours";

it.each([
  ["2026-11-13T20:59:59Z", false], ["2026-11-13T21:00:00Z", true], ["2026-11-15T22:59:59Z", true],
  ["2026-11-15T23:00:00Z", false], ["2026-04-02T20:59:59Z", false], ["2026-04-02T21:00:00Z", true],
  ["2026-12-24T22:00:00Z", true], ["2026-01-01T23:00:00Z", true], ["2026-01-02T00:00:00Z", false],
])("metal market closed at %s: %s", (iso, closed) => expect(isMetalMarketClosed(Date.parse(iso) / 1000)).toBe(closed));
