import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins";
import {
  buildComparisonAtAGlanceRows,
  getPrimaryStaticComparisonPageForCoin,
  STATIC_COMPARISON_PAGES,
} from "@/lib/compare-pages";

describe("compare page blacklist copy", () => {
  it("uses resolved blacklist status instead of raw metadata flags", () => {
    const page = getPrimaryStaticComparisonPageForCoin("usde-ethena");

    expect(page).not.toBeNull();

    const rows = buildComparisonAtAGlanceRows(page!);
    const blacklistRow = rows.find((row) => row.label === "Blacklist controls");

    expect(blacklistRow).toBeDefined();
    expect(blacklistRow?.left === "Upstream freeze exposure" || blacklistRow?.right === "Upstream freeze exposure").toBe(true);
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
