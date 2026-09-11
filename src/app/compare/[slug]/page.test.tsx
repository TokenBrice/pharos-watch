// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

// Controlled editorial fixtures: page contracts below are asserted against
// these objects, so legitimate content refreshes cannot break the tests.
const CONTROLLED_EDITORIAL = {
  updatedAt: "2030-01-31",
  sourcesCheckedAt: "2030-01-31",
  intro: "CONTROLLED editorial intro for the fixture pair.",
  answer: "CONTROLLED short answer for the fixture pair.",
  sections: [
    {
      question: "CONTROLLED QUESTION ONE",
      answer: "CONTROLLED ANSWER ONE",
      sources: [{ label: "Controlled source A", href: "https://example.test/source-a" }],
    },
    {
      question: "CONTROLLED QUESTION TWO",
      answer: "CONTROLLED ANSWER TWO",
      sources: [{ label: "Controlled source B", href: "https://example.test/source-b" }],
    },
  ],
};

vi.doMock("@/lib/compare-pages", async (importOriginal) => {
  // vitest mock factories run before static imports, so the module type can
  // only be referenced through the dynamic import helper here.
  const actual = await importOriginal<typeof import("@/lib/compare-pages")>();
  const base = actual.STATIC_COMPARISON_PAGE_BY_SLUG.get("usde-ethena-vs-susde-ethena");

  if (!base) {
    throw new Error("Missing Ethena static comparison fixture");
  }

  const editorialPage = {
    ...base,
    slug: "alpha-pair-vs-beta-pair",
    href: "/compare/alpha-pair-vs-beta-pair/",
    title: "Alpha Pair vs Beta Pair: Risk, Reserves & Liquidity Compared",
    intro: CONTROLLED_EDITORIAL.intro,
    shortTitle: "Alpha vs Beta",
    editorial: CONTROLLED_EDITORIAL,
  };
  const metadataOnlyPage = {
    ...base,
    slug: "meta-only-pair",
    href: "/compare/meta-only-pair/",
    title: "Meta Only Pair: Risk, Reserves & Liquidity Compared",
    shortTitle: "Meta vs Only",
    editorial: undefined,
  };

  return {
    ...actual,
    STATIC_COMPARISON_PAGES: [editorialPage, metadataOnlyPage],
    STATIC_COMPARISON_PAGE_BY_SLUG: new Map<string, typeof editorialPage | typeof metadataOnlyPage>([
      [editorialPage.slug, editorialPage],
      [metadataOnlyPage.slug, metadataOnlyPage],
    ]),
  };
});

// Mock isolation requires importing the page after the doMock above; a single
let StaticComparisonPage: (typeof import("./page"))["default"];

beforeAll(async () => {
  ({ default: StaticComparisonPage } = await import("./page"));
}, 30_000);

async function renderSlug(slug: string) {
  return parseStaticDocument(renderToStaticMarkup(
    await StaticComparisonPage({ params: Promise.resolve({ slug }) }),
  ));
}

describe("StaticComparisonPage", () => {
  it("associates each controlled editorial section with its answer, sources, and source-check date", async () => {
    const document = await renderSlug("alpha-pair-vs-beta-pair");

    const differences = document.querySelector('section[aria-labelledby="comparison-differences-title"]');
    expect(differences).not.toBeNull();

    const articles = [...differences!.querySelectorAll("article")];
    expect(articles).toHaveLength(CONTROLLED_EDITORIAL.sections.length);
    CONTROLLED_EDITORIAL.sections.forEach((controlled, index) => {
      const article = articles[index]!;
      expect(article.querySelector("h3")?.textContent).toBe(controlled.question);
      expect(article.textContent).toContain(controlled.answer);
      expect(article.textContent).not.toContain(CONTROLLED_EDITORIAL.sections[1 - index]!.answer);
      expect(article.querySelector(`a[href="${controlled.sources[0]!.href}"]`)).not.toBeNull();
    });

    expect(differences!.querySelector("time")?.getAttribute("datetime")).toBe(CONTROLLED_EDITORIAL.sourcesCheckedAt);
    expect(differences!.textContent).toContain("Issuer sources checked");

    const shortAnswer = document.querySelector('aside[aria-labelledby="comparison-short-answer-title"]');
    expect(shortAnswer?.textContent).toContain(CONTROLLED_EDITORIAL.answer);
    expect(document.documentElement.textContent).toContain(CONTROLLED_EDITORIAL.intro);

    const faq = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((script) => JSON.parse(script.textContent ?? "{}"))
      .find((json) => json["@type"] === "FAQPage");
    expect(document.querySelector("details p")?.textContent).toBe(faq.mainEntity[0].acceptedAnswer.text);
  }, 30_000);

  it("resolves coin card detail links by exact stablecoin id", async () => {
    const document = await renderSlug("alpha-pair-vs-beta-pair");

    expect(findLinkByText(document, "Open USDe detail page")?.getAttribute("href")).toBe("/stablecoin/usde-ethena");
    expect(findLinkByText(document, "Open sUSDe detail page")?.getAttribute("href")).toBe("/stablecoin/susde-ethena");
    const liveCompareUrl = new URL(findLinkByText(document, "Open live compare")!.getAttribute("href")!, "https://pharos.watch");
    expect(liveCompareUrl.searchParams.get("coins")).toBe("usde-ethena,susde-ethena");
    expect(findLinkByText(document, "Telegram alerts")?.getAttribute("href")).toBe("/pharoswatchbot#getting-started");
  }, 30_000);

  it("does not imply source checking for a metadata-only comparison", async () => {
    const document = await renderSlug("meta-only-pair");
    expect(document.querySelector("#comparison-differences-title")).toBeNull();
    expect(document.querySelector("time")).toBeNull();
  }, 30_000);
});
