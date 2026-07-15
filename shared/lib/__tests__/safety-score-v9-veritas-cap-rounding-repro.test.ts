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

// VER-001: final-score rounding can exceed a fractional compensability ceiling
// and raising a pillar can therefore lower the published score and grade.
describe.skip("VERITAS finding VER-001: fractional cap rounding crosses a grade boundary", () => {
  it("does not publish a rounded score above the compensability ceiling", () => {
    const trace = scoreV9Input(input(65.93), V9_CANDIDATE_POLICY_V1);
    const compensabilityCap = trace.caps.find((cap) => cap.kind === "bounded-compensability");

    expect(trace.preCapScore).toBe(64.7113);
    expect(compensabilityCap?.limit).toBe(64.714375);
    expect(trace.finalScore).toBe(64);
    expect(trace.finalGrade).toBe("C+");
  });

  it("does not lower the published result when exit quality increases", () => {
    const before = scoreV9Input(input(65.93), V9_CANDIDATE_POLICY_V1);
    const after = scoreV9Input(input(65.94), V9_CANDIDATE_POLICY_V1);

    expect(after.finalScore).toBeGreaterThanOrEqual(before.finalScore!);
    expect(after.finalGrade).toBe(before.finalGrade);
  });
});
