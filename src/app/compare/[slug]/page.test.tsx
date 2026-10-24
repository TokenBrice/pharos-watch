// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getStaticComparisonPagesForCoin, STATIC_COMPARISON_PAGE_BY_SLUG } from "@/lib/compare-pages";
import ComparePairPage from "./page";

async function renderPair(slug: string) {
  const html = renderToStaticMarkup(await ComparePairPage({ params: Promise.resolve({ slug }) }));
  return new DOMParser().parseFromString(html, "text/html");
}

describe("ComparePairPage", () => {
  it("links every other curated pair for each coin, excluding the current one", async () => {
    const slug = "usdt-tether-vs-usdc-circle";
    const document = await renderPair(slug);
    const section = document.getElementById("related-comparisons-title")?.closest("section");
    expect(section).not.toBeNull();

    const headings = [...section!.querySelectorAll("h3")].map((heading) => heading.textContent);
    expect(headings).toEqual(["More USDT comparisons", "More USDC comparisons"]);

    const hrefs = [...section!.querySelectorAll("a[href]")].map((link) => link.getAttribute("href") ?? "");
    expect(hrefs.some((href) => href.includes(slug))).toBe(false);
    for (const coinId of ["usdt-tether", "usdc-circle"]) {
      for (const page of getStaticComparisonPagesForCoin(coinId).filter((candidate) => candidate.slug !== slug)) {
        expect(hrefs.some((href) => href.includes(`/compare/${page.slug}`)), page.slug).toBe(true);
      }
    }
    // Anchor text is the pair's "{A} vs {B}" short title.
    expect(section!.textContent).toContain("USDT vs USDe");
  });

  it.each([
    "jpyc-jpyc-vs-jpysc-sbi-startale",
    "usdy-ondo-finance-vs-usyc-hashnote",
    "eurc-circle-vs-eurcv-societe-generale-forge",
    "xaut-tether-vs-xaum-matrixdock",
    "usd1-world-liberty-financial-vs-usdt-tether",
    "brla-brla-digital-vs-brl1-brl1",
    "gho-aave-vs-sgho-aave",
    "usdf-falcon-vs-susdf-falcon",
    "apxusd-apyx-vs-apyusd-apyx",
  ])("registers the sibling-demand pair %s", async (slug) => {
    expect(STATIC_COMPARISON_PAGE_BY_SLUG.has(slug)).toBe(true);
    const document = await renderPair(slug);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    const page = STATIC_COMPARISON_PAGE_BY_SLUG.get(slug)!;
    const hasOtherPair = [page.left.id, page.right.id].some((coinId) =>
      getStaticComparisonPagesForCoin(coinId).some((candidate) => candidate.slug !== slug),
    );
    // The section only renders when either coin has another curated pair.
    expect(document.getElementById("related-comparisons-title") !== null).toBe(hasOtherPair);
  });
});
