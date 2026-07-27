import { describe, expect, it } from "vitest";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import {
  buildV9GradeCounts,
  buildV9HeadlineStats,
  filterAndSortV9Cards,
  groupV9CardsByGrade,
} from "./v9-view-model";

describe("Safety Scores V9 view model", () => {
  const cards = [
    makeV9Card({ id: "asset-a", grade: "A", score: 90 }),
    makeV9Card({ id: "asset-b", grade: "B+", score: 80 }),
    makeV9Card({
      id: "asset-c",
      grade: "C",
      score: 60,
      pillars: {
        backing: { ...makeV9Card().pillars.backing, score: 70 },
        exit: { ...makeV9Card().pillars.exit, score: 40 },
        control: { ...makeV9Card().pillars.control, score: 60 },
      },
    }),
  ];

  it("groups and counts V9 grades using the existing grade sections", () => {
    expect(buildV9GradeCounts(cards)).toMatchObject({ A: 1, B: 1, C: 1 });
    expect(groupV9CardsByGrade(cards).map((group) => group.grade)).toEqual(["A", "B", "C"]);
  });

  it("filters by grade and sorts by native V9 pillars", () => {
    expect(
      filterAndSortV9Cards(cards, {
        gradeFilter: "all",
        sortKey: "exit",
        mcapMap: new Map(),
      }).map((card) => card.id),
    ).toEqual(["asset-a", "asset-b", "asset-c"]);
    expect(
      filterAndSortV9Cards(cards, {
        gradeFilter: "C",
        sortKey: "overall",
        mcapMap: new Map(),
      }).map((card) => card.id),
    ).toEqual(["asset-c"]);
  });

  it("builds the existing hero metrics from V9 scores and pillars", () => {
    const stats = buildV9HeadlineStats(cards, new Map([
      ["asset-a", 60],
      ["asset-b", 30],
      ["asset-c", 10],
    ]));

    expect(stats[0]).toMatchObject({ label: "Ecosystem avg.", value: "77" });
    expect(stats[1]).toMatchObject({ label: "Supply in A/B", value: "90%" });
    expect(stats[2]).toMatchObject({ label: "Weakest pillar", value: "Exit" });
  });
});
