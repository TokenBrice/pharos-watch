import { describe, expect, it } from "vitest";
import {
  BACKING_LABELS,
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS,
  GOVERNANCE_LABELS_SHORT,
  THREAT_BAND_LABELS,
  getPysColor,
  getPysBarColor,
  STATUS_TONE,
  MINT_AUTHORITY_FILTER_VALUES,
  MINT_AUTHORITY_STATUS_CONFIG,
  MINT_AUTHORITY_SCORE_FILTER_VALUES,
  MINT_AUTHORITY_SCORE_FILTER_CONFIG,
  MINT_AUTHORITY_SCORE_DESCRIPTORS,
} from "@shared/lib/classification";
import { GENIUS_STATUS_SHORT_LABELS } from "@shared/lib/genius";
import { MICA_STATUS_BADGE_STYLES } from "@shared/lib/mica";

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

  it("preserves the existing non-finite PYS projections", () => {
    expect(getPysColor(Number.NaN)).toBe("text-muted-foreground");
    expect(getPysBarColor(Number.NaN)).toBe("bg-red-500");
    expect(getPysColor(Number.NEGATIVE_INFINITY)).toContain("red");
    expect(getPysBarColor(Number.POSITIVE_INFINITY)).toBe("bg-emerald-500");
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

  it("keeps DEWS severity labels distinguishable", () => {
    expect(new Set(Object.values(THREAT_BAND_LABELS)).size).toBe(Object.keys(THREAT_BAND_LABELS).length);
  });

  it.each([
    BACKING_LABELS,
    BACKING_LABELS_SHORT,
    GOVERNANCE_LABELS,
    GOVERNANCE_LABELS_SHORT,
  ])("keeps classification options distinguishable", (labels) => {
    expect(new Set(Object.values(labels)).size).toBe(Object.keys(labels).length);
  });

  it("distinguishes authorization outcomes without freezing editorial wording", () => {
    expect(new Set(Object.values(GENIUS_STATUS_SHORT_LABELS)).size)
      .toBe(Object.keys(GENIUS_STATUS_SHORT_LABELS).length);
    expect(new Set(Object.values(MICA_STATUS_BADGE_STYLES).map((badge) => badge.label)).size)
      .toBe(Object.keys(MICA_STATUS_BADGE_STYLES).length);
  });
});
