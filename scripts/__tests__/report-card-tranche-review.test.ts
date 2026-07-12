import { describe, expect, it } from "vitest";
import { parseReportCardTrancheReview } from "../lib/report-card-tranche-review";

function review() {
  return {
    schemaVersion: 1 as const,
    tranche: "p1a",
    generatedAt: "2026-07-12T22:50:00.000Z",
    sourceRevision: "3428f3b14",
    artifacts: {
      fixedInput: "fixed.json",
      baseline: "before.json",
      candidate: "after.json",
      diff: "diff.json",
    },
    methodologyDecision: {
      before: "8.13",
      after: "8.14",
      bumped: true,
      rationale: "Dependency resolver behavior changed.",
    },
    movements: [
      {
        id: "frax-frax",
        score: { before: 58, after: 59 },
        grade: { before: "C", after: "C" },
        disposition: "expected" as const,
        rule: "self-link-suppression",
        rationale: "Treasury-held FRAX is not an upstream dependency.",
      },
    ],
    checks: [{ command: "npm run typecheck", status: "passed" as const }],
    unresolved: [],
  };
}

describe("report-card tranche review contract", () => {
  it("parses a complete review", () => {
    expect(parseReportCardTrancheReview(review()).movements[0].disposition).toBe("expected");
  });

  it("rejects duplicate movement dispositions and non-finite scores", () => {
    const duplicate = review();
    duplicate.movements.push({ ...duplicate.movements[0] });
    expect(() => parseReportCardTrancheReview(duplicate)).toThrow("duplicate movement review");
    expect(() =>
      parseReportCardTrancheReview({
        ...review(),
        movements: [{ ...review().movements[0], score: { before: Number.NaN, after: 59 } }],
      }),
    ).toThrow("Malformed tranche review");
  });
});
