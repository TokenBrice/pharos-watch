import { describe, expect, it } from "vitest";
import type { V9ScoringInput } from "@shared/types/safety-score-v9";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

function input(exit: number): V9ScoringInput {
  return {
    assetId: "veritas-cap-rounding",
    pillars: { backing: 44.714375, exit, control: 95 },
    pegScore: 100,
    pegApplicable: true,
    evidenceLevel: "strong",
    trackRecordMonths: 48,
    activeDepegBps: null,
    parentRequired: false,
    parentScore: null,
    structuralSignals: [],
    unresolved: [],
  };
}

// VER-001 regression: replacing the fractional hard cap must retain monotonic
// published rounding without a hidden cap boundary.
describe("VERITAS finding VER-001: continuous aggregation remains monotonic across rounding", () => {
  it("publishes the continuously aggregated score without a compensability cap", () => {
    const trace = scoreV9Input(input(65.93), V9_CANDIDATE_POLICY_V1);

    expect(trace.weightedQuality).toBe(64.7113);
    expect(trace.preCapScore).toBe(59.9449);
    expect(trace.caps.map((cap) => cap.kind)).not.toContain("bounded-compensability");
    expect(trace.finalScore).toBe(60);
    expect(trace.finalGrade).toBe("C+");
  });

  it("does not lower the published result when exit quality increases", () => {
    const before = scoreV9Input(input(65.93), V9_CANDIDATE_POLICY_V1);
    const after = scoreV9Input(input(65.94), V9_CANDIDATE_POLICY_V1);

    expect(after.finalScore).toBeGreaterThanOrEqual(before.finalScore!);
    expect(after.finalGrade).toBe(before.finalGrade);
  });
});
