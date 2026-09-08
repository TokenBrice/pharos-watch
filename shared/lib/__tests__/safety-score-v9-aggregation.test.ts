import { describe, expect, it } from "vitest";
import {
  aggregateV9GeneralizedMean,
  aggregateV9SmoothBoundedHeadroom,
  type V9AggregationPillars,
} from "../safety-score-v9/aggregation";

const WEIGHTS = { backing: 0.4, exit: 0.35, control: 0.25 } as const;

function smooth(pillars: V9AggregationPillars): number {
  return aggregateV9SmoothBoundedHeadroom(pillars, WEIGHTS, 30).score;
}

function generalized(pillars: V9AggregationPillars): number {
  return aggregateV9GeneralizedMean(pillars, WEIGHTS, -4).score;
}

describe("Safety Score v9 weakest-path aggregation", () => {
  it.each([
    ["smooth bounded headroom", smooth],
    ["generalized mean", generalized],
  ])("%s is monotonic in every pillar", (_name, aggregate) => {
    for (let backing = 0; backing <= 100; backing += 10) {
      for (let exit = 0; exit <= 100; exit += 10) {
        for (let control = 0; control <= 100; control += 10) {
          const baseline = { backing, exit, control };
          const score = aggregate(baseline);
          for (const pillar of ["backing", "exit", "control"] as const) {
            if (baseline[pillar] === 100) continue;
            const improved = { ...baseline, [pillar]: baseline[pillar] + 1 };
            expect(aggregate(improved), `${backing}/${exit}/${control}: ${pillar}`).toBeGreaterThanOrEqual(score - 1e-10);
          }
        }
      }
    }
  });

  it("smooth aggregation stays between the weakest pillar and weighted quality", () => {
    const trace = aggregateV9SmoothBoundedHeadroom(
      { backing: 92, exit: 45, control: 84 },
      WEIGHTS,
      30,
    );
    expect(trace.weakestPillar).toBe("exit");
    expect(trace.score).toBeGreaterThan(trace.weakestScore);
    expect(trace.score).toBeLessThan(trace.weightedQuality);
  });

  it("smooth aggregation has no fixed weakest-plus-headroom plateau", () => {
    const scores = Array.from({ length: 101 }, (_, backing) =>
      smooth({ backing, exit: 91.37, control: 82.19 }),
    );
    expect(new Set(scores.map((score) => score.toFixed(8))).size).toBe(101);
  });

  it("generalized mean increasingly emphasizes weak pillars as the exponent falls", () => {
    const pillars = { backing: 95, exit: 45, control: 90 };
    const mild = aggregateV9GeneralizedMean(pillars, WEIGHTS, -1);
    const strong = aggregateV9GeneralizedMean(pillars, WEIGHTS, -6);
    expect(strong.score).toBeLessThan(mild.score);
    expect(strong.score).toBeGreaterThanOrEqual(strong.weakestScore);
  });

  it("rejects invalid policy parameters", () => {
    expect(() =>
      aggregateV9SmoothBoundedHeadroom({ backing: 80, exit: 80, control: 80 }, WEIGHTS, 0),
    ).toThrow(/headroom/);
    expect(() =>
      aggregateV9GeneralizedMean({ backing: 80, exit: 80, control: 80 }, WEIGHTS, 1),
    ).toThrow(/negative/);
  });

  it("rejects invalid pillars for either aggregation method", () => {
    for (const aggregate of [smooth, generalized]) {
      for (const pillar of ["backing", "exit", "control"] as const) {
        for (const value of [NaN, Infinity, -1, 101]) {
          expect(() => aggregate({ backing: 80, exit: 80, control: 80, [pillar]: value })).toThrow();
        }
      }
    }
  });

  it("rejects nonpositive and nonfinite weights independently of the total", () => {
    const pillars = { backing: 80, exit: 80, control: 80 };
    for (const weights of [
      { backing: 0, exit: 0.75, control: 0.25 },
      { backing: -0.1, exit: 0.85, control: 0.25 },
      { backing: NaN, exit: 0.35, control: 0.25 },
      { backing: Infinity, exit: -Infinity, control: 0.25 },
    ]) {
      expect(() => aggregateV9SmoothBoundedHeadroom(pillars, weights, 30)).toThrow();
      expect(() => aggregateV9GeneralizedMean(pillars, weights, -4)).toThrow();
    }
  });

  it("accepts weight totals within tolerance and rejects totals on either side outside it", () => {
    const pillars = { backing: 80, exit: 80, control: 80 };
    const accepted = { ...WEIGHTS, backing: 0.4000005 };
    expect(aggregateV9SmoothBoundedHeadroom(pillars, accepted, 30).score).toBeCloseTo(80, 3);
    expect(aggregateV9GeneralizedMean(pillars, accepted, -4).score).toBeCloseTo(80, 3);
    for (const backing of [0.399998, 0.400002]) {
      expect(() => aggregateV9SmoothBoundedHeadroom(pillars, { ...WEIGHTS, backing }, 30)).toThrow();
      expect(() => aggregateV9GeneralizedMean(pillars, { ...WEIGHTS, backing }, -4)).toThrow();
    }
  });

  it("generalized mean preserves equal scores and makes any zero pillar binding", () => {
    for (const score of [0, 37, 100]) {
      expect(generalized({ backing: score, exit: score, control: score })).toBeCloseTo(score, 10);
    }
    for (const pillar of ["backing", "exit", "control"] as const) {
      expect(generalized({ backing: 83, exit: 71, control: 92, [pillar]: 0 })).toBe(0);
    }
  });
});
