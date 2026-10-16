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
  MINT_PRESSURE_LABELS,
} from "@shared/lib/classification";
import { LAUNCH_MILESTONE_TYPE_VALUES, LAUNCH_PHASE_VALUES } from "../../types/core";
import { DDR_RESOLUTION_TIER_VALUES } from "../../types/depeg-resolver";
import { LiquidityCoverageClassSchema } from "../../types/market";
import { MintBurnCoverageStatusSchema } from "../../types/mint-burn";
import { YIELD_SOURCE_CONFIDENCE_TIER_VALUES } from "../../types/yield-vocabulary";
import { DDR_VERDICT_CLASSES } from "../classification/depeg";
import { FLOW_COVERAGE_BADGE_CLASSES, MINT_PRESSURE_TONE_CLASSES } from "../classification/flows";
import {
  PEG_DEVIATION_LEVEL_LABELS,
  PEG_DEVIATION_TONE_CLASSES,
  getPegDeviationLevel,
} from "../classification/peg-severity";
import { PRE_LAUNCH_MILESTONE_BADGE_CLASSES, PRE_LAUNCH_PHASE_CLASSES } from "../classification/pre-launch";
import {
  LIQUIDITY_COVERAGE_BADGE_CLASSES,
  YIELD_SOURCE_CONFIDENCE_CLASSES,
  YIELD_SOURCE_QUALITY_FILL_CLASSES,
} from "../classification/provenance";
import { SCORE_TIER_4_CLASSES, SCORE_TIER_5_CLASSES } from "../classification/score-tiers";
import { YIELD_RISK_BUDGET_CLASSES, YIELD_SERIES_FILL_CLASSES } from "../classification/yield";

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

  it("covers every level of each keyed vocabulary", () => {
    expect(Object.keys(PRE_LAUNCH_PHASE_CLASSES).sort()).toEqual([...LAUNCH_PHASE_VALUES].sort());
    expect(Object.keys(PRE_LAUNCH_MILESTONE_BADGE_CLASSES).sort()).toEqual([...LAUNCH_MILESTONE_TYPE_VALUES].sort());
    expect(Object.keys(YIELD_SOURCE_CONFIDENCE_CLASSES).sort()).toEqual([...YIELD_SOURCE_CONFIDENCE_TIER_VALUES].sort());
    expect(Object.keys(YIELD_SOURCE_QUALITY_FILL_CLASSES).sort()).toEqual([...YIELD_SOURCE_CONFIDENCE_TIER_VALUES].sort());
    expect(Object.keys(LIQUIDITY_COVERAGE_BADGE_CLASSES).sort()).toEqual([...LiquidityCoverageClassSchema.options].sort());
    expect(Object.keys(FLOW_COVERAGE_BADGE_CLASSES).sort()).toEqual(
      MintBurnCoverageStatusSchema.options.filter((status) => status !== "full" && status !== "disabled").sort(),
    );
    expect(Object.keys(MINT_PRESSURE_TONE_CLASSES).sort()).toEqual(Object.keys(MINT_PRESSURE_LABELS).sort());
    expect(Object.keys(DDR_VERDICT_CLASSES).sort()).toEqual(
      DDR_RESOLUTION_TIER_VALUES.filter((tier) => tier !== "insufficient_signal").sort(),
    );
    expect(Object.keys(PEG_DEVIATION_TONE_CLASSES)).toEqual(Object.keys(PEG_DEVIATION_LEVEL_LABELS));
    expect(Object.keys(SCORE_TIER_5_CLASSES)).toEqual(["t80", "t65", "t50", "t35", "t0"]);
    expect(Object.keys(SCORE_TIER_4_CLASSES)).toEqual(["t80", "t60", "t40", "t0"]);
    expect(Object.keys(YIELD_RISK_BUDGET_CLASSES)).toEqual(["conservative", "balanced", "opportunistic", "all"]);
    expect(YIELD_SERIES_FILL_CLASSES).toHaveLength(5);
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
