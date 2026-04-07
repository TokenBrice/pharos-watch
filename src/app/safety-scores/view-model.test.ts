import { describe, expect, it } from "vitest";
import type { ReportCard } from "@shared/types";
import {
  buildSafetyGradeCounts,
  buildSafetyHeadlineStats,
  buildSafetyMcapMap,
  filterAndSortReportCards,
  groupReportCardsByGrade,
} from "./view-model";

function makeCard(overrides: Partial<ReportCard> = {}): ReportCard {
  return {
    id: overrides.id ?? "usdc-circle",
    name: overrides.name ?? "USD Coin",
    symbol: overrides.symbol ?? "USDC",
    overallScore: overrides.overallScore ?? 92,
    overallGrade: overrides.overallGrade ?? "A",
    isDefunct: overrides.isDefunct ?? false,
    dimensions: overrides.dimensions ?? {
      pegStability: { score: 95, grade: "A" },
      liquidity: { score: 90, grade: "A" },
      resilience: { score: 88, grade: "B+" },
      decentralization: { score: 70, grade: "B-" },
      dependencyRisk: { score: 62, grade: "C" },
    },
  } as ReportCard;
}

describe("safety score view-model", () => {
  it("builds market-cap lookups from pegged asset supply buckets", () => {
    const result = buildSafetyMcapMap([
      { id: "usdc-circle", circulating: { peggedUSD: 100, peggedEUR: 5 } },
      { id: "usdt-tether", circulating: null },
    ]);

    expect(result.get("usdc-circle")).toBe(105);
    expect(result.get("usdt-tether")).toBe(0);
  });

  it("filters defunct cards, applies grade filters, and keeps NR rows at the bottom", () => {
    const cards = [
      makeCard({ id: "usdc-circle", overallScore: 92, overallGrade: "A" }),
      makeCard({ id: "usdt-tether", symbol: "USDT", overallScore: 80, overallGrade: "B" }),
      makeCard({ id: "fdusd", symbol: "FDUSD", overallScore: null, overallGrade: "NR" }),
      makeCard({ id: "legacy", symbol: "LEG", overallScore: 95, overallGrade: "A", isDefunct: true }),
    ];

    const sorted = filterAndSortReportCards(cards, {
      gradeFilter: "all",
      sortKey: "overall",
      showDefunct: false,
      mcapMap: new Map(),
    });

    expect(sorted.map((card) => card.id)).toEqual(["usdc-circle", "usdt-tether", "fdusd"]);

    const filtered = filterAndSortReportCards(cards, {
      gradeFilter: "B",
      sortKey: "overall",
      showDefunct: true,
      mcapMap: new Map(),
    });

    expect(filtered.map((card) => card.id)).toEqual(["usdt-tether"]);
  });

  it("builds grade counts, grouped sections, and headline stats from visible cards", () => {
    const cards = [
      makeCard({ id: "usdc-circle", overallScore: 92, overallGrade: "A" }),
      makeCard({ id: "usdt-tether", symbol: "USDT", overallScore: 82, overallGrade: "B" }),
      makeCard({ id: "frax", symbol: "FRAX", overallScore: 55, overallGrade: "C" }),
    ];
    const mcapMap = new Map([
      ["usdc-circle", 60_000_000_000],
      ["usdt-tether", 80_000_000_000],
      ["frax", 1_000_000_000],
    ]);

    expect(buildSafetyGradeCounts(cards, false)).toEqual({
      A: 1,
      B: 1,
      C: 1,
      D: 0,
      F: 0,
      NR: 0,
    });
    expect(groupReportCardsByGrade(cards).map((group) => group.grade)).toEqual(["A", "B", "C"]);

    const stats = buildSafetyHeadlineStats(cards, mcapMap);
    expect(stats).toEqual([
      expect.objectContaining({ label: "Ecosystem avg.", value: "76" }),
      expect.objectContaining({ label: "Supply in A/B", value: "99%" }),
      expect.objectContaining({ label: "Weakest dimension", detail: expect.stringContaining("avg") }),
    ]);
  });
});
