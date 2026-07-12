import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SAFETY_SCORE_METHODOLOGY_CHANGELOG } from "@shared/lib/safety-score-version";
import { ScoringChangelogContent, scoringAnchorId, scoringChangelogDetails } from "./content";

describe("ScoringChangelogContent", () => {
  it("preserves the version anchor and quick-reference rendering contracts", () => {
    expect(scoringAnchorId("v6.92")).toBe("scoring-v6-92");
    expect(scoringAnchorId("v7.291")).toBe("scoring-v7-291");
    expect(scoringAnchorId("v6.8")).toBe("scoring-v6-8");
    expect(scoringAnchorId("6.8")).toBe("scoring-6-8");

    const html = renderToStaticMarkup(<ScoringChangelogContent />);

    expect(html).toContain('id="scoring-v6-92"');
    expect(html).toContain('id="scoring-v7-291"');
    expect(html).toContain("v6.92");
    expect(html).toContain('id="scoring-v6-8"');
    expect(html).toContain("v6.8");
    expect(html).toContain("Quick Reference");
    expect(html).toContain("Weight evolution");
    expect(html).toContain("Grade threshold evolution");
  });

  it("renders every machine-readable safety score changelog version", () => {
    const html = renderToStaticMarkup(<ScoringChangelogContent />);

    for (const entry of SAFETY_SCORE_METHODOLOGY_CHANGELOG) {
      expect(html).toContain(`id="${scoringAnchorId(`v${entry.version}`)}"`);
    }
  });

  it("has exactly one detail entry for every machine changelog version", () => {
    expect(Object.keys(scoringChangelogDetails).sort()).toEqual(
      SAFETY_SCORE_METHODOLOGY_CHANGELOG.map((entry) => entry.version).sort(),
    );
  });

  it("renders version-card anchors in machine changelog order", () => {
    const html = renderToStaticMarkup(<ScoringChangelogContent />);
    const expectedAnchors = SAFETY_SCORE_METHODOLOGY_CHANGELOG.map((entry) => scoringAnchorId(`v${entry.version}`));
    const expectedAnchorSet = new Set(expectedAnchors);
    const anchors = Array.from(html.matchAll(/id="([^"]+)"/g), (match) => match[1]).filter((id) =>
      expectedAnchorSet.has(id),
    );

    expect(anchors).toEqual(expectedAnchors);
  });
});
