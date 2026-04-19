import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SAFETY_SCORE_CHANGELOG } from "@shared/lib/safety-score-version";
import { ScoringChangelogContent, scoringAnchorId } from "./content";

describe("ScoringChangelogContent", () => {
  it("preserves the version anchor and quick-reference rendering contracts", () => {
    expect(scoringAnchorId("v6.92")).toBe("scoring-v6-92");
    expect(scoringAnchorId("v6.8")).toBe("scoring-v6-8");
    expect(scoringAnchorId("6.8")).toBe("scoring-6-8");

    const html = renderToStaticMarkup(<ScoringChangelogContent />);

    expect(html).toContain('id="scoring-v6-92"');
    expect(html).toContain("v6.92");
    expect(html).toContain('id="scoring-v6-8"');
    expect(html).toContain("v6.8");
    expect(html).toContain("Quick Reference");
    expect(html).toContain("Weight evolution");
    expect(html).toContain("Grade threshold evolution");
  });

  it("renders every machine-readable safety score changelog version", () => {
    const html = renderToStaticMarkup(<ScoringChangelogContent />);

    for (const entry of SAFETY_SCORE_CHANGELOG) {
      expect(html).toContain(`id="${scoringAnchorId(`v${entry.version}`)}"`);
    }
  });
});
