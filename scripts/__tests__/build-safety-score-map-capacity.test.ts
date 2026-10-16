import { describe, expect, it } from "vitest";
import census from "./fixtures/safety-score-map-census-2026-10-08.json";
import {
  bubblesOverlap,
  compositionOrbitsFor,
  fitLayout,
  GRAVEL_FLOORS,
  R_MIN_A,
  SafetyMapCapacityError,
  validateComposition,
} from "../maintenance/build-safety-score-map";

type MapCoin = Parameters<typeof fitLayout>[0][number];
const captured = census.coins as MapCoin[];

function assertCompleteLayout(coins: readonly MapCoin[]) {
  const layout = fitLayout(coins);
  const bubbles = layout.bands.flatMap((band) => band.bubbles);
  expect(bubbles.map((bubble) => bubble.coin.id).sort()).toEqual(coins.map((coin) => coin.id).sort());
  expect(new Set(bubbles.map((bubble) => bubble.coin.id)).size).toBe(coins.length);
  for (const bubble of bubbles) {
    expect(bubble.r).toBeGreaterThanOrEqual(bubble.coin.tier === "A" ? R_MIN_A : GRAVEL_FLOORS[0]);
  }
  for (let i = 0; i < bubbles.length; i++) {
    for (let j = i + 1; j < bubbles.length; j++) {
      expect(bubblesOverlap(bubbles[i], bubbles[j]), `${bubbles[i].coin.id} / ${bubbles[j].coin.id}`).toBe(false);
    }
  }
  expect(validateComposition({ orbits: compositionOrbitsFor(layout.bands), chips: [] })).toEqual([]);
  // Every populated grade carries exactly one label, at top centre.
  const labels = layout.bands.flatMap((band) => band.slots).filter((slot) => slot.kind === "grade-label");
  const populated = new Set(coins.map((coin) => coin.tier));
  expect(labels.map((slot) => slot.tier).sort()).toEqual([...populated].sort());
  for (const label of labels) expect(label.x + label.w / 2).toBeCloseTo(800, 0);
}

describe("Safety Map captured-census capacity", () => {
  it("places every graded entry from the public 2026-10-08 census at readable size", () => {
    expect(captured).toHaveLength(367);
    assertCompleteLayout(captured);
  });

  it("keeps the readable floor through 50% growth, then steps down rather than fail", () => {
    const grown = (fraction: number) => [...captured, ...["A", "B", "C", "D", "F"].flatMap((tier) => {
      const population = captured.filter((coin) => coin.tier === tier);
      return population.slice(-Math.ceil(population.length * fraction)).map((coin) => ({ ...coin, id: `growth-${coin.id}` }));
    })];
    expect(fitLayout(grown(0.5)).gravelFloor).toBe(GRAVEL_FLOORS[0]);
    const coins = grown(0.8);
    const layout = fitLayout(coins);
    expect(layout.gravelFloor).toBe(GRAVEL_FLOORS[1]);
    expect(layout.bands.flatMap((band) => band.bubbles)).toHaveLength(coins.length);
    expect(validateComposition({ orbits: compositionOrbitsFor(layout.bands), chips: [] })).toEqual([]);
  });

  it("fails loudly with a machine-readable reason when readable capacity is exhausted", () => {
    const coin = captured.find((entry) => entry.tier === "C")!;
    const exhausted = Array.from({ length: 3000 }, (_, index) => ({ ...coin, id: `overflow-${index}` }));
    let failure: unknown;
    try {
      fitLayout(exhausted);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SafetyMapCapacityError);
    expect(failure).toMatchObject({ code: "layout-capacity-exhausted" });
  });
});
