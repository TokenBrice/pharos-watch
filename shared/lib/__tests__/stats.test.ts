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
  weightedMedian,
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

describe("weightedMedian", () => {
  it("returns the first value whose cumulative weight reaches half the total", () => {
    expect(weightedMedian([
      { value: 10, weight: 1 },
      { value: 3, weight: 8 },
      { value: 5, weight: 1 },
    ])).toBe(3);
  });

  it("uses the lower value at an exact half-weight boundary", () => {
    expect(weightedMedian([
      { value: 20, weight: 1 },
      { value: 10, weight: 1 },
    ])).toBe(10);
  });

  it("ignores invalid points without mutating the caller's order", () => {
    const points = [
      { value: 4, weight: 1 },
      { value: NaN, weight: 10 },
      { value: 2, weight: 0 },
      { value: -1, weight: 2 },
    ];
    expect(weightedMedian(points)).toBe(-1);
    expect(points.map(({ value }) => value)).toEqual([4, NaN, 2, -1]);
    expect(weightedMedian([{ value: 1, weight: Infinity }])).toBeNull();
    expect(weightedMedian([
      { value: 1, weight: Number.MAX_VALUE },
      { value: 2, weight: Number.MAX_VALUE },
    ])).toBeNull();
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
