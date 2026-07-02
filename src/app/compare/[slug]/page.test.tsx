import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error jsdom lacks bundled TypeScript declarations in this dependency set.
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

function parseStaticDocument(html: string) {
  return new JSDOM(html).window.document;
}

function findLinkByText(document: Document, text: string) {
  return [...document.querySelectorAll("a")].find((link) =>
    (link.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(text),
  );
}

describe("StaticComparisonPage", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/compare-pages");
    vi.resetModules();
  });

  it("resolves coin card detail links by exact stablecoin id", async () => {
    vi.doMock("@/lib/compare-pages", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/compare-pages")>();
      const originalPage = actual.STATIC_COMPARISON_PAGE_BY_SLUG.get("usde-ethena-vs-susde-ethena");

      if (!originalPage) {
        throw new Error("Missing Ethena static comparison fixture");
      }

      const reversedPage = {
        ...originalPage,
        slug: "susde-ethena-vs-usde-ethena",
        href: "/compare/susde-ethena-vs-usde-ethena/",
        title: "sUSDe vs USDe: Risk, Reserves & Liquidity Compared",
        shortTitle: "sUSDe vs USDe",
        left: originalPage.right,
        right: originalPage.left,
      };

      return {
        ...actual,
        STATIC_COMPARISON_PAGES: [reversedPage],
        STATIC_COMPARISON_PAGE_BY_SLUG: new Map([[reversedPage.slug, reversedPage]]),
      };
    });

    const { default: StaticComparisonPage } = await import("./page");
    const html = renderToStaticMarkup(
      await StaticComparisonPage({ params: Promise.resolve({ slug: "susde-ethena-vs-usde-ethena" }) }),
    );
    const document = parseStaticDocument(html);

    expect(findLinkByText(document, "Open sUSDe detail page")?.getAttribute("href")).toBe("/stablecoin/susde-ethena");
    expect(findLinkByText(document, "Open USDe detail page")?.getAttribute("href")).toBe("/stablecoin/usde-ethena");
  }, 15_000);
});
