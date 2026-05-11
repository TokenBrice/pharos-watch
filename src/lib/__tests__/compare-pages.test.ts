import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins";
import {
  buildComparisonAtAGlanceRows,
  getPrimaryStaticComparisonPageForCoin,
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
  it("excludes any pair containing a frozen coin", () => {
    for (const page of STATIC_COMPARISON_PAGES) {
      expect(FROZEN_IDS.has(page.left.id)).toBe(false);
      expect(FROZEN_IDS.has(page.right.id)).toBe(false);
    }
  });
});
