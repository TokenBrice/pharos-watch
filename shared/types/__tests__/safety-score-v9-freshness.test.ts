import { describe, expect, it } from "vitest";
import { SafetyScoreV9CurrentResponseSchema } from "../safety-score-v9-publication-response";
import { explainSafetyScoreV9PillarFreshness, SafetyScoreV9PillarFreshnessSchema } from "../safety-score-v9-public-facts";
import { currentResponse } from "./safety-score-v9-public.test-support";

function fixture(observedAtSec: number | null = 100) {
  const response = currentResponse();
  response.asOfSec = 20_000;
  response.publishedAtSec = 20_001;
  response.pillarFreshness = { dexMaxAgeSec: 14_400, dexObservedAtSec: [observedAtSec] };
  for (const pillar of ["backing", "exit", "control"] as const) {
    response.cards[0]!.pillars[pillar].freshness = explainSafetyScoreV9PillarFreshness(response, 0, pillar).verdict;
  }
  response.cards[0]!.evidence.freshness = response.cards[0]!.pillars.exit.freshness === "stale" ? "stale" : "unknown";
  return response;
}

describe("compact reproducible pillar freshness", () => {
  it.each([
    [5_600, "current", "within-budget"], [5_599, "stale", "source-too-old"],
    [16_400, "current", "within-budget"], [2_000, "stale", "source-too-old"],
    [20_001, "unknown", "future-source-time"], [null, "unknown", "source-unavailable"],
  ] as const)("reproduces clock %s without using publication time", (clock, verdict, reason) => {
    const response = fixture(clock);
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(response).success).toBe(true);
    expect(explainSafetyScoreV9PillarFreshness(response, 0, "exit")).toEqual({
      verdict, reason, assessedAtSec: 20_000, observedAtSec: clock,
      sourceGenerationId: clock === null ? null : "dex:g1", maxAgeSec: 14_400,
    });
  });

  it("uses nondefault budgets and never fabricates unwired or historical clocks", () => {
    const response = fixture(15_000);
    response.pillarFreshness!.dexMaxAgeSec = 5_000;
    expect(explainSafetyScoreV9PillarFreshness(response, 0, "exit").verdict).toBe("current");
    response.pillarFreshness!.dexMaxAgeSec = 4_999;
    expect(explainSafetyScoreV9PillarFreshness(response, 0, "exit").verdict).toBe("stale");
    for (const pillar of ["backing", "control"] as const) {
      expect(explainSafetyScoreV9PillarFreshness(response, 0, pillar)).toEqual({
        verdict: "unknown", assessedAtSec: 20_000, observedAtSec: null,
        sourceGenerationId: null, maxAgeSec: null, reason: "pillar-clock-unavailable",
      });
    }
    delete response.pillarFreshness;
    expect(explainSafetyScoreV9PillarFreshness(response, 0, "exit").reason).toBe("historical-operands-unavailable");
    const historical = currentResponse();
    expect(SafetyScoreV9CurrentResponseSchema.parse(historical)).toEqual(historical);
  });

  it("rejects dangling membership, false verdicts, missing generation and malformed clocks", () => {
    for (const clocks of [[], [100, 200]]) {
      const response = fixture();
      response.pillarFreshness!.dexObservedAtSec = clocks;
      expect(SafetyScoreV9CurrentResponseSchema.safeParse(response).success).toBe(false);
    }
    const response = fixture();
    response.cards[0]!.pillars.exit.freshness = "current";
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(response).success).toBe(false);
    response.cards[0]!.pillars.exit.freshness = "stale";
    response.cards[0]!.evidence.freshness = "unknown";
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(response).success).toBe(false);
    response.cards[0]!.evidence.freshness = "stale";
    delete response.sourceGenerations.dex;
    expect(SafetyScoreV9CurrentResponseSchema.safeParse(response).success).toBe(false);
    for (const clock of [-1, 1.5, Number.NaN]) {
      expect(SafetyScoreV9PillarFreshnessSchema.safeParse({ dexMaxAgeSec: 14_400, dexObservedAtSec: [clock] }).success).toBe(false);
    }
    expect(() => explainSafetyScoreV9PillarFreshness(fixture(), 1, "exit")).toThrow("card index");
  });
});
