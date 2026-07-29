import { describe, expect, it } from "vitest";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { buildScoreWaterfall } from "../safety-score-v9-waterfall";

type Stages = ReturnType<typeof makeV9Card>["scoreTrace"]["stages"];

function cardWithStages(stages: Partial<Stages>, bindingCap: unknown = null) {
  const base = makeV9Card();
  return {
    ...base,
    ...(bindingCap === null ? {} : { bindingCap }),
    scoreTrace: { ...base.scoreTrace, stages: { ...base.scoreTrace.stages, ...stages } },
  } as ReturnType<typeof makeV9Card>;
}

describe("buildScoreWaterfall", () => {
  it("stays silent when no stage moved the score", () => {
    const card = cardWithStages({
      aggregatedQualityScore: 84,
      pegMultiplier: 1,
      baseAssetScore: 84,
      deploymentAdjustmentPoints: 0,
      deploymentAdjustedScore: 84,
      preCapScore: 84,
      publishedScore: 84,
    });
    expect(buildScoreWaterfall(card)).toEqual([]);
  });

  it("shows the peg haircut that the pillar bars cannot explain", () => {
    // alUSD's real shape: structural quality 49, peg multiplier 0.609, final 29.
    const card = cardWithStages({
      aggregatedQualityScore: 48.996,
      pegMultiplier: 0.609,
      baseAssetScore: 29.838,
      deploymentAdjustmentPoints: 0,
      deploymentAdjustedScore: 29.838,
      preCapScore: 29.838,
      publishedScore: 29.838,
    });
    const steps = buildScoreWaterfall(card);
    expect(steps.map((step) => step.key)).toEqual(["quality", "peg"]);
    expect(steps[1]?.operator).toBe("x0.609");
    // The peg row lands on the published number, so it becomes the anchor row
    // rather than printing the same value twice.
    expect(steps[1]?.kind).toBe("published");
  });

  it("ignores a peg multiplier that rounds to no effect", () => {
    const card = cardWithStages({
      aggregatedQualityScore: 84,
      pegMultiplier: 0.999,
      baseAssetScore: 83.9,
      deploymentAdjustmentPoints: 0,
      deploymentAdjustedScore: 83.9,
      preCapScore: 83.9,
      publishedScore: 83.9,
    });
    expect(buildScoreWaterfall(card)).toEqual([]);
  });

  it("chains peg, common-mode exposure, and a binding cap in order", () => {
    const card = cardWithStages(
      {
        aggregatedQualityScore: 80,
        pegMultiplier: 0.95,
        baseAssetScore: 76,
        deploymentAdjustmentPoints: 2.5,
        deploymentAdjustedScore: 73.5,
        preCapScore: 73.5,
        publishedScore: 60,
      },
      {
        kind: "evidence:limited",
        limit: 60,
        source: "evidence",
        reason: "limited evidence ceiling.",
        binding: true,
      },
    );
    const steps = buildScoreWaterfall(card);
    expect(steps.map((step) => step.key)).toEqual(["quality", "peg", "deployment", "cap"]);
    expect(steps.map((step) => step.value)).toEqual([80, 76, 73.5, 60]);
    expect(steps.at(-1)?.operator).toBe("max 60");
    // CapSection renders the reason directly beneath; the row must not repeat it.
    expect(steps.at(-1)?.detail).toBeNull();
  });

  it("returns nothing when the asset is not rated", () => {
    expect(buildScoreWaterfall(cardWithStages({ aggregatedQualityScore: null, publishedScore: null }))).toEqual([]);
  });
});
