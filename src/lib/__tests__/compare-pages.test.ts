import { describe, expect, it } from "vitest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import {
  buildComparisonAtAGlanceRows,
  buildComparisonSnippetAnswer,
  buildStaticComparisonJsonLd,
  STATIC_COMPARE_PAIRS,
  STATIC_COMPARISON_PAGE_BY_SLUG,
  STATIC_COMPARISON_PAGES,
} from "@/lib/compare-pages";

describe("compare page blacklist copy", () => {
  it("surfaces upstream FreezeWatch status in static comparison copy", () => {
    const page = STATIC_COMPARISON_PAGE_BY_SLUG.get("sdai-sky-vs-susde-ethena");

    expect(page).toBeDefined();

    const rows = buildComparisonAtAGlanceRows(page!);
    const blacklistRow = rows.find((row) => row.label === "Blacklist controls");

    expect(blacklistRow).toBeDefined();
    expect(
      blacklistRow?.left === "Upstream freeze exposure" || blacklistRow?.right === "Upstream freeze exposure",
    ).toBe(true);
  });
});

describe("STATIC_COMPARISON_PAGES", () => {
  it("keeps the static pair set capped", () => {
    // The cap is a deliberate brake on programmatic expansion: pairs ship in
    // reviewed, demand-led batches (SEO growth plan 2026-07-09, P1.3), never
    // as blanket N×N generation. Raise it consciously with each batch.
    expect(STATIC_COMPARE_PAIRS.length).toBeLessThanOrEqual(60);
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
    const page = STATIC_COMPARISON_PAGE_BY_SLUG.get("usdt-tether-vs-usdc-circle");

    expect(page).toBeDefined();

    const snippet = buildComparisonSnippetAnswer(page!);

    expect(snippet.question).toBe("Which is safer, USDT or USDC?");
    expect(snippet.answer).toContain("categorically safer");
    expect(snippet.caveat).toContain("Open the live USDT vs USDC compare tool");
  });

  it("builds WebPage and ItemList JSON-LD for static comparison pages", () => {
    const page = STATIC_COMPARISON_PAGE_BY_SLUG.get("usdt-tether-vs-usdc-circle");

    expect(page).toBeDefined();

    const jsonLd = buildStaticComparisonJsonLd(page!, {
      siteUrl: "https://pharos.watch",
    });

    expect(jsonLd).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "WebPage",
          "@id": "https://pharos.watch/compare/usdt-tether-vs-usdc-circle/#webpage",
          about: expect.arrayContaining([
            expect.objectContaining({
              "@id": "https://pharos.watch/stablecoin/usdt-tether/#stablecoin",
              alternateName: "USDT",
            }),
            expect.objectContaining({
              "@id": "https://pharos.watch/stablecoin/usdc-circle/#stablecoin",
              alternateName: "USDC",
            }),
          ]),
        }),
        expect.objectContaining({
          "@type": "ItemList",
          "@id": "https://pharos.watch/compare/usdt-tether-vs-usdc-circle/#comparison-rows",
          numberOfItems: expect.any(Number),
          itemListElement: expect.arrayContaining([
            expect.objectContaining({
              item: expect.objectContaining({
                "@type": "PropertyValue",
                name: "Governance",
              }),
            }),
          ]),
        }),
      ]),
    );
  });
});
