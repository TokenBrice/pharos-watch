import { describe, it, expect } from "vitest";
import type { HealthBand } from "@shared/types/chains";
import {
  hullWidth,
  cargoCapacityForHull,
  depthLayers,
  wakeLength,
  aggregateSkyBand,
} from "./nautical-scene-math";

describe("hullWidth", () => {
  it("returns minimum width when supply is zero", () => {
    expect(hullWidth(0, 1_000_000, 400)).toBe(28);
  });
  it("returns full inner width for the largest chain", () => {
    expect(hullWidth(1_000_000, 1_000_000, 400)).toBeCloseTo(400 - 40);
  });
  it("is monotonic non-decreasing across a supply range", () => {
    const widths = [1, 10, 100, 1000, 10_000, 100_000, 1_000_000]
      .map((s) => hullWidth(s, 1_000_000, 400));
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]!);
    }
  });
});

describe("cargoCapacityForHull", () => {
  it("keeps small hulls readable with three cargo markers", () => {
    expect(cargoCapacityForHull(28)).toBe(3);
    expect(cargoCapacityForHull(50)).toBe(3);
  });

  it("adds cargo markers as hull width allows", () => {
    expect(cargoCapacityForHull(72)).toBe(4);
    expect(cargoCapacityForHull(90)).toBe(5);
    expect(cargoCapacityForHull(140)).toBe(5);
  });
});

describe("depthLayers", () => {
  it("returns 1 for dominance below 5%", () => {
    expect(depthLayers(0.03)).toBe(1);
  });
  it("returns 2 for dominance between 5% and 15%", () => {
    expect(depthLayers(0.05)).toBe(2);
    expect(depthLayers(0.14)).toBe(2);
  });
  it("returns 3 for dominance at or above 15%", () => {
    expect(depthLayers(0.15)).toBe(3);
    expect(depthLayers(0.5)).toBe(3);
  });
});

describe("wakeLength", () => {
  it("returns 0 when change is null or undefined", () => {
    expect(wakeLength(null)).toBe(0);
    expect(wakeLength(undefined)).toBe(0);
  });
  it("returns 0 below 0.5% threshold", () => {
    expect(wakeLength(0.003)).toBe(0);
    expect(wakeLength(-0.004)).toBe(0);
  });
  it("scales up to 1 at 20% magnitude", () => {
    expect(wakeLength(0.2)).toBe(1);
    expect(wakeLength(-0.2)).toBe(-1);
    expect(wakeLength(0.5)).toBe(1);
  });
  it("preserves direction in sign", () => {
    expect(Math.sign(wakeLength(0.05))).toBe(1);
    expect(Math.sign(wakeLength(-0.05))).toBe(-1);
  });
});

describe("aggregateSkyBand", () => {
  it("returns 'sun' when no fragile or concentrated chains", () => {
    expect(aggregateSkyBand([
      { healthBand: "robust" },
      { healthBand: "healthy" },
      { healthBand: "mixed" },
    ])).toBe("sun");
  });
  it("returns 'fog' when fragile+concentrated ≥ 30%", () => {
    expect(aggregateSkyBand([
      { healthBand: "robust" },
      { healthBand: "healthy" },
      { healthBand: "fragile" },
      { healthBand: "concentrated" },
    ])).toBe("fog");
  });
  it("returns 'sun' when fragile ratio < 30%", () => {
    const bands: { healthBand: HealthBand | null }[] = Array(10).fill({ healthBand: "healthy" });
    bands[0] = { healthBand: "fragile" };
    expect(aggregateSkyBand(bands)).toBe("sun");
  });
  it("ignores null bands in the denominator", () => {
    expect(aggregateSkyBand([
      { healthBand: null },
      { healthBand: null },
      { healthBand: "fragile" },
    ])).toBe("fog");
  });
});
