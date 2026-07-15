import { describe, expect, it } from "vitest";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

function score(pillars: { backing: number; exit: number; control: number }) {
  return scoreV9Input(
    {
      assetId: "veritas-ii-decimal-boundary",
      pillars,
      pegScore: 100,
      pegApplicable: true,
      evidenceLevel: "strong",
      trackRecordMonths: 48,
      activeDepegBps: null,
      parentRequired: false,
      parentScore: null,
      structuralSignals: [],
      unresolved: [],
    },
    V9_CANDIDATE_POLICY_V1,
  );
}

describe("VERITAS-II finding decimal snapping crosses genuine nearest and floor boundaries", () => {
  it("keeps a genuine below-half uncapped score below the nearest-integer boundary", () => {
    const belowHalf = 59.499_999_999_995;
    expect(belowHalf).toBeLessThan(59.5);
    expect(Math.round(belowHalf)).toBe(59);

    const trace = score({ backing: belowHalf, exit: belowHalf, control: belowHalf });

    expect(trace.finalScore).toBe(Math.round(belowHalf));
  });

  it("floors a genuine below-integer compensability cap without snapping it upward", () => {
    const weakest = 39.999_999_999_995;
    const trueCap = weakest + V9_CANDIDATE_POLICY_V1.policy.semantic.formula.compensabilityHeadroom;
    expect(trueCap).toBeLessThan(60);
    expect(Math.floor(trueCap)).toBe(59);

    const trace = score({ backing: weakest, exit: 100, control: 95 });

    expect(trace.bindingCap).toMatchObject({ kind: "bounded-compensability", limit: trueCap });
    expect(trace.finalScore).toBe(Math.floor(trueCap));
  });
});
