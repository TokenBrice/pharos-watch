import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", async () => {
  // Vitest hoists this factory, so the mock helper must load within that boundary.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

import { METHODOLOGY_SECTIONS } from "../methodology-shared";
import { COMPUTED_FEATURES } from "@/lib/about-content";
import { DEPENDENCY_EXPOSURE_SECTION_CONTENT } from "@/lib/methodology-content";
import { buildMethodologyIndexMarkdown } from "../../../../scripts/lib/methodology-to-markdown";
import { DependencyExposureMethodologySection } from "./dependency-exposure-section";
import { MethodologySections } from "./methodology-sections";

const BANNED_EXPOSURE_COPY = /\b(?:likely impact|at risk|expected loss|coins fail|safe|shock)\b/i;

describe("Dependency exposure methodology", () => {
  it("renders registered navigation targets once, including exposure, without duplicate anchors", () => {
    const html = renderToStaticMarkup(<MethodologySections />);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

    expect(new Set(ids).size).toBe(ids.length);
    expect(METHODOLOGY_SECTIONS.some((section) => section.id === DEPENDENCY_EXPOSURE_SECTION_CONTENT.id)).toBe(true);
    for (const section of METHODOLOGY_SECTIONS) {
      expect(ids.filter((id) => id === section.id), `navigation anchor #${section.id}`).toHaveLength(1);
    }
  });

  it("exports the lookup explanation for markdown readers as well as the visible section", () => {
    const markdown = buildMethodologyIndexMarkdown();
    expect(markdown).toContain(DEPENDENCY_EXPOSURE_SECTION_CONTENT.markdown.trim());
    expect(markdown.match(/^## Dependency Exposure Lookup$/gm)).toHaveLength(1);
  });

  it("keeps exposure and about copy free of loss-prediction language and clause dashes", () => {
    const about = COMPUTED_FEATURES.find((feature) => feature.href === "/dependency-map/");
    expect(about).toBeDefined();
    const copy = [
      renderToStaticMarkup(<DependencyExposureMethodologySection />).replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
      DEPENDENCY_EXPOSURE_SECTION_CONTENT.markdown,
      about!.description,
    ];

    for (const text of copy) {
      expect(text).not.toMatch(BANNED_EXPOSURE_COPY);
      expect(text).not.toMatch(/[\u2012-\u2015]/u);
    }
  });
});
