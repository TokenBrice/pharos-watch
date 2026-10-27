import { describe, expect, it } from "vitest";
import {
  TIER_TEXT,
  deviationBgClass,
  deviationColorClass,
  deviationIconName,
  getDurabilityBgColor,
  getDurabilityColor,
  getScoreColor,
  getScoreTier,
  pegScoreColor,
} from "../severity-colors";
import { getPegScoreTier, QUALITY_TIER_3_CLASSES } from "@shared/lib/classification";
import { metricTone } from "@/components/depeg-board-model";
import * as featureFlags from "@/lib/feature-flags";

describe("severity-colors", () => {
  it("maps deviation thresholds to classes and icons", () => {
    expect(deviationColorClass(49)).toBe(
      featureFlags.FEATURE_FLAGS.quietDeviations
        ? "text-muted-foreground"
        : "text-green-700 dark:text-green-400",
    );
    expect(deviationBgClass(49)).toBe("bg-green-500");
    expect(deviationIconName(49)).toBe("CircleCheck");

    expect(deviationColorClass(50)).toBe("text-amber-700 dark:text-amber-400");
    expect(deviationBgClass(199)).toBe("bg-amber-500");
    expect(deviationIconName(199)).toBe("TriangleAlert");

    expect(deviationColorClass(200)).toBe("text-orange-700 dark:text-orange-400");
    expect(deviationBgClass(499)).toBe("bg-orange-500");
    expect(deviationIconName(499)).toBe("OctagonAlert");

    expect(deviationColorClass(500)).toBe("text-red-700 dark:text-red-400");
    expect(deviationBgClass(500)).toBe("bg-red-500");
    expect(deviationIconName(500)).toBe("CircleX");
  });

  it("maps score tiers and tier color constants", () => {
    expect(getScoreTier(80)).toBe("green");
    expect(getScoreTier(60)).toBe("blue");
    expect(getScoreTier(40)).toBe("amber");
    expect(getScoreTier(39)).toBe("red");

    expect(getScoreColor(85)).toBe(TIER_TEXT.green);
    expect(getScoreColor(65)).toBe(TIER_TEXT.blue);
    expect(getScoreColor(45)).toBe(TIER_TEXT.amber);
    expect(getScoreColor(5)).toBe(TIER_TEXT.red);
  });

  it.each([
    [60, "bad"], [69, "bad"], [70, "watch"], [85, "watch"], [89, "watch"], [90, "good"], [0, "bad"],
    [null, null], [undefined, null], [Number.NaN, null],
  ] as const)("uses one peg-score tier for text and gauge at %s", (score, tier) => {
    expect(getPegScoreTier(score)).toBe(tier);
    expect(metricTone(score)).toBe(tier ? QUALITY_TIER_3_CLASSES[tier].bar : "bg-muted-foreground");
    if (score !== undefined) {
      expect(pegScoreColor(score)).toBe(tier ? QUALITY_TIER_3_CLASSES[tier].text : "text-muted-foreground");
    }
  });

  it("maps peg and durability score thresholds", () => {
    expect(pegScoreColor(null)).toBe("text-muted-foreground");
    expect(pegScoreColor(90)).toBe("text-emerald-700 dark:text-emerald-400");
    expect(pegScoreColor(70)).toBe("text-amber-700 dark:text-amber-400");
    expect(pegScoreColor(69)).toBe("text-red-700 dark:text-red-400");

    expect(getDurabilityColor(70)).toBe("text-emerald-700 dark:text-emerald-400");
    expect(getDurabilityColor(40)).toBe("text-amber-700 dark:text-amber-400");
    expect(getDurabilityColor(39)).toBe("text-red-700 dark:text-red-400");

    expect(getDurabilityBgColor(70)).toBe("bg-state-positive-solid");
    expect(getDurabilityBgColor(40)).toBe("bg-state-warn-solid");
    expect(getDurabilityBgColor(39)).toBe("bg-state-danger-solid");
  });

});
