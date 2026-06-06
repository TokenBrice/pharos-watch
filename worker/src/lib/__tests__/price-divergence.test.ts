import { describe, expect, it } from "vitest";
import { midDivergenceBps, pricesAgreeWithinBps } from "../price-divergence";

describe("price-divergence", () => {
  it("computes symmetric mid-price divergence in basis points", () => {
    expect(midDivergenceBps(1, 1.01)).toBeCloseTo(99.50248756, 8);
    expect(midDivergenceBps(1.01, 1)).toBeCloseTo(99.50248756, 8);
  });

  it("checks agreement against a bps threshold", () => {
    expect(pricesAgreeWithinBps(1, 1.004, 50)).toBe(true);
    expect(pricesAgreeWithinBps(1, 1.008, 50)).toBe(false);
  });

  it("fails closed when the midpoint is invalid", () => {
    expect(midDivergenceBps(1, -1)).toBe(Number.POSITIVE_INFINITY);
    expect(pricesAgreeWithinBps(1, -1, 10_000)).toBe(false);
    expect(pricesAgreeWithinBps(Number.POSITIVE_INFINITY, 1, 10_000)).toBe(false);
  });
});
