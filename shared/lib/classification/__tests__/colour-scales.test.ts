import { describe, expect, it } from "vitest";
import { LAUNCH_MILESTONE_TYPE_VALUES, LAUNCH_PHASE_VALUES } from "../../../types/core";
import { DDR_RESOLUTION_TIER_VALUES } from "../../../types/depeg-resolver";
import { LiquidityCoverageClassSchema } from "../../../types/market";
import { MintBurnCoverageStatusSchema } from "../../../types/mint-burn";
import { YIELD_SOURCE_CONFIDENCE_TIER_VALUES } from "../../../types/yield-vocabulary";
import { COLLATERAL_COVERAGE_ARROW_CLASSES, MINT_PRESSURE_LABELS } from "../../classification";
import { YIELD_ZONE_OUTLIER_DOT_CLASS, YIELD_ZONE_STYLES } from "../badges";
import {
  CHAIN_SWATCH_CLASSES,
  CHAIN_VM_BADGE_CLASSES,
  DEX_FALLBACK_SWATCH_CLASSES,
  DEX_PROTOCOL_SWATCH_CLASSES,
  ORACLE_BRAND_SWATCH_CLASSES,
} from "../brand";
import {
  COVERAGE_AUTHORITATIVE_ACCENT_CLASSES,
  COVERAGE_BADGE_TONE_CLASSES,
  COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  COVERAGE_BREAKDOWN_TONE_CLASSES,
  COVERAGE_FEATURE_ACCENT_CLASSES,
  FEATURE_IDENTITY_CLASSES,
  HTTP_METHOD_BADGE_CLASSES,
  METHODOLOGY_SECTION_ACCENT_CLASSES,
  METHODOLOGY_TABLE_ACCENT_CLASSES,
  STATUS_RELIABILITY_ACCENT_CLASSES,
} from "../coverage";
import {
  DDR_KILL_SAVE_CLASSES,
  DDR_OUTCOME_CLASSES,
  DDR_REVIEW_TONE_CLASSES,
  DDR_TIMELINE_CLASSES,
  DDR_VERDICT_CLASSES,
  DEPEG_DIRECTION_CLASSES,
  DEPEG_LIVE_PING_CLASS,
  DEPEG_ROW_STATUS_CLASSES,
} from "../depeg";
import {
  FLOW_COVERAGE_BADGE_CLASSES,
  FLOW_EVENT_BADGE_CLASSES,
  FLOW_RECEIPT_TONE_CLASSES,
  MINT_GAUGE_ZONE_TEXT_CLASSES,
  MINT_PRESSURE_TONE_CLASSES,
} from "../flows";
import {
  DIRECTION_CHIP_CLASSES,
  DIRECTION_TONE_CLASSES,
  PEG_DEVIATION_LEVEL_LABELS,
  PEG_DEVIATION_TONE_CLASSES,
  QUALITY_TIER_3_CLASSES,
  getPegDeviationLevel,
} from "../peg-severity";
import {
  PRE_LAUNCH_ACCENT_CLASSES,
  PRE_LAUNCH_DRIFT_BADGE_CLASSES,
  PRE_LAUNCH_MILESTONE_BADGE_CLASSES,
  PRE_LAUNCH_PHASE_CLASSES,
} from "../pre-launch";
import {
  COVERAGE_GAP_OWNER_SWATCH_CLASSES,
  LIQUIDITY_COVERAGE_BADGE_CLASSES,
  PRICE_SOURCE_STATUS_CLASSES,
  REQUEST_SOURCE_FILL_CLASSES,
  YIELD_ATTRIBUTION_TONE_CLASSES,
  YIELD_DATA_SOURCE_BADGE_CLASSES,
  YIELD_SOURCE_CONFIDENCE_CLASSES,
  YIELD_SOURCE_DEPTH_FILL_CLASSES,
  YIELD_SOURCE_QUALITY_FILL_CLASSES,
} from "../provenance";
import { PSI_LANE_TONE_CLASSES } from "../psi";
import { THREAT_BAND_ACCENT_CLASSES } from "../risk";
import {
  CASE_STUDY_OUTCOME_CLASSES,
  CUSTODY_STATE_CLASSES,
  SAFETY_BREAKDOWN_ROW_TONE_TEXT_CLASSES,
  SCORE_TIER_4_CLASSES,
  SCORE_TIER_5_CLASSES,
  SEVERITY_NAMED_TONE_CLASSES,
} from "../score-tiers";
import { YIELD_RISK_BUDGET_CLASSES, YIELD_SERIES_FILL_CLASSES } from "../yield";

