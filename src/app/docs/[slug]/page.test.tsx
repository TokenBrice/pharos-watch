import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DocPage, { generateMetadata, generateStaticParams } from "./page";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

interface Anchor {
  href: string;
  target?: string;
  rel?: string;
}

/** Attribute-order-independent view of every rendered anchor. */
function anchors(html: string): Anchor[] {
  return Array.from(html.matchAll(/<a\s([^>]*)>/g), ([, attributes]) => ({
    href: /href="([^"]*)"/.exec(attributes!)?.[1] ?? "",
    target: /target="([^"]*)"/.exec(attributes!)?.[1],
    rel: /rel="([^"]*)"/.exec(attributes!)?.[1],
  }));
}

describe("DocPage", () => {
  it("exports and renders the public Blacklist Tracker methodology without operator procedures", async () => {
    expect(generateStaticParams()).toContainEqual({ slug: "blacklist-tracker" });
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: "blacklist-tracker" }) });
    expect(metadata.alternates?.canonical).toBe("/docs/blacklist-tracker/");
    const html = renderToStaticMarkup(await DocPage({ params: Promise.resolve({ slug: "blacklist-tracker" }) }));
    expect(html).toContain("Public Exposure Contract");
    expect(html).not.toMatch(/npx |--execute|Maintenance Checklist|runbook/i);
  });

  it("hides agent navigation, keeps the lifecycle anchor", async () => {
    const html = renderToStaticMarkup(await DocPage({ params: Promise.resolve({ slug: "depeg-detection" }) }));
    expect(html).not.toContain("Agent navigation");
    expect(html).toContain('id="event-lifecycle"');
  });

  it("opens external markdown links in a new tab with an isolated opener", async () => {
    const html = renderToStaticMarkup(await DocPage({ params: Promise.resolve({ slug: "redemption-backstops" }) }));
    const rendered = anchors(html);
    const external = rendered.filter((anchor) => /^https?:\/\//.test(anchor.href));

    expect(external.map((anchor) => anchor.href)).toContain("https://tempo.xyz/developers/docs/guide/ousd");
    expect(external.length).toBeGreaterThan(0);
    for (const anchor of external) {
      expect(anchor.target).toBe("_blank");
      expect(anchor.rel?.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    }
  });

  it("uses search-phrased titles without repeating the Pharos brand", async () => {
    const titleFor = async (slug: string) => (await generateMetadata({ params: Promise.resolve({ slug }) })).title;
    expect(await titleFor("yield-intelligence")).toBe("Stablecoin Yield Score: How APY Risk Is Rated");
    expect(await titleFor("dex-liquidity")).toBe("DEX Liquidity Score Methodology for Stablecoins");
    expect(await titleFor("depeg-detection")).toBe("Depeg Detection Methodology");
    for (const doc of PUBLIC_DOCS) {
      const title = String(await titleFor(doc.slug));
      expect(title).not.toMatch(/pharos/i);
      expect(`${title} | Pharos`.length).toBeLessThanOrEqual(62);
    }
  });

  it("renders the Updated date, Plain Markdown link, /methodology/ bridge, and 100% matching H2 TOC anchors across all public docs", async () => {
    for (const doc of PUBLIC_DOCS) {
      const html = renderToStaticMarkup(await DocPage({ params: Promise.resolve({ slug: doc.slug }) }));
      if (doc.slug === "depeg-detection") {
        expect(html).toMatch(/Updated <time[^>]*>\d{4}-\d{2}-\d{2}<\/time>/);
        expect(html).toContain('href="/docs/depeg-detection/index.md"');
        expect(html).toContain("Plain Markdown");
        expect(html).toContain('href="/methodology/"');
      }

      const articleMatch = /<article[^>]*>([\s\S]*?)<\/article>/.exec(html);
      expect(articleMatch, `${doc.slug} missing <article>`).not.toBeNull();
      const renderedH2s = Array.from(
        articleMatch![1]!.matchAll(/<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g),
        ([, id, inner]) => ({ id: id!, text: inner!.replace(/<[^>]+>/g, "").trim() }),
      );

      if (doc.slug === "mint-burn-flows" || doc.slug === "yield-intelligence") {
        for (const h2 of renderedH2s) {
          expect(h2.text, `${doc.slug} rendered prose paragraph as Setext h2`).not.toMatch(
            /syncMintBurn\(\) returns|Parsed rows are not inserted|Version deltas live|Benchmark descriptors in/,
          );
        }
      }

      const navMatch = /<nav aria-label="On this page"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
      if (renderedH2s.length >= 2) {
        expect(navMatch, `${doc.slug} missing TOC nav`).not.toBeNull();
        const tocIds = Array.from(navMatch![1]!.matchAll(/href="#([^"]+)"/g), ([, id]) => id!);
        expect(tocIds, `${doc.slug} TOC ids diverged from rehype-slug h2 ids`).toEqual(
          renderedH2s.map((h2) => h2.id),
        );
      }
    }
  });
});
