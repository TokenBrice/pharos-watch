import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DocPage, { generateMetadata } from "./page";
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
});
