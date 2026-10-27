import { describe, expect, it } from "vitest";
import { summarizeDdrrRows } from "@shared/lib/depeg-resolver-review";
import type { DdrrSummary } from "@shared/types/depeg-resolver-review";
import { makePredictionPolicySegment } from "@/components/depeg-resolver-review-test-support";
import { describePromotedAccuracy, formatPromotedAccuracyLines } from "../ddr-promoted-accuracy";

const base = summarizeDdrrRows([]);
const template = base.byPredictionPolicy.find((segment) => segment.segmentKind === "all")!.metrics;

function summary(options: {
  correct: number;
  scored: number;
  baseline?: number;
  scope?: DdrrSummary["headlineScope"];
  segments: DdrrSummary["byPredictionPolicy"];
}): DdrrSummary {
  return {
    ...base,
    headlineScope: options.scope ?? "current_policy",
    headline: {
      ...base.headline,
      recoveryLikelihoodCorrectCount: options.correct,
      recoveryLikelihoodScoredCount: options.scored,
      recoveryLikelihoodAccuracyPct: options.scored > 0 ? options.correct / options.scored : null,
      baselineRecoverableCorrectCount: options.baseline,
    },
    byPredictionPolicy: options.segments,
  };
}

const lines = (s: DdrrSummary) => formatPromotedAccuracyLines(describePromotedAccuracy(s));

describe("promoted DDRR accuracy", () => {
  it("pairs the captured fraction with its baseline and frozen-version cohort", () => {
    const s = summary({ correct: 61, scored: 74, baseline: 70, segments: [
      makePredictionPolicySegment(template, "2.0", 10, 9),
      makePredictionPolicySegment(template, "3.04", 30, 25),
      makePredictionPolicySegment(template, "4.6", 34, 27),
      makePredictionPolicySegment(template, "5.0", 0, 0),
    ] });
    expect(lines(s)).toEqual({
      calls: "Recovery calls correct: 61/74 (82.4%)",
      baseline: "Always-recover baseline: 70/74 (94.6%)",
      scope: "Graded calls from v2/v3/v4 · 0 from current v5",
    });
  });

  it("counts current-major graded calls and omits the qualifier when nothing is frozen", () => {
    expect(lines(summary({ correct: 4, scored: 6, baseline: 5, segments: [
      makePredictionPolicySegment(template, "4.6", 4, 3),
      makePredictionPolicySegment(template, "5.0", 2, 1),
    ] })).scope).toBe("Graded calls from v4 · 2 from current v5");
    expect(lines(summary({ correct: 1, scored: 2, segments: [makePredictionPolicySegment(template, "5.0", 2, 1)] })).scope).toBeNull();
  });

  it("keeps a missing baseline unavailable and an observed zero baseline zero", () => {
    const segments = [makePredictionPolicySegment(template, "4.6", 8, 8)];
    expect(lines(summary({ correct: 8, scored: 8, segments })).baseline).toBe("Always-recover baseline: —");
    expect(lines(summary({ correct: 8, scored: 8, baseline: 0, segments })).baseline).toBe("Always-recover baseline: 0/8 (0.0%)");
  });

  it("prints no percentage over a zero denominator", () => {
    const s = summary({ correct: 0, scored: 0, baseline: 0, segments: [] });
    expect(lines(s).calls).toBe("Recovery calls correct: 0/0");
    expect(lines(s).baseline).toBe("Always-recover baseline: 0/0");
  });

  it("withholds the version scope when segments do not reconcile with the headline", () => {
    // A second policy also scored: the current-policy headline cannot be attributed.
    const otherPolicy = { ...makePredictionPolicySegment(template, "3.04", 5, 5), predictionPolicyVersion: "legacy-v0" };
    const mixed = summary({ correct: 8, scored: 10, segments: [makePredictionPolicySegment(template, "4.6", 10, 8), otherPolicy] });
    expect(lines(mixed).scope).toBe("Graded calls by version: —");
    // Unversioned scored rows also make the scope unavailable.
    const unversioned = summary({ correct: 8, scored: 10, segments: [
      makePredictionPolicySegment(template, "4.6", 8, 7),
      makePredictionPolicySegment(template, "undefined", 2, 1),
    ] });
    expect(lines(unversioned).scope).toBe("Graded calls by version: —");
    // Missing segments for scored calls cannot name a cohort either.
    expect(lines(summary({ correct: 8, scored: 10, segments: [] })).scope).toBe("Graded calls by version: —");
  });

  it("reconciles an all-policy headline across every prediction policy", () => {
    const otherPolicy = { ...makePredictionPolicySegment(template, "3.04", 5, 5), predictionPolicyVersion: "legacy-v0" };
    const s = summary({ correct: 13, scored: 15, scope: "all_ddrv2", segments: [makePredictionPolicySegment(template, "4.6", 10, 8), otherPolicy] });
    expect(lines(s).scope).toBe("Graded calls from v3/v4 · 0 from current v5");
  });
});
