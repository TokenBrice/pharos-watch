import { describe, expect, it } from "vitest";
import { GOLDEN_SCENARIOS, PAIRWISE_CONSTRAINTS } from "@shared/data/safety-score-v9/golden-scenarios-v1";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { scoreV9GoldenScenario } from "../safety-score-v9/scenario-evaluator";

describe("Safety Score v9 durable golden corpus", () => {
  const missingPillarScenarios = GOLDEN_SCENARIOS.filter((scenario) =>
    Object.values(scenario.pillars).some((score) => score === null),
  );
  it.each(missingPillarScenarios)("bounds $id uncertainty without a single-gap NR decision", (scenario) => {
    const trace = scoreV9GoldenScenario(scenario, V9_CANDIDATE_POLICY_V1);
    expect(trace.ratingStatus).toBe("rated");
    expect(trace.finalScore).not.toBeNull();
    expect(trace.finalScore!).toBeLessThanOrEqual(55);
    expect(trace.finalScore!).toBeGreaterThanOrEqual(35);
    expect(trace.partialEvidence).toBeNull();
    expect(trace.nrReasons).toEqual([]);
    expect(trace.bindingCap).toBeNull();
  });

  it("passes every absolute expectation and ordering constraint in one evaluation pass", () => {
    const traces = new Map(
      GOLDEN_SCENARIOS.map((scenario) => [scenario.id, scoreV9GoldenScenario(scenario, V9_CANDIDATE_POLICY_V1)]),
    );
    expect(new Set(GOLDEN_SCENARIOS.map((scenario) => scenario.id)).size).toBe(GOLDEN_SCENARIOS.length);

    for (const scenario of GOLDEN_SCENARIOS) {
      const trace = traces.get(scenario.id)!;
      const rated = trace.finalScore !== null && trace.finalGrade !== "NR";
      expect(rated, scenario.id).toBe(scenario.expected.expectedRated);
      expect(scenario.expected.allowedGrades, scenario.id).toContain(trace.finalGrade);
      if (scenario.expected.minScore !== undefined) {
        expect(trace.finalScore, scenario.id).not.toBeNull();
        expect(trace.finalScore!, scenario.id).toBeGreaterThanOrEqual(scenario.expected.minScore);
      }
      if (scenario.expected.maxScore !== undefined) {
        expect(trace.finalScore, scenario.id).not.toBeNull();
        expect(trace.finalScore!, scenario.id).toBeLessThanOrEqual(scenario.expected.maxScore);
      }
      if (Object.prototype.hasOwnProperty.call(scenario.expected, "expectedBindingCapKind")) {
        expect(trace.bindingCap?.kind ?? null, scenario.id).toBe(scenario.expected.expectedBindingCapKind ?? null);
      }
    }
    for (const constraint of PAIRWISE_CONSTRAINTS) {
      const higher = traces.get(constraint.higherId);
      const lower = traces.get(constraint.lowerId);
      expect(higher, constraint.rationale).toBeDefined();
      expect(lower, constraint.rationale).toBeDefined();
      expect(higher!.finalScore, constraint.higherId).not.toBeNull();
      expect(lower!.finalScore, constraint.lowerId).not.toBeNull();
      expect(higher!.finalScore! - lower!.finalScore!, constraint.rationale).toBeGreaterThanOrEqual(constraint.minGap);
    }
  });
});
