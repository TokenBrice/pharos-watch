import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import {
  buildComparisonAtAGlanceRows,
  getPrimaryStaticComparisonPageForCoin,
  STATIC_COMPARE_PAIRS,
  STATIC_COMPARISON_PAGES,
} from "@/lib/compare-pages";

describe("compare page blacklist copy", () => {
  it("surfaces Dilutable status in static comparison copy", () => {
    const page = getPrimaryStaticComparisonPageForCoin("usde-ethena");

    expect(page).not.toBeNull();

    const rows = buildComparisonAtAGlanceRows(page!);
    const blacklistRow = rows.find((row) => row.label === "Blacklist controls");

    expect(blacklistRow).toBeDefined();
    expect(
      blacklistRow?.left === "Admin can dilute holders via unbounded mint" ||
        blacklistRow?.right === "Admin can dilute holders via unbounded mint",
    ).toBe(true);
  });
});

describe("STATIC_COMPARISON_PAGES", () => {
  it("keeps the static pair set capped", () => {
    expect(STATIC_COMPARE_PAIRS.length).toBeLessThanOrEqual(30);
  });

  it("does not define any pair containing a frozen coin", () => {
    for (const [leftId, rightId] of STATIC_COMPARE_PAIRS) {
      expect(FROZEN_IDS.has(leftId)).toBe(false);
      expect(FROZEN_IDS.has(rightId)).toBe(false);
    }
  });

  it("does not define duplicate static comparison slugs", () => {
    const slugs = STATIC_COMPARE_PAIRS.map(([leftId, rightId]) => `${leftId}-vs-${rightId}`);

    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("does not define the same pair in reverse order", () => {
    const canonicalPairs = STATIC_COMPARE_PAIRS.map((pair) => [...pair].sort().join("::"));

    expect(new Set(canonicalPairs).size).toBe(canonicalPairs.length);
  });

  it("generates a page for each static pair", () => {
    expect(STATIC_COMPARISON_PAGES).toHaveLength(STATIC_COMPARE_PAIRS.length);
  });
});
