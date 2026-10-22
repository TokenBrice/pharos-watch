import { describe, expect, it } from "vitest";
import { GOLDEN_SCENARIOS } from "@shared/data/safety-score-v9/golden-scenarios-v1";
import { unknownQuality, V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { scoreV9GoldenScenario } from "../safety-score-v9/scenario-evaluator";

describe("Safety Score v9 durable golden corpus", () => {
  const missingPillarScenarios = GOLDEN_SCENARIOS.filter((scenario) =>
    Object.values(scenario.pillars).some((score) => score === null),
  );
  it.each(missingPillarScenarios)("prices $id research uncertainty at the cause-aware unknown quality", (scenario) => {
    const trace = scoreV9GoldenScenario(scenario, V9_CANDIDATE_POLICY_V1);
    const explicit = scoreV9GoldenScenario({ ...scenario, pillars: {
      backing: scenario.pillars.backing ?? unknownQuality("backing", "U"),
      exit: scenario.pillars.exit ?? unknownQuality("exit", "U"),
      control: scenario.pillars.control ?? unknownQuality("control", "U"),
    } }, V9_CANDIDATE_POLICY_V1);
    expect(trace.ratingStatus).toBe("rated");
    expect(trace.finalScore).toBe(explicit.finalScore);
    expect(trace.finalGrade).toBe(explicit.finalGrade);
    expect(trace.partialEvidence).toBeNull();
    expect(trace.nrReasons).toEqual([]);
  });

  it("evaluates every research scenario independently of obsolete authored grade expectations", () => {
    expect(new Set(GOLDEN_SCENARIOS.map((scenario) => scenario.id)).size).toBe(GOLDEN_SCENARIOS.length);
    for (const scenario of GOLDEN_SCENARIOS) {
      const trace = scoreV9GoldenScenario(scenario, V9_CANDIDATE_POLICY_V1);
      // Explicit research caps are not production structural cap policy. The
      // old corpus's grade snapshots and minimum pairwise gaps are not R2 rules.
      expect(trace.scenarioId).toBe(scenario.id);
      if (trace.finalScore !== null) {
        expect(trace.ratingStatus).toBe("rated");
        expect(Number.isInteger(trace.finalScore)).toBe(true);
        expect(trace.finalScore).toBeGreaterThanOrEqual(0);
        expect(trace.finalScore).toBeLessThanOrEqual(100);
        expect(trace.nrReasons).toEqual([]);
        for (const cap of trace.caps) expect(trace.finalScore).toBeLessThanOrEqual(Math.floor(cap.limit));
      } else {
        expect(trace.ratingStatus).not.toBe("rated");
        expect(trace.nrReasons.length).toBeGreaterThan(0);
      }
    }
  });
});
