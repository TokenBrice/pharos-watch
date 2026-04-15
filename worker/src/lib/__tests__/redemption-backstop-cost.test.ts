import { describe, expect, it } from "vitest";
import { resolveBoundedFeeScore } from "../redemption-backstop-cost";

describe("resolveBoundedFeeScore", () => {
  it("scores 0 bps as 100", () => {
    expect(resolveBoundedFeeScore(0)).toBe(100);
  });

  it("scores exactly 10 bps as 100 (top of <=10 bucket)", () => {
    expect(resolveBoundedFeeScore(10)).toBe(100);
  });

  it("scores 11 bps as 80 (first step below 100)", () => {
    expect(resolveBoundedFeeScore(11)).toBe(80);
  });

  it("scores 25 bps as 80", () => {
    expect(resolveBoundedFeeScore(25)).toBe(80);
  });

  it("scores exactly 50 bps as 80 (top of <=50 bucket)", () => {
    expect(resolveBoundedFeeScore(50)).toBe(80);
  });

  it("scores 51 bps as 60 (first step below 80)", () => {
    expect(resolveBoundedFeeScore(51)).toBe(60);
  });

  it("scores 75 bps as 60", () => {
    expect(resolveBoundedFeeScore(75)).toBe(60);
  });

  it("scores exactly 100 bps as 60 (top of <=100 bucket)", () => {
    expect(resolveBoundedFeeScore(100)).toBe(60);
  });

  it("scores 101 bps as 40 (first step below 60)", () => {
    expect(resolveBoundedFeeScore(101)).toBe(40);
  });

  it("scores 200 bps as 40", () => {
    expect(resolveBoundedFeeScore(200)).toBe(40);
  });

  it("scores 500 bps as 40 (no floor below 40)", () => {
    expect(resolveBoundedFeeScore(500)).toBe(40);
  });
});
