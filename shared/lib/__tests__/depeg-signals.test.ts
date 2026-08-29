import { describe, expect, it } from "vitest";
import { relativeBps } from "../depeg-signals";

describe("relativeBps", () => {
  it("preserves signed raw and rounded forms on both sides of rounding boundaries", () => {
    expect(relativeBps(8.25, 8)).toEqual({
      rawBps: 312.5,
      bps: 313,
      absRawBps: 312.5,
      absBps: 313,
    });
    expect(relativeBps(7.75, 8)).toEqual({
      rawBps: -312.5,
      bps: -312,
      absRawBps: 312.5,
      absBps: 312,
    });
    expect(relativeBps(1.010049, 1)).toEqual({
      rawBps: 100.48999999999975,
      bps: 100,
      absRawBps: 100.48999999999975,
      absBps: 100,
    });
    expect(relativeBps(1.010051, 1)).toEqual({
      rawBps: 100.51000000000032,
      bps: 101,
      absRawBps: 100.51000000000032,
      absBps: 101,
    });
    expect(relativeBps(0.989951, 1)).toEqual({
      rawBps: -100.48999999999975,
      bps: -100,
      absRawBps: 100.48999999999975,
      absBps: 100,
    });
    expect(relativeBps(0.989949, 1)).toEqual({
      rawBps: -100.51000000000032,
      bps: -101,
      absRawBps: 100.51000000000032,
      absBps: 101,
    });
  });

  it("uses the supplied non-USD reference", () => {
    expect(relativeBps(2990, 3025)).toEqual({
      rawBps: -115.7024793388428,
      bps: -116,
      absRawBps: 115.7024793388428,
      absBps: 116,
    });
    expect(relativeBps(3060, 3025)).toEqual({
      rawBps: 115.70247933884392,
      bps: 116,
      absRawBps: 115.70247933884392,
      absBps: 116,
    });
  });

  it.each([
    [0, 1],
    [-1, 1],
    [1, 0],
    [1, -1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
    [Number.NEGATIVE_INFINITY, 1],
    [1, Number.NaN],
    [1, Number.POSITIVE_INFINITY],
    [1, Number.NEGATIVE_INFINITY],
  ])("returns null for unusable value/reference pair (%s, %s)", (value, reference) => {
    expect(relativeBps(value, reference)).toBeNull();
  });
});
