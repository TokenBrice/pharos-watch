import { describe, expect, it } from "vitest";
import { buildArchetypeArticleJsonLd } from "@/lib/page-metadata";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";

describe("buildArchetypeArticleJsonLd", () => {
  it("references the root organization node instead of an inline Organization", () => {
    const article = buildArchetypeArticleJsonLd("cdp");
    expect(article).toMatchObject({
      "@type": "Article",
      "@id": `${SITE_ORIGIN}/learn/mechanisms/cdp/`,
      author: { "@id": `${SITE_ORIGIN}#organization` },
      publisher: { "@id": `${SITE_ORIGIN}#organization` },
      isPartOf: `${SITE_ORIGIN}/learn/mechanisms/`,
      about: { "@type": "DefinedTerm", termCode: "cdp" },
    });
    expect(JSON.stringify(article)).not.toContain('"@type":"Organization"');
  });
});
