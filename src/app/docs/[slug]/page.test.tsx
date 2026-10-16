import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DocPage from "./page";

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

});
