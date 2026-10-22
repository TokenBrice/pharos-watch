import { describe, expect, it } from "vitest";
import { aggregateV9SmoothBoundedHeadroom, type V9AggregationPillars } from "../safety-score-v9/aggregation";
import { scoreV9EvaluatedAsset } from "../safety-score-v9/score";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { unknownQuality } from "../safety-score-v9/policy";
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
          backing: included.includes("backing") ? backing : unknownQuality("backing", "U"),
          exit: included.includes("exit") ? exit : unknownQuality("exit", "U"),
          control: included.includes("control") ? control : unknownQuality("control", "U"),
        };
        const result = aggregateV9SmoothBoundedHeadroom(scores, WEIGHTS, 20, included);
        if (included.length < 2) {
          expect(result).toBeNull();
          continue;
        }
        expect(result).not.toBeNull();
        const trace = result!;
        const supportedMean = PILLARS.reduce((sum, pillar) => sum + scores[pillar]! * WEIGHTS[pillar], 0);
        const minimum = Math.min(...PILLARS.map((pillar) => scores[pillar]!));
        expect(trace.supportCeiling).toBeCloseTo(supportedMean, 12);
        expect(trace.score).toBeCloseTo(minimum + 20 * Math.tanh((supportedMean - minimum) / 20), 12);
        expect(trace.score).toBeGreaterThanOrEqual(minimum - 1e-10);
        expect(trace.score).toBeLessThanOrEqual(supportedMean + 1e-10);
        expect(supportedMean).toBeLessThanOrEqual(Math.max(...PILLARS.map((pillar) => scores[pillar]!)) + 1e-10);
        for (const pillar of PILLARS) {
          expect(trace.effectiveScoringWeights[pillar]).toBeCloseTo(WEIGHTS[pillar], 12);
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
        expect(trace.finalScore).toBe(Math.round(aggregateV9SmoothBoundedHeadroom({
          backing: included.includes("backing") ? 90 : 50,
          exit: included.includes("exit") ? 90 : 50,
          control: included.includes("control") ? 90 : 60,
        }, WEIGHTS, 20, included)!.score));
        expect(trace.partialEvidence === null).toBe(included.length === 3);
      } else {
        expect(trace.ratingStatus).toBe("pipeline-gap");
        for (const value of [trace.finalScore, trace.finalGrade, trace.aggregation, trace.weakestPillar, trace.weightedQuality, trace.baseAssetScore, trace.pegMultiplier, trace.preCapScore, trace.inheritableScore, trace.effectiveScoringWeights]) expect(value).toBeNull();
        expect(trace.nrReasons.map((reason) => reason.code)).toEqual([included.length === 0 ? "all-pillars-pipeline-gap" : "single-pillar-pipeline-gap"]);
        expect(trace.bindingCap).toBeNull();
      }
    });
  }

  it.each(["C", "U"] as const)("prices unavailable Exit at its %s constant without renormalization", (cause) => {
    const price = unknownQuality("exit", cause);
    const make = (score: number | null, assetId = "fixture") => scoreV9EvaluatedAsset(makeV9ProductionScoreInput({
      assetId,
      pillars: {
        backing: makeV9Pillar(90), control: makeV9Pillar(90),
        exit: makeV9Pillar(score, score === null ? {
          aggregationDisposition: "unavailable", supportedComponentKeys: [],
          limitedEvidenceCauses: [cause], causeGapIds: ["gap:exit"],
        } : {}),
      },
    }), V9_CANDIDATE_POLICY_V1);
    const missing = make(null);
    expect(missing.aggregation?.pricedUnknownPillars).toEqual([
      { pillar: "exit", cause, score: price, causeGapIds: ["gap:exit"] },
    ]);
    expect(missing.diagnosticPillarScores.exit).toBeNull();
    expect(missing.includedPillars).not.toContain("exit");
    expect(missing.effectiveScoringWeights).toEqual(WEIGHTS);
    expect(missing.finalScore).toBe(make(price).finalScore);
    expect(missing.finalScore).toBeLessThanOrEqual(make(55).finalScore!);
    expect(missing.finalScore).toBeGreaterThan(make(0).finalScore!);
    expect(make(null, "unrelated-identity").aggregation).toEqual(missing.aggregation);
    expect(make(null, "unrelated-identity").finalScore).toBe(missing.finalScore);
  });

  it("rejects malformed included scores, duplicate masks and invalid weights", () => {
    expect(() => aggregateV9SmoothBoundedHeadroom({ backing: null, exit: 80, control: 80 }, WEIGHTS, 20)).toThrow(/backing pillar/);
    expect(() => aggregateV9SmoothBoundedHeadroom({ backing: 80, exit: 80, control: 80 }, WEIGHTS, 20, ["exit", "exit"])).toThrow(/unique/);
    for (const weights of [{ backing: 0, exit: 0.75, control: 0.25 }, { backing: NaN, exit: 0.35, control: 0.25 }, { backing: 0.5, exit: 0.35, control: 0.25 }]) {
      expect(() => aggregateV9SmoothBoundedHeadroom({ backing: 80, exit: 80, control: 80 }, weights, 20)).toThrow();
    }
  });
});
