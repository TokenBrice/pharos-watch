import { describe, it, expect } from "vitest";
import { bandFromThresholds, clamp, clampScore, clampShare, round1, round4, roundScore, roundTo } from "../math";

describe("clamp", () => {
  it("returns value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("returns min when value is below range", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  it("returns max when value is above range", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
  it("returns min for NaN", () => {
    expect(clamp(NaN, 0, 100)).toBe(0);
  });
  it("returns max for Infinity", () => {
    expect(clamp(Infinity, 0, 100)).toBe(100);
  });
  it("returns min for -Infinity", () => {
    expect(clamp(-Infinity, 0, 100)).toBe(0);
  });
  it("handles min === max", () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });
});

describe("clampScore", () => {
  it("clamps to the report-card score range", () => {
    expect(clampScore(-1)).toBe(0);
    expect(clampScore(42)).toBe(42);
    expect(clampScore(101)).toBe(100);
  });
});

describe("clampShare", () => {
  it("clamps to the share range", () => {
    expect(clampShare(-1)).toBe(0);
    expect(clampShare(0.42)).toBe(0.42);
    expect(clampShare(2)).toBe(1);
  });

  it("hardens non-finite share input", () => {
    expect(clampShare(NaN)).toBe(0);
    expect(clampShare(Infinity)).toBe(1);
    expect(clampShare(-Infinity)).toBe(0);
  });
});

describe("round1", () => {
  it("rounds to one decimal", () => {
    expect(round1(72.456)).toBe(72.5);
    expect(round1(72.44)).toBe(72.4);
  });
});

describe("roundScore", () => {
  it("clamps and rounds into the score range", () => {
    expect(roundScore(72.5)).toBe(73);
    expect(roundScore(-4)).toBe(0);
    expect(roundScore(120)).toBe(100);
  });

  it("hardens non-finite score input through clampScore", () => {
    expect(roundScore(NaN)).toBe(0);
    expect(roundScore(Infinity)).toBe(100);
    expect(roundScore(-Infinity)).toBe(0);
  });
});

describe("roundTo", () => {
  it("rounds to the requested decimal places", () => {
    expect(roundTo(1.2345, 2)).toBe(1.23);
    expect(roundTo(1.235, 2)).toBe(1.24);
  });

  it("supports coarser negative places", () => {
    expect(roundTo(1234, -2)).toBe(1200);
  });
});

describe("round4", () => {
  it("rounds to four decimal places", () => {
    expect(round4(1.23456)).toBe(1.2346);
    expect(round4(1.23454)).toBe(1.2345);
  });
});

describe("bandFromThresholds", () => {
  const bands = [
    { min: 80, label: "high" },
    { min: 50, label: "medium" },
    { min: 0, label: "low" },
  ] as const;

  it("returns the first matching descending-min band", () => {
    expect(bandFromThresholds(75, bands, bands[2]).label).toBe("medium");
    expect(bandFromThresholds(80, bands, bands[2]).label).toBe("high");
  });

  it("returns the fallback when no band matches", () => {
    expect(bandFromThresholds(-1, bands, bands[2]).label).toBe("low");
    expect(bandFromThresholds(NaN, bands, bands[2]).label).toBe("low");
  });
});
