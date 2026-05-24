import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import {
  buildComparisonAtAGlanceRows,
  buildComparisonSnippetAnswer,
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

  it("includes bounded high-intent non-core comparisons without generating every pair", () => {
    expect(STATIC_COMPARE_PAIRS).toContainEqual(["usde-ethena", "susde-ethena"]);
    expect(STATIC_COMPARE_PAIRS).toContainEqual(["lusd-liquity", "bold-liquity"]);
    expect(STATIC_COMPARE_PAIRS).toContainEqual(["paxg-paxos", "xaut-tether"]);
    expect(STATIC_COMPARE_PAIRS).toContainEqual(["eurc-circle", "eurs-stasis"]);
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

  it("builds a visible short-answer module with live-data caveats", () => {
    const page = getPrimaryStaticComparisonPageForCoin("usdt-tether");

    expect(page).not.toBeNull();

    const snippet = buildComparisonSnippetAnswer(page!);

    expect(snippet.question).toBe("Which is safer, USDT or USDC?");
    expect(snippet.answer).toContain("categorically safer");
    expect(snippet.caveat).toContain("Open the live USDT vs USDC compare tool");
  });
});
