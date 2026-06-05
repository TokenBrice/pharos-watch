import { describe, it, expect } from "vitest";
import { clamp, clampScore, round1 } from "../math";

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

describe("round1", () => {
  it("rounds to one decimal", () => {
    expect(round1(72.456)).toBe(72.5);
    expect(round1(72.44)).toBe(72.4);
  });
});
