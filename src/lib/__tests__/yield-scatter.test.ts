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
