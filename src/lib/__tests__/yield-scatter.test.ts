import { describe, expect, it } from "vitest";

import { computeApyAxis, computeSafetyDomain, nudgeOverlaps } from "@/lib/yield-scatter";

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

describe("nudgeOverlaps", () => {
  const xDomain: [number, number] = [35, 90];
  const yDomain: [number, number] = [0, 12];
  const w = 900;
  const h = 300;

  it("returns points unchanged when there are no overlaps", () => {
    const points = [
      { plotX: 40, plotY: 3 },
      { plotX: 70, plotY: 8 },
    ];
    const result = nudgeOverlaps(points, xDomain, yDomain, w, h, false);
    expect(result[0].plotX).toBe(40);
    expect(result[1].plotX).toBe(70);
  });

  it("separates two points at the same coordinates", () => {
    const points = [
      { plotX: 66, plotY: 5.22, id: "a" },
      { plotX: 66, plotY: 5.22, id: "b" },
    ];
    const result = nudgeOverlaps(points, xDomain, yDomain, w, h, false);
    const dx = Math.abs(result[0].plotX - result[1].plotX);
    const dy = Math.abs(result[0].plotY - result[1].plotY);
    // They should be pushed apart
    expect(dx).toBeGreaterThan(0.3);
    expect(dy).toBeGreaterThan(0.1);
  });

  it("separates a cluster of three overlapping points", () => {
    const points = [
      { plotX: 63, plotY: 3.7 },
      { plotX: 63, plotY: 3.56 },
      { plotX: 63, plotY: 3.22 },
    ];
    const result = nudgeOverlaps(points, xDomain, yDomain, w, h, false);
    // All three should end up at distinct positions
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const dist = Math.sqrt(
          ((result[i].plotX - result[j].plotX) / (55 / w)) ** 2 +
          ((result[i].plotY - result[j].plotY) / (12 / h)) ** 2,
        );
        expect(dist).toBeGreaterThan(5);
      }
    }
  });

  it("returns single-point arrays unchanged", () => {
    const points = [{ plotX: 50, plotY: 5 }];
    const result = nudgeOverlaps(points, xDomain, yDomain, w, h, false);
    expect(result).toEqual(points);
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
