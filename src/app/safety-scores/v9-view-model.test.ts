import { describe, expect, it } from "vitest";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { NUMERIC_INPUT_STATES } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { projectV9TableCard } from "@shared/lib/report-cards-v9-projections";
import {
  buildSafetyMcapMap,
  buildV9GradeCounts,
  buildV9HeadlineStats,
  buildV9PillarAverages,
  buildV9SupplyMix,
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
  ].map(projectV9TableCard);

  it("groups and counts V9 grades using the existing grade sections", () => {
    expect(buildV9GradeCounts(cards)).toMatchObject({ A: 1, B: 1, C: 1 });
    expect(groupV9CardsByGrade(cards).map((group) => group.grade)).toEqual(["A", "B", "C"]);
  });

  it("builds the existing hero metrics from V9 scores and supply", () => {
    const stats = buildV9HeadlineStats(cards, new Map([
      ["asset-a", 60],
      ["asset-b", 30],
      ["asset-c", 10],
    ]));

    expect(stats[0]).toMatchObject({ label: "Ecosystem avg.", value: "77" });
    expect(stats[1]).toMatchObject({ label: "Supply in A/B", value: "90%" });
    expect(stats).toHaveLength(2);
  });

  it("weights the rated grade mix by observed supply, matching the A/B headline", () => {
    expect(buildV9SupplyMix(cards, new Map([["asset-a", 60], ["asset-b", 30], ["asset-c", 10]]))).toEqual({
      supplyByGrade: { A: 60, B: 30, C: 10, D: 0, F: 0 },
      totalSupply: 100,
      observedCount: 3,
      ratedCount: 3,
    });
  });

  it("excludes unobserved and unrated supply from the supply mix instead of counting zero", () => {
    const input = [...cards, projectV9TableCard(makeV9Card({ id: "nr", score: null, grade: "NR" }))];
    expect(buildV9SupplyMix(input, new Map([["asset-a", 30], ["asset-c", 70], ["nr", 900]]))).toEqual({
      supplyByGrade: { A: 30, B: 0, C: 70, D: 0, F: 0 },
      totalSupply: 100,
      observedCount: 2,
      ratedCount: 3,
    });
    expect(buildV9SupplyMix(cards, buildSafetyMcapMap())).toMatchObject({ totalSupply: 0, observedCount: 0, ratedCount: 3 });
    expect(buildV9SupplyMix([projectV9TableCard(makeV9Card({ score: null, grade: "NR" }))], new Map())).toBeNull();
  });

  it("averages all three pillars over rated cards and flags the weakest", () => {
    expect(buildV9PillarAverages(cards)).toEqual([
      { pillar: "backing", label: "Backing", average: 77, scoredCount: 3, isLowest: false },
      { pillar: "exit", label: "Exit", average: 68, scoredCount: 3, isLowest: true },
      { pillar: "control", label: "Economic Control", average: 76, scoredCount: 3, isLowest: false },
    ]);
    expect(buildV9PillarAverages([projectV9TableCard(makeV9Card({ score: null, grade: "NR" }))])).toEqual([]);
  });

  it("omits headline statistics for an entirely unrated universe", () => {
    expect(buildV9HeadlineStats([projectV9TableCard(makeV9Card({ score: null, grade: "NR" }))], new Map())).toEqual([]);
  });

  it("excludes unrated supply from the headline denominator", () => {
    const input = [...cards, projectV9TableCard(makeV9Card({ id: "nr", score: null, grade: "NR" }))];
    const stats = buildV9HeadlineStats(input, new Map([["asset-a", 30], ["asset-c", 70], ["nr", 900]]));
    expect(stats[0]).toMatchObject({ value: "77" });
    expect(stats[1]).toMatchObject({ value: "30%" });
  });

  it("keeps score headlines available when the independent supply query is absent", () => {
    const stats = buildV9HeadlineStats(cards, buildSafetyMcapMap());
    expect(stats[0].value).toBe("77");
    expect(stats[1]).toMatchObject({ value: "Unavailable", detail: "Supply unavailable" });
    expect(buildV9PillarAverages(cards).find((entry) => entry.isLowest)?.pillar).toBe("exit");
  });

  it.each(NUMERIC_INPUT_STATES)("keeps $state supply distinct in safety headlines", ({ state, value }) => {
    const map = buildSafetyMcapMap([{
      id: "asset-a", circulating: value === undefined ? undefined : { peggedUSD: value as number },
    }]);
    const expected = { absent: null, null: null, nan: null, infinite: null, negative: null, zero: 0, positive: 100 };
    expect(map.get("asset-a")).toBe(expected[state]);
    const stats = buildV9HeadlineStats([cards[0]], map);
    expect(stats[1].value).toBe(state === "positive" ? "100%" : "Unavailable");
    if (state === "zero") expect(stats[1].detail).toBe("$0.00");
  });

  it("distinguishes invalid and empty buckets from observed zero and sorts unavailable last", () => {
    const map = buildSafetyMcapMap([
      { id: "asset-a", circulating: {} },
      { id: "asset-b", circulating: { peggedUSD: 0 } },
      { id: "asset-c", circulating: { peggedUSD: Number.NaN } },
    ]);
    expect([...map.values()]).toEqual([null, 0, null]);
    expect(filterAndSortV9Cards(cards, {
      gradeFilter: "all", pegFilter: "all", pegTypeMap: new Map(), sortKey: "mcap", mcapMap: map,
    }).map((card) => card.id)).toEqual(["asset-b", "asset-a", "asset-c"]);
    expect(buildV9HeadlineStats(cards, map)[1]).toMatchObject({
      label: "Known supply in A/B", value: "Unavailable",
    });
    expect(buildV9HeadlineStats(cards, map)[1].detail).toContain("1/3 rated assets observed");
  });

  it("discloses partial rated supply instead of claiming a complete A/B share", () => {
    const stats = buildV9HeadlineStats(cards, buildSafetyMcapMap([
      { id: "asset-a", circulating: { peggedUSD: 100 } },
      { id: "asset-c", circulating: {} },
    ]));
    expect(stats[1]).toMatchObject({ label: "Known supply in A/B", value: "100%" });
    expect(stats[1].detail).toContain("1/3 rated assets observed");
  });

  it("renders measured-zero dollars with an unavailable zero-denominator percentage", () => {
    const map = buildSafetyMcapMap(cards.map((card) => ({ id: card.id, circulating: { peggedUSD: 0 } })));
    expect(buildV9HeadlineStats(cards, map)[1]).toMatchObject({
      label: "Supply in A/B", value: "Unavailable", detail: "$0.00",
    });
  });
  it("separates Pipeline gap from NR and keeps partial ratings ranked without filling missing pillars", () => {
    const gap = makeReportCardsV9PipelineGapCard("control", "A", { id: "gap" });
    const partial = makeReportCardsV9PartialCard("exit", "B", { id: "partial", score: 75 });
    const nr = makeV9Card({ id: "nr", score: null, grade: "NR", ratingStatus: "not-rated" });
    // The page now consumes the table projection, including its published mint seam.
    const input = [gap, nr, partial].map(projectV9TableCard);
    expect(buildV9GradeCounts(input)).toMatchObject({ B: 1, NR: 1, F: 0, "pipeline-gap": 1 });
    expect(groupV9CardsByGrade(input).map(group => group.grade)).toEqual(["B", "NR", "pipeline-gap"]);
    const options = { gradeFilter: "pipeline-gap" as const, pegFilter: "all" as const, pegTypeMap: new Map<string, string>(), sortKey: "overall" as const, mcapMap: new Map([["partial", 100], ["gap", 900]]) };
    expect(filterAndSortV9Cards(input, options).map(card => card.id)).toEqual(["gap"]);
    expect(filterAndSortV9Cards(input, { ...options, gradeFilter: "all", sortKey: "control" }).map(card => card.id)).toEqual(["partial", "gap", "nr"]);
    expect(buildV9HeadlineStats(input, options.mcapMap)[0]).toMatchObject({ value: "75" });
    expect(buildV9PillarAverages(input)).toEqual([
      { pillar: "backing", label: "Backing", average: 80, scoredCount: 1, isLowest: true },
      { pillar: "control", label: "Economic Control", average: 80, scoredCount: 1, isLowest: true },
    ]);
    expect(partial.pillars.exit.score).toBeNull();
    expect(gap.score).toBeNull();
  });

});
