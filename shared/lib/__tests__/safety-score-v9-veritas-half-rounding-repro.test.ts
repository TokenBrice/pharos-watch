import { describe, expect, it } from "vitest";
import type { V9ScoringInput } from "@shared/types/safety-score-v9";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

// VER-002 regression: the ordinary weighted mean is diagnostic after the
// continuous weakest-path selection; the published aggregate still uses the
// same decimal-safe nearest rounding.
describe("VERITAS finding VER-002: continuous aggregate rounds deterministically", () => {
  it("nearest-rounds the smooth aggregate independently of the weighted mean", () => {
    const input: V9ScoringInput = {
      assetId: "veritas-half-rounding",
      pillars: { backing: 42.91, exit: 70.96, control: 70 },
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

    const trace = scoreV9Input(input, V9_CANDIDATE_POLICY_V1);
    expect(trace.weightedQuality).toBe(59.5);
    expect(trace.aggregation?.score).toBe(56.5141);
    expect(trace.bindingCap).toBeNull();
    expect(trace.finalScore).toBe(57);
    expect(trace.finalGrade).toBe("C");
  });
});
