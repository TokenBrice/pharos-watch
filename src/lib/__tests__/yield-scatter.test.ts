import { describe, expect, it } from "vitest";

import { computeApyAxis, computeSafetyDomain } from "@/lib/yield-scatter";

describe("computeSafetyDomain", () => {
  it("falls back to the full safety range when no scores are available", () => {
    expect(computeSafetyDomain([], false)).toEqual([0, 100]);
  });

  it("focuses the chart on the occupied desktop score range", () => {
    expect(computeSafetyDomain([41, 52, 82], false)).toEqual([35, 85]);
  });

  it("keeps the safety threshold visible when all scores are high", () => {
    expect(computeSafetyDomain([71, 77, 84], false)).toEqual([55, 90]);
  });
});

describe("computeApyAxis", () => {
  it("clips rare extreme APY outliers so one point does not dominate the chart", () => {
    expect(computeApyAxis([0.4, 1.2, 2.5, 3.8, 4.4, 5.1, 5.7, 6.1, 6.8, 7.3, 8.5, 24.9], 3.7)).toEqual({
      domainMax: 11,
      clipThreshold: 11,
      clippedCount: 1,
    });
  });

  it("keeps a linear axis when the upper range is broadly occupied", () => {
    expect(computeApyAxis([1.1, 2.4, 3.2, 4.7, 5.9, 7.1, 8.4, 9.2, 10.3, 11.1, 12.4, 13.2], 3.7)).toEqual({
      domainMax: 15,
      clipThreshold: null,
      clippedCount: 0,
    });
  });
});
