import { describe, expect, it } from "vitest";

import {
  computeDemandOrbitZones,
  GRAVEL_FLOORS,
  parseMapPsi,
  placeSubgradeRadialLanes,
  R_MIN_A,
  radiusForMcap,
  selectMapPsi,
  subgradeLaneForGrade,
  supplyMassBarWidth,
} from "../maintenance/build-safety-score-map";

import { makeSafetyMapPsiPayload } from "./build-safety-score-map.test-support";

describe("Safety Map PSI footer", () => {
  const psiPayload = (current: Record<string, unknown> | null) => makeSafetyMapPsiPayload(current);

  it("accepts the live PSI display fields and rejects incomplete rolling values", () => {
    expect(parseMapPsi(psiPayload({
        score: 94.3,
        band: "BEDROCK",
        avg24h: 93.8,
        avg24hBand: "BEDROCK",
        computedAt: 1_777_000_000,
    }))).toEqual({
      score: 94.3,
      band: "BEDROCK",
      avg24h: 93.8,
      avg24hBand: "BEDROCK",
      computedAt: 1_777_000_000,
    });
    expect(() => parseMapPsi(psiPayload({
      score: 94.3,
      band: "BEDROCK",
      avg24h: 93.8,
      computedAt: 1_777_000_000,
    }))).toThrow(/avg24h and current\.avg24hBand must appear together/);
  });

  it("rejects canonical-envelope violations and a null current PSI", () => {
    expect(() => parseMapPsi({ current: null })).toThrow(/PSI response is malformed/);
    expect(() => parseMapPsi(psiPayload(null))).toThrow(/expected a current reading/);
  });

  it("labels the rolling display value and raw fallback explicitly", () => {
    expect(selectMapPsi({
      score: 94.3,
      band: "BEDROCK",
      avg24h: 93.8,
      avg24hBand: "BEDROCK",
      computedAt: 1_777_000_000,
    })).toEqual({ score: 93.8, band: "BEDROCK", basis: "24H AVG", computedAt: 1_777_000_000 });
    expect(selectMapPsi({ score: 72.1, band: "TREMOR", computedAt: 1_777_000_000 })).toEqual({
      score: 72.1,
      band: "TREMOR",
      basis: "RAW",
      computedAt: 1_777_000_000,
    });
  });
});

const FLOOR = GRAVEL_FLOORS[0];
// The zone allocator is exercised with a fixed synthetic mark size so these
// cases test its arithmetic, not today's publication floor.
const MARK = 7.8125;
const radii = (overrides: Partial<Record<"A" | "B" | "C" | "D" | "F", number[]>> = {}) => ({
  A: [],
  B: Array.from({ length: 41 }, () => MARK),
  C: Array.from({ length: 133 }, () => MARK),
  D: Array.from({ length: 75 }, () => MARK),
  F: Array.from({ length: 56 }, () => MARK),
  ...overrides,
});

describe("Safety Map chart key geometry", () => {
  it("uses the bubble radius function for both disclosed floors", () => {
    const k = 0.0002;
    const gravelFloor = FLOOR;
    const aFloorMcap = (R_MIN_A / k) ** 2;
    const otherFloorMcap = (gravelFloor / k) ** 2;
    expect(radiusForMcap("A", aFloorMcap, k, gravelFloor)).toBeCloseTo(R_MIN_A, 10);
    expect(radiusForMcap("F", otherFloorMcap, k, gravelFloor)).toBeCloseTo(gravelFloor, 10);
  });
});

describe("Safety Map supply mass and demand bands", () => {
  it("renders a 0.7% bar at exactly 0.7% of the track with no minimum", () => {
    expect(supplyMassBarWidth(7, 1000, 40)).toBeCloseTo(0.28, 12);
    expect(supplyMassBarWidth(0, 1000, 40)).toBe(0);
  });

  it("fails closed when required bubble thickness exceeds the bounded map", () => {
    const result = computeDemandOrbitZones(radii({ B: [60], C: [60], D: [60], F: [60] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/require .*px.*only .*px is available/);
  });
});

describe("Safety Map published sub-grade lanes", () => {
  const zone = { innerRx: 300, innerRy: 200, outerRx: 340, outerRy: 240 };
  const guideRx = 320;
  const guideRy = 220;
  const centers = [
    { x: 800 + guideRx, y: 450 },
    { x: 800 - guideRx / 2, y: 450 + guideRy * Math.sqrt(3) / 2 },
    { x: 800 - guideRx / 2, y: 450 - guideRy * Math.sqrt(3) / 2 },
  ];
  const guideValue = ({ x, y }: { x: number; y: number }) =>
    ((x - 800) ** 2) / guideRx ** 2 + ((y - 450) ** 2) / guideRy ** 2;

  it("derives plus/base/minus only from the published grade modifier", () => {
    expect([subgradeLaneForGrade("B+"), subgradeLaneForGrade("B"), subgradeLaneForGrade("B-")]).toEqual([
      "plus",
      "base",
      "minus",
    ]);
    expect(subgradeLaneForGrade("D")).toBe("base");
    expect(subgradeLaneForGrade("F")).toBe("base");
  });

  it("places plus inward, base on the guide, and minus outward", () => {
    const result = placeSubgradeRadialLanes(centers, [5, 5, 5], ["B+", "B", "B-"], zone);
    expect(result).not.toBeNull();
    expect(result?.offsetY).toBe(13.75);
    expect(guideValue(result!.centers[0])).toBeLessThan(1);
    expect(guideValue(result!.centers[1])).toBeCloseTo(1, 10);
    expect(guideValue(result!.centers[2])).toBeGreaterThan(1);
  });
});
