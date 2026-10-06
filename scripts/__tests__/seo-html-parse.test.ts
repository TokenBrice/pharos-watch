import { describe, expect, it } from "vitest";
import { extractJsonLdBlocks } from "../lib/seo-html-parse.mjs";

describe("extractJsonLdBlocks", () => {
  it("keeps block boundaries when earlier text lengthens under toLowerCase", () => {
    // "İ" lowercases to two UTF-16 units; /stablecoin/tryb-bilira/ failed the
    // release SEO gate because each one shifted later slices by a character.
    const faq = JSON.stringify({ "@type": "FAQPage", mainEntity: [] });
    const html = `<p>Named Vakıfbank, Ziraatbank, İşbank and Fibabanka. İ</p><script type="application/ld+json">${faq}</script><SCRIPT type="application/ld+json">{"a":1}</SCRIPT>`;
    const blocks = extractJsonLdBlocks(html);
    expect(blocks).toEqual([faq, '{"a":1}']);
    expect(blocks.map((block) => JSON.parse(block))).toHaveLength(2);
  });
});
