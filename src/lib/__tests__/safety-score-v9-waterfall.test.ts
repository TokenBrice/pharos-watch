import { describe, expect, it } from "vitest";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
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
        kind: "parent",
        limit: 60,
        source: "parent",
        reason: "The required parent limits the published score.",
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

  it("itemises a published score adjustment instead of leaving a silent gap", () => {
    const base = cardWithStages({
      aggregatedQualityScore: 80,
      pegMultiplier: 1,
      baseAssetScore: 80,
      deploymentAdjustmentPoints: 2,
      deploymentAdjustedScore: 78,
      preCapScore: 83,
      publishedScore: 83,
    });
    const card = {
      ...base,
      scoreTrace: {
        ...base.scoreTrace,
        scoreAdjustments: [
          {
            source: "asset-premium",
            kind: "market-anchor-longevity",
            label: "Market anchor longevity",
            configuredPoints: 5,
            appliedPoints: 5,
            scoreBefore: 78,
            scoreAfter: 83,
            publishedScoreBefore: 78,
            publishedScoreAfter: 83,
          },
        ],
      },
    } as SafetyScoreV9CurrentCard;
    const steps = buildScoreWaterfall(card);
    expect(steps.map((step) => step.key)).toEqual([
      "quality",
      "deployment",
      "adjustment-market-anchor-longevity",
    ]);
    expect(steps.at(-1)?.operator).toBe("+5.0");
    expect(steps.at(-1)?.value).toBe(83);
    expect(steps.at(-1)?.kind).toBe("published");
  });

  it("explains a premium truncated by the publication maximum", () => {
    // USDT's real shape: quality 82.5364, +12.0 premium to 94.5364, published
    // at the 87 A+ floor. The premium row keeps its pre-publication value.
    const base = cardWithStages({
      aggregatedQualityScore: 82.5364,
      pegMultiplier: 1,
      baseAssetScore: 82.5364,
      deploymentAdjustmentPoints: 0,
      deploymentAdjustedScore: 82.5364,
      preCapScore: 94.5364,
      publishedScore: 87,
    });
    const card = {
      ...base,
      scoreTrace: {
        ...base.scoreTrace,
        scoreAdjustments: [
          {
            source: "asset-premium",
            kind: "market-anchor-longevity",
            label: "#1 & Longevity Premium",
            configuredPoints: 12,
            appliedPoints: 12,
            scoreBefore: 82.5364,
            scoreAfter: 94.5364,
            publishedScoreBefore: 83,
            publishedScoreAfter: 87,
          },
        ],
      },
    } as SafetyScoreV9CurrentCard;

    const steps = buildScoreWaterfall(card);
    expect(steps.map((step) => step.key)).toEqual([
      "quality",
      "adjustment-market-anchor-longevity",
      "publication-maximum",
    ]);
    expect(steps[1]).toMatchObject({ operator: "+12.0", value: 94.5364 });
    expect(steps[2]).toMatchObject({
      label: "Publication maximum",
      operator: "max 87",
      value: 87,
    });
  });

  it("does not invent a publication maximum for ordinary rounding", () => {
    const card = cardWithStages({
      aggregatedQualityScore: 86.7,
      pegMultiplier: 0.95,
      baseAssetScore: 82.365,
      deploymentAdjustmentPoints: 0,
      deploymentAdjustedScore: 82.365,
      preCapScore: 82.365,
      publishedScore: 82,
    });

    expect(buildScoreWaterfall(card).map((step) => step.key)).toEqual(["quality", "peg", "published"]);
  });

  it("does not invent a publication maximum when a suppressed peg row explains the gap", () => {
    // Quality 87.55 with a 0.996 peg multiplier: the peg row is suppressed by
    // PEG_EPSILON, but the pre-cap score 87.1998 publishes as 87. Plain rounding
    // of the full chain explains the gap; no publication ceiling is involved.
    const base = cardWithStages({
      aggregatedQualityScore: 87.55,
      pegMultiplier: 0.996,
      baseAssetScore: 87.1998,
      deploymentAdjustmentPoints: 0,
      deploymentAdjustedScore: 87.1998,
      preCapScore: 87.1998,
      publishedScore: 87,
    });
    // Subcomponent-only partial evidence keeps the otherwise single-pillar
    // chain visible, which is where the false cap row appeared.
    const card = {
      ...base,
      partialEvidence: {
        reasonCode: "partial-evidence-pipeline-gap",
        excludedPillars: [],
        excludedComponentKeys: ["redemption:reviewed:cost"],
        causeGapRefs: [2],
        causes: ["B"],
      },
    } as SafetyScoreV9CurrentCard;

    expect(buildScoreWaterfall(card).map((step) => step.key)).toEqual(["quality", "published"]);
  });

  it("keeps the three-pillar caption when only a subcomponent carries partial evidence", () => {
    const base = makeV9Card();
    const card = {
      ...base,
      partialEvidence: {
        reasonCode: "partial-evidence-pipeline-gap",
        excludedPillars: [],
        excludedComponentKeys: ["redemption:reviewed:cost"],
        causeGapRefs: [2],
        causes: ["B"],
      },
      scoreTrace: {
        ...base.scoreTrace,
        stages: {
          ...base.scoreTrace.stages,
          aggregatedQualityScore: 69,
          pegMultiplier: 1,
          baseAssetScore: 69,
          deploymentAdjustmentPoints: 0,
          deploymentAdjustedScore: 69,
          preCapScore: 69,
          publishedScore: 69,
        },
      },
    } as SafetyScoreV9CurrentCard;
    const quality = buildScoreWaterfall(card).find((step) => step.key === "quality");
    expect(quality?.detail).toContain("Backing, Exit, and Control");
    expect(quality?.detail).not.toContain("renormalized");
  });

  it("returns nothing when the asset is not rated", () => {
    expect(buildScoreWaterfall(cardWithStages({ aggregatedQualityScore: null, publishedScore: null }))).toEqual([]);
  });
});