const SCALES: Record<string, unknown> = {
  COLLATERAL_COVERAGE_ARROW_CLASSES,
  YIELD_ZONE_STYLES,
  YIELD_ZONE_OUTLIER_DOT_CLASS,
  CHAIN_SWATCH_CLASSES,
  CHAIN_VM_BADGE_CLASSES,
  DEX_FALLBACK_SWATCH_CLASSES,
  DEX_PROTOCOL_SWATCH_CLASSES,
  ORACLE_BRAND_SWATCH_CLASSES,
  COVERAGE_AUTHORITATIVE_ACCENT_CLASSES,
  COVERAGE_BADGE_TONE_CLASSES,
  COVERAGE_BREAKDOWN_TONE_CLASSES,
  COVERAGE_FEATURE_ACCENT_CLASSES,
  FEATURE_IDENTITY_CLASSES,
  HTTP_METHOD_BADGE_CLASSES,
  METHODOLOGY_SECTION_ACCENT_CLASSES,
  METHODOLOGY_TABLE_ACCENT_CLASSES,
  STATUS_RELIABILITY_ACCENT_CLASSES,
  DDR_KILL_SAVE_CLASSES,
  DDR_OUTCOME_CLASSES,
  DDR_REVIEW_TONE_CLASSES,
  DDR_TIMELINE_CLASSES,
  DDR_VERDICT_CLASSES,
  DEPEG_DIRECTION_CLASSES,
  DEPEG_LIVE_PING_CLASS,
  DEPEG_ROW_STATUS_CLASSES,
  FLOW_COVERAGE_BADGE_CLASSES,
  FLOW_EVENT_BADGE_CLASSES,
  FLOW_RECEIPT_TONE_CLASSES,
  MINT_GAUGE_ZONE_TEXT_CLASSES,
  MINT_PRESSURE_TONE_CLASSES,
  DIRECTION_CHIP_CLASSES,
  DIRECTION_TONE_CLASSES,
  PEG_DEVIATION_TONE_CLASSES,
  QUALITY_TIER_3_CLASSES,
  PRE_LAUNCH_ACCENT_CLASSES,
  PRE_LAUNCH_DRIFT_BADGE_CLASSES,
  PRE_LAUNCH_MILESTONE_BADGE_CLASSES,
  PRE_LAUNCH_PHASE_CLASSES,
  COVERAGE_GAP_OWNER_SWATCH_CLASSES,
  LIQUIDITY_COVERAGE_BADGE_CLASSES,
  PRICE_SOURCE_STATUS_CLASSES,
  REQUEST_SOURCE_FILL_CLASSES,
  YIELD_ATTRIBUTION_TONE_CLASSES,
  YIELD_DATA_SOURCE_BADGE_CLASSES,
  YIELD_SOURCE_CONFIDENCE_CLASSES,
  YIELD_SOURCE_DEPTH_FILL_CLASSES,
  YIELD_SOURCE_QUALITY_FILL_CLASSES,
  PSI_LANE_TONE_CLASSES,
  THREAT_BAND_ACCENT_CLASSES,
  CASE_STUDY_OUTCOME_CLASSES,
  CUSTODY_STATE_CLASSES,
  SAFETY_BREAKDOWN_ROW_TONE_TEXT_CLASSES,
  SCORE_TIER_4_CLASSES,
  SCORE_TIER_5_CLASSES,
  SEVERITY_NAMED_TONE_CLASSES,
  YIELD_RISK_BUDGET_CLASSES,
  YIELD_SERIES_FILL_CLASSES,
};

/** Class strings that are light-only by design (dark text on a light fill, an SVG `currentColor`). */
const LIGHT_ONLY_CLASS_STRINGS = new Set<string>([COVERAGE_BAR_TEXT_ON_LIGHT_CLASS, DDR_TIMELINE_CLASSES.terminalGlyph]);

/** Identity hues are data, not classes. */
const NON_CLASS_KEYS = new Set(["hue"]);

