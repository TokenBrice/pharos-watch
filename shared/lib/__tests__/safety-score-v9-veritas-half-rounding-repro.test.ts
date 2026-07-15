import { describe, expect, it } from "vitest";
import type { V9ScoringInput } from "@shared/types/safety-score-v9";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

// VER-002: mathematically exact half scores can round down because the raw
// binary value is more than Number.EPSILON below the decimal half boundary.
describe.skip("VERITAS finding VER-002: exact decimal half rounds to the lower grade", () => {
  it("nearest-rounds an exact weighted score of 59.5 to 60", () => {
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
    expect(trace.bindingCap).toBeNull();
    expect(trace.finalScore).toBe(60);
    expect(trace.finalGrade).toBe("C+");
  });
});
