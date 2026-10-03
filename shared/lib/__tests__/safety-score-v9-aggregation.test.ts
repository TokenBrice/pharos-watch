import { describe, expect, it } from "vitest";
import { aggregateV9SmoothBoundedHeadroom, type V9AggregationPillars } from "../safety-score-v9/aggregation";
import { scoreV9EvaluatedAsset } from "../safety-score-v9/score";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { makeV9Pillar, makeV9ProductionScoreInput } from "./safety-score-v9-score.test-support";

const WEIGHTS = { backing: 0.4, exit: 0.35, control: 0.25 } as const;
const PILLARS = ["backing", "exit", "control"] as const;
const BOUNDARIES = [0, 1, 35, 50, 90, 99, 100];

describe("cause-aware fixed-H20 aggregation", () => {
  for (let mask = 0; mask < 8; mask++) {
    const included = PILLARS.filter((_, index) => (mask & (1 << index)) !== 0);
    it(`conserves support and is coordinate-monotone for mask ${mask}`, () => {
      for (const backing of BOUNDARIES) for (const exit of BOUNDARIES) for (const control of BOUNDARIES) {
        const values = { backing, exit, control };
        const scores: V9AggregationPillars = {
          backing: included.includes("backing") ? backing : null,
          exit: included.includes("exit") ? exit : null,
          control: included.includes("control") ? control : null,
        };
        const result = aggregateV9SmoothBoundedHeadroom(scores, WEIGHTS, 20, included);
        if (included.length < 2) {
          expect(result).toBeNull();
          continue;
        }
        expect(result).not.toBeNull();
        const trace = result!;
        const totalWeight = included.reduce((sum, pillar) => sum + WEIGHTS[pillar], 0);
        const supportedMean = included.reduce((sum, pillar) => sum + values[pillar] * WEIGHTS[pillar] / totalWeight, 0);
        const minimum = Math.min(...included.map((pillar) => values[pillar]));
        expect(trace.supportCeiling).toBeCloseTo(supportedMean, 12);
        expect(trace.score).toBeCloseTo(minimum + 20 * Math.tanh((supportedMean - minimum) / 20), 12);
        expect(trace.score).toBeGreaterThanOrEqual(minimum - 1e-10);
        expect(trace.score).toBeLessThanOrEqual(supportedMean + 1e-10);
        expect(supportedMean).toBeLessThanOrEqual(Math.max(...included.map((pillar) => values[pillar])) + 1e-10);
        for (const pillar of PILLARS) {
          expect(trace.effectiveScoringWeights[pillar]).toBeCloseTo(included.includes(pillar) ? WEIGHTS[pillar] / totalWeight : 0, 12);
          if (!included.includes(pillar) || values[pillar] === 100) continue;
          const improved = aggregateV9SmoothBoundedHeadroom({ ...scores, [pillar]: values[pillar] + 1 }, WEIGHTS, 20, included)!;
          expect(improved.score).toBeGreaterThanOrEqual(trace.score - 1e-10);
        }
      }
    });

    it(`publishes the correct availability state for mask ${mask}`, () => {
      const pillar = (key: typeof PILLARS[number]) => included.includes(key) ? makeV9Pillar(90) : makeV9Pillar(null, {
        aggregationDisposition: "excluded-a-b", supportedComponentKeys: [], causeGapIds: [`gap:${key}`],
        excludedCauseGapIds: [`gap:${key}`], excludedCauses: ["A"], excludedComponentKeys: [`${key}:unavailable`],
        evidenceLevel: "insufficient", reasons: [{ code: "missing-pillar-evidence", path: key, message: "Captured reader failure", responsibility: "producer-failed", cause: "A", causeGapIds: [`gap:${key}`] }],
      });
      const trace = scoreV9EvaluatedAsset(makeV9ProductionScoreInput({ pillars: {
        backing: pillar("backing"), exit: pillar("exit"), control: pillar("control"),
      } }), V9_CANDIDATE_POLICY_V1);
      if (included.length >= 2) {
        expect(trace.ratingStatus).toBe("rated");
        expect(trace.finalScore).toBe(90);
        expect(trace.finalGrade).toBe("A+");
        expect(trace.partialEvidence === null).toBe(included.length === 3);
      } else {
        expect(trace.ratingStatus).toBe("pipeline-gap");
        for (const value of [trace.finalScore, trace.finalGrade, trace.aggregation, trace.weakestPillar, trace.weightedQuality, trace.baseAssetScore, trace.pegMultiplier, trace.preCapScore, trace.inheritableScore, trace.effectiveScoringWeights]) expect(value).toBeNull();
        expect(trace.nrReasons.map((reason) => reason.code)).toEqual([included.length === 0 ? "all-pillars-pipeline-gap" : "single-pillar-pipeline-gap"]);
        expect(trace.bindingCap).toBeNull();
      }
    });
  }

  it("distinguishes permitted A/B admission drops from C/U disclosure refinement", () => {
    const partial = aggregateV9SmoothBoundedHeadroom({ backing: 90, exit: null, control: 90 }, WEIGHTS, 20, ["backing", "control"])!;
    const uncertain = aggregateV9SmoothBoundedHeadroom({ backing: 90, exit: 35, control: 90 }, WEIGHTS, 20)!;
    const measured = aggregateV9SmoothBoundedHeadroom({ backing: 90, exit: 55, control: 90 }, WEIGHTS, 20)!;
    expect(partial.score).toBe(90);
    expect(measured.score).toBeCloseTo(71.27141107672705, 10);
    expect(measured.score).toBeLessThan(partial.score);
    expect(measured.score).toBeGreaterThan(uncertain.score);
  });

  it("rejects malformed included scores, duplicate masks and invalid weights", () => {
    expect(() => aggregateV9SmoothBoundedHeadroom({ backing: null, exit: 80, control: 80 }, WEIGHTS, 20)).toThrow(/included backing/);
    expect(() => aggregateV9SmoothBoundedHeadroom({ backing: 80, exit: 80, control: 80 }, WEIGHTS, 20, ["exit", "exit"])).toThrow(/unique/);
    for (const weights of [{ backing: 0, exit: 0.75, control: 0.25 }, { backing: NaN, exit: 0.35, control: 0.25 }, { backing: 0.5, exit: 0.35, control: 0.25 }]) {
      expect(() => aggregateV9SmoothBoundedHeadroom({ backing: 80, exit: 80, control: 80 }, weights, 20)).toThrow();
    }
  });
});
