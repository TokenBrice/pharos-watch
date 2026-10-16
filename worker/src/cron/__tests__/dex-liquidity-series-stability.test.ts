import { describe, expect, it } from "vitest";
import { computeSeriesStability } from "../dex-liquidity/scoring";

describe("computeSeriesStability", () => {
  it.each([
    { label: "returns null for fewer than 7 values", values: [1, 2, 3, 4, 5, 6] },
    { label: "returns null when fewer than 7 finite values remain after filtering", values: [100, NaN, NaN, NaN, NaN, NaN, NaN, NaN, 101] },
    { label: "returns null for all-zero values", values: [0, 0, 0, 0, 0, 0, 0] },
  ])("$label", ({ values }) => {
    expect(computeSeriesStability(values)).toBeNull();
  });

  it.each([
    { label: "returns a stability score for 7+ valid values", values: [100, 101, 99, 100, 102, 98, 100] },
    { label: "filters out NaN values before computing", values: [100, NaN, 101, 99, NaN, 100, 102, 98, 100] },
  ])("$label", ({ values }) => {
    const result = computeSeriesStability(values);
    expect(result).toBeTypeOf("number");
    expect(result!).toBeGreaterThan(0.9);
  });

  it("returns low stability for maximally volatile series", () => {
    const volatile = [1, 1000, 1, 1000, 1, 1000, 1];
    const result = computeSeriesStability(volatile);
    expect(result).toBeTypeOf("number");
    expect(result!).toBeLessThanOrEqual(0.01);
  });
});
