import { describe, it, expect } from "vitest";
import { clamp } from "../math";

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
