import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScoringChangelogContent, scoringAnchorId } from "./content";

describe("ScoringChangelogContent", () => {
  it("preserves the version anchor and quick-reference rendering contracts", () => {
    expect(scoringAnchorId("v6.8")).toBe("scoring-v6-8");
    expect(scoringAnchorId("6.8")).toBe("scoring-6-8");

    const html = renderToStaticMarkup(<ScoringChangelogContent />);

    expect(html).toContain('id="scoring-v6-8"');
    expect(html).toContain("v6.8");
    expect(html).toContain("Quick Reference");
    expect(html).toContain("Weight evolution");
    expect(html).toContain("Grade threshold evolution");
  });
});
