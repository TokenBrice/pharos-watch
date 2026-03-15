import { describe, expect, it } from "vitest";
import { computeSeriesStability } from "../dex-liquidity/scoring";

describe("computeSeriesStability", () => {
  it("returns null for fewer than 7 values", () => {
    expect(computeSeriesStability([1, 2, 3, 4, 5, 6])).toBeNull();
  });

  it("returns a stability score for 7+ valid values", () => {
    const stable = [100, 101, 99, 100, 102, 98, 100];
    const result = computeSeriesStability(stable);
    expect(result).toBeTypeOf("number");
    expect(result!).toBeGreaterThan(0.9);
  });

  it("filters out NaN values before computing", () => {
    const withNaN = [100, NaN, 101, 99, NaN, 100, 102, 98, 100];
    const result = computeSeriesStability(withNaN);
    expect(result).toBeTypeOf("number");
    expect(result!).toBeGreaterThan(0.9);
  });

  it("filters out Infinity values before computing", () => {
    const withInf = [100, Infinity, 101, 99, -Infinity, 100, 102, 98, 100];
    const result = computeSeriesStability(withInf);
    expect(result).toBeTypeOf("number");
    expect(result!).toBeGreaterThan(0.9);
  });

  it("returns null when fewer than 7 finite values remain after filtering", () => {
    const mostlyNaN = [100, NaN, NaN, NaN, NaN, NaN, NaN, NaN, 101];
    expect(computeSeriesStability(mostlyNaN)).toBeNull();
  });

  it("returns null for all-zero values", () => {
    expect(computeSeriesStability([0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it("returns low stability for maximally volatile series", () => {
    const volatile = [1, 1000, 1, 1000, 1, 1000, 1];
    const result = computeSeriesStability(volatile);
    expect(result).toBeTypeOf("number");
    expect(result!).toBeLessThanOrEqual(0.01);
  });
});
