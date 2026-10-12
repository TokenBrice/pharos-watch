import { describe, expect, it } from "vitest";

import { computeApyAxis, computeSafetyDomain, declutterScatterMarkers, resolveYieldZone } from "@/lib/yield-scatter";

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

  it("keeps the logo for the larger market and draws colliding points as dots", () => {
    const points = [
      { id: "small", plotX: 66, plotY: 5.22, tvl: 5 },
      { id: "large", plotX: 66, plotY: 5.22, tvl: 500 },
      { id: "unknown", plotX: 66.2, plotY: 5.25, tvl: null },
    ];
    const result = declutterScatterMarkers(points, xDomain, yDomain, w, h, false);
    const marker = (id: string) => result.find((r) => r.id === id)!.marker;
    expect(marker("large")).toBe("logo");
    expect(marker("small")).toBe("dot");
    expect(marker("unknown")).toBe("dot");
    // Dots paint first so logos sit on top.
    expect(result.at(-1)!.id).toBe("large");
  });

  it("keeps logos for points that do not collide", () => {
    const points = [
      { id: "a", plotX: 40, plotY: 3, tvl: 1 },
      { id: "b", plotX: 70, plotY: 8, tvl: 2 },
    ];
    expect(declutterScatterMarkers(points, xDomain, yDomain, w, h, false).every((p) => p.marker === "logo")).toBe(true);
  });

  it("is deterministic regardless of input order", () => {
    const points = [
      { id: "a", plotX: 60, plotY: 4, tvl: null },
      { id: "b", plotX: 60, plotY: 4, tvl: null },
    ];
    const forward = declutterScatterMarkers(points, xDomain, yDomain, w, h, false);
    const reversed = declutterScatterMarkers([...points].reverse(), xDomain, yDomain, w, h, false);
    expect(forward.find((p) => p.id === "a")!.marker).toBe("logo");
    expect(reversed.find((p) => p.id === "a")!.marker).toBe("logo");
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
