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
  });

  it.each([
    [1.010049, 1, 100.49, 100],
    [1.010051, 1, 100.51, 101],
    [0.989951, 1, -100.49, -100],
    [0.989949, 1, -100.51, -101],
    [2990, 3025, -115.702479338843, -116],
    [3060, 3025, 115.702479338843, 116],
  ])("rounds %s relative to %s without pinning floating noise", (value, reference, raw, rounded) => {
    const signal = relativeBps(value, reference)!;
    expect(signal.bps).toBe(rounded);
    expect(signal.absBps).toBe(Math.abs(rounded));
    // 1e-8 bps tolerance is far below the 0.01 bps rounding margin.
    expect(Math.abs(signal.rawBps - raw)).toBeLessThan(1e-8);
    expect(Math.abs(signal.absRawBps - Math.abs(raw))).toBeLessThan(1e-8);
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
