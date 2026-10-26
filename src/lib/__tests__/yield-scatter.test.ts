import { describe, expect, it } from "vitest";

import { computeApyAxis, declutterScatterMarkers, resolveYieldZone } from "@/lib/yield-scatter";

describe("resolveYieldZone", () => {
  it("returns null only when no benchmark resolves at all or the row is unscored", () => {
    expect(resolveYieldZone(80, 5, null)).toBeNull();
    expect(resolveYieldZone(80, 5, undefined)).toBeNull();
    expect(resolveYieldZone(80, 5, Number.NaN)).toBeNull();
    expect(resolveYieldZone(null, 5, 4)).toBeNull();
  });

  it("maps safety and benchmark-relative yield onto the four zones", () => {
    expect(resolveYieldZone(80, 6, 4)).toBe("sweet-spot");
    expect(resolveYieldZone(80, 3, 4)).toBe("play-it-safe");
    expect(resolveYieldZone(40, 6, 4)).toBe("danger-zone");
    expect(resolveYieldZone(40, 3, 4)).toBe("why-bother");
    // Yield exactly at the benchmark is not "paid".
    expect(resolveYieldZone(80, 4, 4)).toBe("play-it-safe");
  });
});



describe("declutterScatterMarkers", () => {
  const xDomain: [number, number] = [35, 90];
  const yDomain: [number, number] = [0, 12];
  const w = 900;
  const h = 300;

  it("never moves a point", () => {
    const points = [
      { id: "a", plotX: 66, plotY: 5.22, tvl: 10 },
      { id: "b", plotX: 66, plotY: 5.22, tvl: 5 },
      { id: "c", plotX: 66.1, plotY: 5.3, tvl: null },
    ];
    const result = declutterScatterMarkers(points, xDomain, yDomain, w, h, false);
    for (const point of points) {
      const out = result.find((r) => r.id === point.id)!;
      expect(out.plotX).toBe(point.plotX);
      expect(out.plotY).toBe(point.plotY);
    }
  });

});

describe("computeApyAxis", () => {
  it("clips rare extreme APY outliers so one point does not dominate the chart", () => {
    expect(computeApyAxis([0.4, 1.2, 2.5, 3.8, 4.4, 5.1, 5.7, 6.1, 6.8, 7.3, 8.5, 24.9], 3.7)).toEqual({
      domainMin: 0,
      domainMax: 11,
      clipThreshold: 11,
      clippedCount: 1,
      floorThreshold: null,
      floorClippedCount: 0,
    });
  });

  it("keeps a linear axis when the upper range is broadly occupied", () => {
    expect(computeApyAxis([1.1, 2.4, 3.2, 4.7, 5.9, 7.1, 8.4, 9.2, 10.3, 11.1, 12.4, 13.2], 3.7)).toEqual({
      domainMin: 0,
      domainMax: 15,
      clipThreshold: null,
      clippedCount: 0,
      floorThreshold: null,
      floorClippedCount: 0,
    });
  });

  it("pins a rare extreme losing tail to a disclosed floor rail", () => {
    const apys = [-48.2, -0.4, 0.8, 1.6, 2.5, 3.1, 3.8, 4.4, 5.1, 5.7, 6.2, 6.8, 7.3, 8.1];
    const axis = computeApyAxis(apys, 4.2);
    expect(axis.floorThreshold).toBe(-3);
    expect(axis.floorClippedCount).toBe(1);
    expect(axis.domainMin).toBe(-3);
    for (const apy of apys.slice(1)) expect(apy).toBeGreaterThanOrEqual(axis.domainMin);
  });

  it("keeps a broadly occupied losing tail linear", () => {
    const axis = computeApyAxis([-9, -8.5, -7, -6, -4.2, 1, 2, 3, 4, 5, 6, 7], 4.2);
    expect(axis.floorThreshold).toBeNull();
    expect(axis.floorClippedCount).toBe(0);
    expect(axis.domainMin).toBe(-10);
  });

  it.each([
    { apys: [-5, -2, -0.1], min: -6 },
    { apys: [-1.9549203966, 0, 5], min: -3 },
    { apys: [-1_000, 2, 8], min: -1_080 },
    { apys: [], min: 0 },
  ])("keeps the complete lower tail on a continuous domain: $apys", ({ apys, min }) => {
    const axis = computeApyAxis(apys, 3.7);
    expect(axis.domainMin).toBe(min);
    expect(axis.domainMax).toBeGreaterThanOrEqual(8);
    expect(axis.clippedCount).toBe(0);
    expect(axis.floorClippedCount).toBe(0);
    for (const apy of apys) {
      expect(apy).toBeGreaterThanOrEqual(axis.domainMin);
      expect(apy).toBeLessThanOrEqual(axis.domainMax);
    }
  });
});
