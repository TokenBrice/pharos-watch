import { describe, expect, it } from "vitest";

import {
  mean,
  median,
  pct,
  percentileLinear,
  percentileNearestRank,
  ratio,
  ratioToPercentage,
  relativeChangeRatio,
} from "../stats";

describe("mean", () => {
  it("averages finite samples", () => {
    expect(mean([1, 2, 3])).toBe(2);
  });

  it("ignores non-finite samples and returns null for empty finite input", () => {
    expect(mean([1, NaN, Infinity, 3])).toBe(2);
    expect(mean([])).toBeNull();
    expect(mean([NaN, Infinity])).toBeNull();
  });
});

describe("median", () => {
  it("returns the middle sorted finite sample for odd input", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle sorted finite samples for even input", () => {
    expect(median([10, 2, 8, 4])).toBe(6);
  });

  it("returns null for empty finite input", () => {
    expect(median([])).toBeNull();
    expect(median([NaN])).toBeNull();
  });
});

describe("percentileNearestRank", () => {
  it("uses nearest-rank semantics on a 0-100 scale", () => {
    expect(percentileNearestRank([1, 2, 3, 4], 50)).toBe(2);
    expect(percentileNearestRank([1, 2, 3, 4], 75)).toBe(3);
  });

  it("clamps percentile bounds and returns null for empty finite input", () => {
    expect(percentileNearestRank([3, 1, 2], -10)).toBe(1);
    expect(percentileNearestRank([3, 1, 2], 110)).toBe(3);
    expect(percentileNearestRank([], 50)).toBeNull();
    expect(percentileNearestRank([1], NaN)).toBeNull();
  });
});

describe("percentileLinear", () => {
  it("linearly interpolates on a 0-100 scale", () => {
    expect(percentileLinear([0, 10], 25)).toBe(2.5);
    expect(percentileLinear([1, 2, 3, 4], 50)).toBe(2.5);
  });

  it("clamps percentile bounds and returns null for empty finite input", () => {
    expect(percentileLinear([3, 1, 2], -10)).toBe(1);
    expect(percentileLinear([3, 1, 2], 110)).toBe(3);
    expect(percentileLinear([], 50)).toBeNull();
    expect(percentileLinear([1], Infinity)).toBeNull();
  });
});

describe("pct", () => {
  it("returns numerator over denominator as a percentage", () => {
    expect(pct(1, 4)).toBe(25);
  });

  it("returns null for non-finite input or zero denominator", () => {
    expect(pct(1, 0)).toBeNull();
    expect(pct(NaN, 1)).toBeNull();
    expect(pct(1, Infinity)).toBeNull();
  });
});

describe("unit-explicit ratios", () => {
  it("uses 1 as 100% and converts only at the boundary", () => {
    const value = ratio(1, 4);
    expect(value).toBe(0.25);
    expect(value == null ? null : ratioToPercentage(value)).toBe(25);
  });

  it("computes relative changes on the ratio scale", () => {
    expect(relativeChangeRatio(110, 100)).toBe(0.1);
    expect(relativeChangeRatio(90, 100)).toBe(-0.1);
    expect(relativeChangeRatio(300, 100)).toBe(2);
  });

  it("rejects invalid ratios consistently", () => {
    expect(ratio(1, 0)).toBeNull();
    expect(relativeChangeRatio(NaN, 1)).toBeNull();
    expect(relativeChangeRatio(1, Infinity)).toBeNull();
  });
});
