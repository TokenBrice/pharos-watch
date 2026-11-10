import { describe, expect, it } from "vitest";
import { buildArchetypeArticleJsonLd } from "@/lib/page-metadata";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import type { MechanismArchetype } from "@shared/types";

// First date each archetype page could have been published, from the commit
// that added its explainer content. Archetypes predating the cluster share its
// 2026-05-16 launch.
const CLUSTER_FIRST_PUBLISHED = "2026-05-16T00:00:00Z";
const ARCHETYPE_FIRST_PUBLISHED_FLOOR: Partial<Record<MechanismArchetype, string>> = {
  "rwa-credit-fund": "2026-05-20T00:00:00Z",
  "commodity-claim": "2026-08-08T00:00:00Z",
  "ucits-trs-fund": "2026-10-02T00:00:00Z",
  "shared-reserve": "2026-10-02T00:00:00Z",
  "protocol-position": "2026-10-02T00:00:00Z",
};

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

  it.each(MECHANISM_ARCHETYPE_VALUES)(
    "claims no publication date before the %s page existed",
    (archetype) => {
      const published = Date.parse(String(buildArchetypeArticleJsonLd(archetype).datePublished));
      expect(Number.isNaN(published)).toBe(false);
      expect(published).toBeGreaterThanOrEqual(
        Date.parse(ARCHETYPE_FIRST_PUBLISHED_FLOOR[archetype] ?? CLUSTER_FIRST_PUBLISHED),
      );
    },
  );
});
