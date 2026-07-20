import { describe, expect, it } from "vitest";
import {
  classifyDirectionalSignal,
  coerceDepegDirection,
  deriveDepegSignal,
  pickMoreSevereBps,
  signalCrossesThreshold,
  signalsShareDirection,
} from "../depeg-signals";

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

  it("returns null for unusable inputs", () => {
    expect(deriveDepegSignal(0, 1)).toBeNull();
    expect(deriveDepegSignal(1, 0)).toBeNull();
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
