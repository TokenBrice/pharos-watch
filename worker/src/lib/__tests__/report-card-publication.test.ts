import { describe, expect, it } from "vitest";
import { buildReportCardPublicationPlan } from "../report-card-publication";

function card(id: string, score: number | null, isDefunct = false) {
  return {
    id,
    overallScore: score,
    overallGrade: score == null ? "NR" : "A",
    isDefunct,
  } as never;
}

describe("buildReportCardPublicationPlan", () => {
  it("accounts for every expected ID as scored or not rated under one generation", () => {
    const result = buildReportCardPublicationPlan(
      [card("a", 90), card("b", null), card("archived", 10, true)],
      "7.31",
      1_700_000_000,
      new Set(["a", "b"]),
    );

    expect(result.activeCards.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(result.completeness).toEqual({
      generationId: "report-cards:7.31:1700000000",
      methodologyVersion: "7.31",
      expectedCount: 2,
      scoredCount: 1,
      notRatedCount: 1,
      notRatedIds: ["b"],
    });
  });

  it.each([
    { cards: [card("a", 90)], expected: new Set(["a", "b"]) },
    { cards: [card("a", 90), card("a", 80)], expected: new Set(["a"]) },
    { cards: [card("a", 90), card("unexpected", 80)], expected: new Set(["a"]) },
  ])("rejects missing, duplicate, and unexpected live IDs", ({ cards, expected }) => {
    expect(() => buildReportCardPublicationPlan(cards, "7.31", 1_700_000_000, expected))
      .toThrow("report-card-active-set-mismatch");
  });
});
