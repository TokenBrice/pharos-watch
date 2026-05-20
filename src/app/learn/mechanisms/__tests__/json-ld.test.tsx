import { describe, expect, it } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { MECHANISM_ARCHETYPE_LABELS } from "@shared/lib/classification";

import {
  buildArchetypeArticleJsonLd,
  buildDefinedTermSetJsonLd,
} from "@/lib/page-metadata";

describe("buildDefinedTermSetJsonLd", () => {
  const doc = buildDefinedTermSetJsonLd();

  it("declares a DefinedTermSet", () => {
    expect(doc["@type"]).toBe("DefinedTermSet");
  });

  it("includes one DefinedTerm per archetype", () => {
    const terms = doc.hasDefinedTerm as Array<{ termCode: string; name: string }>;
    expect(terms).toHaveLength(MECHANISM_ARCHETYPE_VALUES.length);
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      const term = terms.find((t) => t.termCode === archetype);
      expect(term).toBeDefined();
      expect(term?.name).toBe(MECHANISM_ARCHETYPE_LABELS[archetype]);
    }
  });
});

describe("buildArchetypeArticleJsonLd", () => {
  it("produces Article schema for every archetype", () => {
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      const doc = buildArchetypeArticleJsonLd(archetype);
      expect(doc["@type"]).toBe("Article");
      expect(doc.headline).toContain(MECHANISM_ARCHETYPE_LABELS[archetype]);
      expect(doc.datePublished).toBeDefined();
      expect(doc.dateModified).toBeDefined();
      const about = doc.about as { termCode: string };
      expect(about.termCode).toBe(archetype);
    }
  });
});
