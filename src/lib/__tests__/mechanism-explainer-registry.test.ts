import { describe, expect, it } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import {
  MECHANISM_EXPLAINER_ENTRIES,
  MECHANISM_EXPLAINER_TITLES,
} from "@/lib/mechanism-explainer-registry";
import { ARCHETYPE_CONTENT } from "@/lib/mechanism-explainers";
import { METHODOLOGY_SECTIONS } from "@/app/methodology/methodology-shared";

// eslint-disable-next-line security/detect-unsafe-regex -- anchored kebab-case id; finite groups, no backtracking ambiguity.
const KEBAB_CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe("mechanism explainer registry", () => {
  it("links methodology cross-references to existing section anchors", () => {
    const sectionIds = new Set<string>(METHODOLOGY_SECTIONS.map(({ id }) => id));
    for (const content of Object.values(ARCHETYPE_CONTENT)) {
      for (const { href } of content.crossLinks) {
        if (href.startsWith("/methodology/#")) {
          expect(sectionIds.has(href.split("#")[1]), href).toBe(true);
        }
      }
    }
  });

  it("owns one non-empty title for every mechanism archetype", () => {
    expect(Object.keys(MECHANISM_EXPLAINER_TITLES).sort()).toEqual([...MECHANISM_ARCHETYPE_VALUES].sort());
    for (const title of Object.values(MECHANISM_EXPLAINER_TITLES)) {
      expect(title.trim()).not.toBe("");
    }
  });

  it("exposes the exhaustive ordered registry to build scripts", () => {
    expect(MECHANISM_EXPLAINER_ENTRIES).toEqual(
      MECHANISM_ARCHETYPE_VALUES.map((slug) => ({
        slug,
        title: MECHANISM_EXPLAINER_TITLES[slug],
        ogFilename: `og-learn-${slug}.png`,
      })),
    );
  });

  it("gives steps and variations stable, unique kebab-case ids", () => {
    for (const content of Object.values(ARCHETYPE_CONTENT)) {
      for (const records of [content.howItWorks, content.variations]) {
        const ids = records.map(({ id }) => id);

        expect(ids.every((id) => KEBAB_CASE_ID.test(id))).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });
});
