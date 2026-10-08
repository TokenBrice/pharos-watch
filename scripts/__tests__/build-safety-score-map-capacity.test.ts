import { describe, expect, it } from "vitest";
import census from "./fixtures/safety-score-map-census-2026-10-08.json";
import { bubblesOverlap, fitLayout, SafetyMapCapacityError, validateComposition } from "../maintenance/build-safety-score-map";

type MapCoin = Parameters<typeof fitLayout>[0][number];
const captured = census.coins as MapCoin[];

function assertCompleteLayout(coins: readonly MapCoin[]) {
  const layout = fitLayout(coins);
  const bubbles = layout.bands.flatMap((band) => band.bubbles);
  expect(bubbles.map((bubble) => bubble.coin.id).sort()).toEqual(coins.map((coin) => coin.id).sort());
  expect(new Set(bubbles.map((bubble) => bubble.coin.id)).size).toBe(coins.length);
  for (const bubble of bubbles) {
    expect(bubble.r).toBeGreaterThanOrEqual(bubble.coin.tier === "A" ? 10.9375 : 7.8125);
  }
  for (let i = 0; i < bubbles.length; i++) {
    for (let j = i + 1; j < bubbles.length; j++) {
      expect(bubblesOverlap(bubbles[i], bubbles[j]), `${bubbles[i].coin.id} / ${bubbles[j].coin.id}`).toBe(false);
    }
  }
  expect(validateComposition({
    orbits: layout.bands.map((band) => ({
      tier: band.tier,
      zone: band.zone,
      bubbles: band.bubbles.map((bubble) => ({ id: bubble.coin.id, cx: bubble.cx, cy: bubble.cy, r: bubble.r })),
    })),
    chips: [],
  })).toEqual([]);
}

describe("Safety Map captured-census capacity", () => {
  it("places every graded entry from the public 2026-10-08 census at readable size", () => {
    expect(captured).toHaveLength(367);
    assertCompleteLayout(captured);
  });

  it("retains every entry with at least 25% growth in each grade band", () => {
    const extra = ["A", "B", "C", "D", "F"].flatMap((tier) => {
      const population = captured.filter((coin) => coin.tier === tier);
      return population.slice(-Math.ceil(population.length / 4)).map((coin) => ({ ...coin, id: `growth-${coin.id}` }));
    });
    assertCompleteLayout([...captured, ...extra]);
  });

  it("fits a short-axis stress case with supply leaders in every outer grade", () => {
    const leaders = [...captured].sort((a, b) => b.mcap - a.mcap).slice(0, 8);
    const tiers = ["B", "B", "C", "C", "D", "D", "F", "F"] as const;
    const moved = captured.map((coin) => {
      const index = leaders.indexOf(coin);
      return index < 0 ? coin : { ...coin, tier: tiers[index], grade: tiers[index] };
    });
    assertCompleteLayout(moved);
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
