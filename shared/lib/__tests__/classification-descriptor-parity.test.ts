import { describe, expect, it } from "vitest";
import {
  getPysColor,
  getPysBarColor,
  STATUS_TONE,
  MINT_AUTHORITY_FILTER_VALUES,
  MINT_AUTHORITY_STATUS_CONFIG,
  MINT_AUTHORITY_SCORE_FILTER_VALUES,
  MINT_AUTHORITY_SCORE_FILTER_CONFIG,
  MINT_AUTHORITY_SCORE_DESCRIPTORS,
} from "@shared/lib/classification";
import { getPegDeviationLevel } from "../classification/peg-severity";

describe("classification descriptor semantics", () => {
  it.each([
    [20, "red"], [21, "amber"], [40, "amber"], [41, "emerald"],
  ] as const)("projects PYS %s text and gauge from the same band", (score, color) => {
    expect(getPysColor(score)).toBe(`text-${color}-700 dark:text-${color}-400`);
    expect(getPysBarColor(score)).toBe(`bg-${color}-500`);
  });

  it.each([null, undefined])("keeps unavailable PYS %s neutral", (score) => {
    expect(getPysColor(score)).toBe("text-muted-foreground");
    expect(getPysBarColor(score)).toBe("bg-muted-foreground/40");
  });

  it("keeps operational labels distinct and no probe separate from health", () => {
    expect([STATUS_TONE.healthy.label, STATUS_TONE.degraded.label, STATUS_TONE.stale.label])
      .toEqual(["Healthy", "Degraded", "Stale"]);
    expect(STATUS_TONE.unknown.label).toBe("No probe.");
  });

  it("covers every mint filter and projects its score descriptor", () => {
    expect(Object.keys(MINT_AUTHORITY_STATUS_CONFIG)).toEqual([...MINT_AUTHORITY_FILTER_VALUES]);
    expect(Object.keys(MINT_AUTHORITY_SCORE_DESCRIPTORS)).toEqual([...MINT_AUTHORITY_SCORE_FILTER_VALUES]);
    for (const key of MINT_AUTHORITY_SCORE_FILTER_VALUES) {
      const { label, detail } = MINT_AUTHORITY_SCORE_DESCRIPTORS[key];
      expect(MINT_AUTHORITY_SCORE_FILTER_CONFIG[key]).toEqual({ label, detail });
    }
  });

  it("buckets peg deviation on the engine's 50/200/500 bps cut-offs", () => {
    expect([0, 49.9, 50, 199, 200, 499, 500, 5000].map(getPegDeviationLevel)).toEqual([
      "healthy",
      "healthy",
      "mild",
      "mild",
      "moderate",
      "moderate",
      "severe",
      "severe",
    ]);
  });
});