function collectClassStrings(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === "string") {
    out.push([path, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectClassStrings(entry, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (!NON_CLASS_KEYS.has(key)) collectClassStrings(entry, `${path}.${key}`, out);
    }
    return;
  }
  throw new Error(`${path} is not a class string`);
}

const CLASS_STRINGS: Array<[string, string]> = [];
for (const [name, scale] of Object.entries(SCALES)) collectClassStrings(scale, name, CLASS_STRINGS);

const STATIC_CLASS_TOKEN = /^[a-z0-9\-:/[\]._(),%]+$/i;
const PALETTE_HUES = new Set([
  "slate", "zinc", "neutral", "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald",
  "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
]);

/** `text-X-700` → "dark:text-", `hover:text-X-700` → "dark:hover:text-", anything else → null. */
function requiredDarkPrefix(token: string): string | null {
  const hover = token.startsWith("hover:");
  const parts = (hover ? token.slice("hover:".length) : token).split("-");
  if (parts[0] !== "text" || !PALETTE_HUES.has(parts[1] ?? "")) return null;
  return hover ? "dark:hover:text-" : "dark:text-";
}

describe("classification colour scales", () => {
  it("holds only complete static Tailwind tokens", () => {
    for (const [path, classes] of CLASS_STRINGS) {
      for (const token of classes.split(" ").filter(Boolean)) {
        expect(token, `${path}: ${token}`).toMatch(STATIC_CLASS_TOKEN);
        expect(token, `${path}: ${token}`).not.toContain("${");
      }
      expect(classes, path).toBe(classes.trim());
    }
  });

  it("gives every light palette text colour a dark twin", () => {
    for (const [path, classes] of CLASS_STRINGS) {
      if (LIGHT_ONLY_CLASS_STRINGS.has(classes)) continue;
      for (const token of classes.split(" ")) {
        const darkPrefix = requiredDarkPrefix(token);
        if (darkPrefix) expect(classes, `${path} lacks a ${darkPrefix} twin`).toContain(darkPrefix);
      }
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

  it("projects /coverage and /methodology accents from one feature identity", () => {
    for (const [feature, accent] of Object.entries(COVERAGE_FEATURE_ACCENT_CLASSES)) {
      const { hue } = FEATURE_IDENTITY_CLASSES[feature as keyof typeof COVERAGE_FEATURE_ACCENT_CLASSES];
      expect(accent.chip, feature).toContain(`border-${hue}`);
      expect(accent.countBar, feature).toContain(`bg-${hue}`);
    }
    const hovers = new Set(Object.values(FEATURE_IDENTITY_CLASSES).map((identity) => identity.changelogHover));
    for (const [section, accent] of Object.entries(METHODOLOGY_SECTION_ACCENT_CLASSES)) {
      expect(hovers.has(accent.changelogHover), section).toBe(true);
    }
  });

  it("applies the owner's canonical spellings", () => {
    // C7: one depeg pill spelling, dark text 400; DANGER rows tint red.
    for (const { pill } of Object.values(DEPEG_ROW_STATUS_CLASSES)) expect(pill).toMatch(/\/30 .*\/10 .*-700 dark:text-\w+-400$/);
    expect(THREAT_BAND_ACCENT_CLASSES.DANGER.rowTint).toContain("bg-red-500");
    // C10: unavailable/fallback provenance is muted, not slate.
    expect(YIELD_SOURCE_CONFIDENCE_CLASSES.fallback.pill).not.toContain("slate");
    expect(LIQUIDITY_COVERAGE_BADGE_CLASSES.legacy).not.toContain("slate");
    expect(PRICE_SOURCE_STATUS_CLASSES.available.dot).toBe("bg-sky-500");
    // C1 and C6: direction "up" is green, score ramps' "good" is emerald.
    expect(DIRECTION_TONE_CLASSES.up).toBe("text-green-700 dark:text-green-400");
    expect(QUALITY_TIER_3_CLASSES.good.text).toBe("text-emerald-700 dark:text-emerald-400");
    // C13: "died" keeps rose at the house 700 text shade.
    expect(CASE_STUDY_OUTCOME_CLASSES.died.text).toBe("text-rose-700 dark:text-rose-400");
  });
});
