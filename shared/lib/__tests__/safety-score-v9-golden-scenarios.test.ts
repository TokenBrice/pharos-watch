import { describe, expect, it } from "vitest";
import { GOLDEN_SCENARIOS, PAIRWISE_CONSTRAINTS } from "@shared/data/safety-score-v9/golden-scenarios-v1";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { scoreV9GoldenScenario } from "../safety-score-v9/scenario-evaluator";

describe("Safety Score v9 durable golden corpus", () => {
  it("passes every absolute scenario expectation under the committed candidate", () => {
    expect(GOLDEN_SCENARIOS).toHaveLength(34);
    expect(new Set(GOLDEN_SCENARIOS.map((scenario) => scenario.id)).size).toBe(GOLDEN_SCENARIOS.length);

    for (const scenario of GOLDEN_SCENARIOS) {
      const trace = scoreV9GoldenScenario(scenario, V9_CANDIDATE_POLICY_V1);
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
  });

  it("passes the complete ordering-constraint set", () => {
    expect(PAIRWISE_CONSTRAINTS).toHaveLength(31);
    const traces = new Map(
      GOLDEN_SCENARIOS.map((scenario) => [scenario.id, scoreV9GoldenScenario(scenario, V9_CANDIDATE_POLICY_V1)]),
    );
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
