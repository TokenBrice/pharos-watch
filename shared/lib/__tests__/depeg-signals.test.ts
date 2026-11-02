import { describe, expect, it } from "vitest";
import {
  classifyDirectionalSignal,
  coerceDepegDirection,
  deriveDepegSignal,
  pickMoreSevereBps,
  relativeBps,
  signalCrossesThreshold,
  signalsShareDirection,
} from "../depeg-signals";

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

describe("deriveDepegSignal", () => {
  it("derives signed deviation and direction from price and peg", () => {
    expect(deriveDepegSignal(1.02, 1)).toMatchObject({
      bps: 200,
      absBps: 200,
      direction: "above",
    });

    expect(deriveDepegSignal(0.98, 1)).toMatchObject({
      bps: -200,
      absBps: 200,
      direction: "below",
    });
  });
});

describe("direction helpers", () => {
  it("shares direction across signals and string values", () => {
    const above = deriveDepegSignal(1.01, 1)!;
    const below = deriveDepegSignal(0.99, 1)!;

    expect(signalsShareDirection(above, "above")).toBe(true);
    expect(signalsShareDirection(above, below)).toBe(false);
  });

  it("coerces invalid directions from fallback bps", () => {
    expect(coerceDepegDirection("above", -200)).toBe("above");
    expect(coerceDepegDirection("weird", -200)).toBe("below");
    expect(coerceDepegDirection(undefined, 150)).toBe("above");
  });
});

describe("threshold helpers", () => {
  it("classifies directional confirmation vs contradiction vs recovery", () => {
    const below = deriveDepegSignal(0.98, 1)!;
    const above = deriveDepegSignal(1.02, 1)!;
    const recovered = deriveDepegSignal(0.999, 1)!;

    expect(classifyDirectionalSignal(below, 100, "below")).toBe("confirm");
    expect(classifyDirectionalSignal(above, 100, "below")).toBe("contradict");
    expect(classifyDirectionalSignal(recovered, 100, "below")).toBe("recover");
    expect(classifyDirectionalSignal(null, 100, "below")).toBe("insufficient");
  });

  it("checks crossing and recovery against the threshold", () => {
    const signal = deriveDepegSignal(0.98, 1)!;
    const recovered = deriveDepegSignal(0.9995, 1)!;

    expect(signalCrossesThreshold(signal, 100)).toBe(true);
    expect(signalCrossesThreshold(recovered, 100)).toBe(false);
  });

  it("uses unrounded deviation at the threshold boundary", () => {
    const roundedToThreshold = deriveDepegSignal(0.99005, 1)!;

    expect(roundedToThreshold.bps).toBe(-100);
    expect(roundedToThreshold.absRawBps).toBeCloseTo(99.5);
    expect(signalCrossesThreshold(roundedToThreshold, 100)).toBe(false);
  });
});

describe("pickMoreSevereBps", () => {
  it("keeps the most severe signed deviation", () => {
    expect(pickMoreSevereBps(-150, -300, -220)).toBe(-300);
    expect(pickMoreSevereBps(150, -400, 250)).toBe(-400);
    expect(pickMoreSevereBps(null, undefined)).toBeNull();
  });
});
