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
      filterAndSortV9Cards([
        cards[2],
        makeV9Card({ ...cards[0], pillars: { ...cards[0].pillars, exit: { ...cards[0].pillars.exit, score: 50 } } }),
        makeV9Card({ ...cards[1], pillars: { ...cards[1].pillars, exit: { ...cards[1].pillars.exit, score: 95 } } }),
      ], {
        gradeFilter: "all",
        pegFilter: "all",
        pegTypeMap: new Map(),
        sortKey: "exit",
        mcapMap: new Map(),
      }).map((card) => card.id),
    ).toEqual(["asset-b", "asset-a", "asset-c"]);
    expect(
      filterAndSortV9Cards(cards, {
        gradeFilter: "C",
        pegFilter: "all",
        pegTypeMap: new Map(),
        sortKey: "overall",
        mcapMap: new Map(),
      }).map((card) => card.id),
    ).toEqual(["asset-c"]);
  });

  it("filters USD, non-USD fiat, and commodity peg groups", () => {
    const pegTypeMap = new Map([
      ["asset-a", "peggedUSD"],
      ["asset-b", "peggedEUR"],
      ["asset-c", "peggedGOLD"],
    ]);

    const idsFor = (pegFilter: "usd" | "fiat-non-usd" | "commodities") =>
      filterAndSortV9Cards(cards, {
        gradeFilter: "all",
        pegFilter,
        pegTypeMap,
        sortKey: "overall",
        mcapMap: new Map(),
      }).map((card) => card.id);

    expect(idsFor("usd")).toEqual(["asset-a"]);
    expect(idsFor("fiat-non-usd")).toEqual(["asset-b"]);
    expect(idsFor("commodities")).toEqual(["asset-c"]);
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

  it("sorts null scores last and breaks equal rated and unrated ties by id", () => {
    const input = [
      makeV9Card({ id: "nr-z", score: null, grade: "NR" }),
      makeV9Card({ id: "rated-z", score: 80 }),
      makeV9Card({ id: "nr-a", score: null, grade: "NR" }),
      makeV9Card({ id: "rated-a", score: 80 }),
    ];
    expect(filterAndSortV9Cards(input, {
      gradeFilter: "all", pegFilter: "all", pegTypeMap: new Map(), sortKey: "overall", mcapMap: new Map(),
    }).map((card) => card.id)).toEqual(["rated-a", "rated-z", "nr-a", "nr-z"]);
  });

  it("sorts missing market caps below positive supply", () => {
    expect(filterAndSortV9Cards(cards, {
      gradeFilter: "all", pegFilter: "all", pegTypeMap: new Map(), sortKey: "mcap",
      mcapMap: new Map([["asset-b", 20], ["asset-c", 100]]),
    }).map((card) => card.id)).toEqual(["asset-c", "asset-b", "asset-a"]);
  });

  it("omits headline statistics for an entirely unrated universe", () => {
    expect(buildV9HeadlineStats([makeV9Card({ score: null, grade: "NR" })], new Map())).toEqual([]);
  });

  it("excludes unrated supply from the headline denominator", () => {
    const input = [...cards, makeV9Card({ id: "nr", score: null, grade: "NR" })];
    const stats = buildV9HeadlineStats(input, new Map([["asset-a", 30], ["asset-c", 70], ["nr", 900]]));
    expect(stats[0]).toMatchObject({ value: "77" });
    expect(stats[1]).toMatchObject({ value: "30%" });
  });

  it("reports zero percent rather than NaN for rated cards without supply", () => {
    expect(buildV9HeadlineStats(cards, new Map())[1]).toMatchObject({ value: "0%" });
  });

});
