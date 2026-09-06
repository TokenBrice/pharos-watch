// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

function parseStaticDocument(html: string) {
  const parsed = document.implementation.createHTMLDocument();
  parsed.documentElement.innerHTML = html;
  return parsed;
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

  it.each([
    ["usdc-circle-vs-usdg-paxos", "How do USDC and USDG reserves compare?", "https://www.circle.com/usdc"],
    ["usde-ethena-vs-susde-ethena", "Why can one sUSDe be worth more than one USDe?", "https://docs.ethena.fi/solution-design/staking-usde"],
    ["paxg-paxos-vs-xaut-tether", "What gold claim does each token represent?", "https://gold.tether.to/legal/"],
  ])("server-renders sourced answers for %s", async (slug, question, source) => {
    const { default: StaticComparisonPage } = await import("./page");
    const html = renderToStaticMarkup(await StaticComparisonPage({ params: Promise.resolve({ slug }) }));
    const document = parseStaticDocument(html);
    expect(document.querySelector("#comparison-differences-title")?.textContent).toBe("What differs in practice");
    expect([...document.querySelectorAll("h3")].some((heading) => heading.textContent === question)).toBe(true);
    expect(document.querySelector(`a[href="${source}"]`)).not.toBeNull();
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe("2026-09-06");
    const faq = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((script) => JSON.parse(script.textContent ?? "{}"))
      .find((json) => json["@type"] === "FAQPage");
    expect(document.querySelector("details p")?.textContent).toBe(faq.mainEntity[0].acceptedAnswer.text);
  }, 30_000);

  it("does not imply source checking for a metadata-only comparison", async () => {
    const { default: StaticComparisonPage } = await import("./page");
    const document = parseStaticDocument(renderToStaticMarkup(
      await StaticComparisonPage({ params: Promise.resolve({ slug: "usdt-tether-vs-usdc-circle" }) }),
    ));
    expect(document.querySelector("#comparison-differences-title")).toBeNull();
    expect(document.querySelector("time")).toBeNull();
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
    const liveCompareUrl = new URL(findLinkByText(document, "Open live compare")!.getAttribute("href")!, "https://pharos.watch");
    expect(liveCompareUrl.searchParams.get("coins")).toBe("susde-ethena,usde-ethena");
    expect(findLinkByText(document, "Telegram alerts")?.getAttribute("href")).toBe("/pharoswatchbot#getting-started");
    expect(findLinkByText(document, "Watchlist preset")).toBeUndefined();
  }, 30_000);
});
