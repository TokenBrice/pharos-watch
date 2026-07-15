import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TIER_TEXT,
  deviationBgClass,
  deviationColorClass,
  deviationColorHex,
  deviationIconName,
  getDurabilityBgColor,
  getDurabilityColor,
  getScoreColor,
  getScoreTier,
  pegScoreColor,
  scoreToColorClass,
} from "../severity-colors";
import * as featureFlags from "@/lib/feature-flags";

describe("severity-colors", () => {
  it("maps deviation thresholds to classes, hex values, and icons", () => {
    expect(deviationColorClass(49)).toBe(
      featureFlags.FEATURE_FLAGS.quietDeviations
        ? "text-muted-foreground"
        : "text-green-700 dark:text-green-400",
    );
    expect(deviationBgClass(49)).toBe("bg-green-500");
    expect(deviationColorHex(49)).toBe("#22c55e");
    expect(deviationIconName(49)).toBe("CircleCheck");

    expect(deviationColorClass(50)).toBe("text-amber-700 dark:text-amber-400");
    expect(deviationBgClass(199)).toBe("bg-amber-500");
    expect(deviationColorHex(199)).toBe("#f59e0b");
    expect(deviationIconName(199)).toBe("TriangleAlert");

    expect(deviationColorClass(200)).toBe("text-orange-700 dark:text-orange-400");
    expect(deviationBgClass(499)).toBe("bg-orange-500");
    expect(deviationColorHex(499)).toBe("#f97316");
    expect(deviationIconName(499)).toBe("OctagonAlert");

    expect(deviationColorClass(500)).toBe("text-red-700 dark:text-red-400");
    expect(deviationBgClass(500)).toBe("bg-red-500");
    expect(deviationColorHex(500)).toBe("#ef4444");
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

  it("maps peg and durability score thresholds", () => {
    expect(pegScoreColor(null)).toBe("text-muted-foreground");
    expect(pegScoreColor(90)).toBe("text-green-700 dark:text-green-400");
    expect(pegScoreColor(70)).toBe("text-amber-700 dark:text-amber-400");
    expect(pegScoreColor(69)).toBe("text-red-700 dark:text-red-400");

    expect(getDurabilityColor(70)).toBe("text-emerald-700 dark:text-emerald-400");
    expect(getDurabilityColor(40)).toBe("text-amber-700 dark:text-amber-400");
    expect(getDurabilityColor(39)).toBe("text-red-700 dark:text-red-400");

    expect(getDurabilityBgColor(70)).toBe("bg-emerald-500");
    expect(getDurabilityBgColor(40)).toBe("bg-amber-500");
    expect(getDurabilityBgColor(39)).toBe("bg-red-500");
  });

  it("supports parametric score color mapping", () => {
    expect(scoreToColorClass(65, [
      { min: 80, className: "high" },
      { min: 50, className: "mid" },
      { min: Number.NEGATIVE_INFINITY, className: "low" },
    ])).toBe("mid");
    expect(scoreToColorClass(null, [{ min: 0, className: "x" }], "fallback")).toBe("fallback");
  });

  describe("with quietDeviations flag enabled", () => {
    beforeEach(() => {
      vi.spyOn(featureFlags, "isQuietDeviationsEnabled").mockReturnValue(true);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns muted-foreground below the GREEN threshold and keeps higher tiers", () => {
      expect(deviationColorClass(0)).toBe("text-muted-foreground");
      expect(deviationColorClass(49)).toBe("text-muted-foreground");
      expect(deviationColorClass(50)).toBe("text-amber-700 dark:text-amber-400");
      expect(deviationColorClass(199)).toBe("text-amber-700 dark:text-amber-400");
      expect(deviationColorClass(200)).toBe("text-orange-700 dark:text-orange-400");
      expect(deviationColorClass(499)).toBe("text-orange-700 dark:text-orange-400");
      expect(deviationColorClass(500)).toBe("text-red-700 dark:text-red-400");
    });
  });
});
