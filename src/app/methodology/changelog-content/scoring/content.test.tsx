import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SAFETY_SCORE_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/safety-score";
import { ScoringChangelogContent, scoringAnchorId, scoringChangelogDetails } from "./content";
import { scoringChangelogLegacyDetails } from "./content-legacy";
import { WeightRow } from "./content-shared";
import { ScoringChangelogSummaryTables } from "./content-summary";
import { scoringChangelogV5Details } from "./content-v5";

function markupHash(node: React.ReactNode) {
  return createHash("sha256").update(renderToStaticMarkup(node)).digest("hex");
}

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

  it("preserves the exact quick-reference table markup", () => {
    expect(markupHash(<ScoringChangelogSummaryTables />)).toBe(
      "e34b520264a28dc6d7ae1e84df51e56cfd6a2b6272a1b696e6308eed3fa59e6a",
    );
  });

  it("preserves representative legacy and V5 table markup", () => {
    const fixtures: Array<[React.ReactNode, string]> = [
      [scoringChangelogLegacyDetails["4.0"], "7d3dc71e6662a08023ed2217602f7c0ae5207d402c3dcbd2dd1f4ceb95a2cd3d"],
      [scoringChangelogLegacyDetails["3.3"], "36b0beb11417f3fb067ce44eec531d52159e699697bf39c0b0a907c591c98dc0"],
      [scoringChangelogLegacyDetails["3.0"], "2e877acc7a66f154559d7b017fe9997bd5430e7b836c440488d4f2041975be9c"],
      [scoringChangelogLegacyDetails["1.0"], "b5387ebb0e813d3eccf788cb0e98d9f8ffe8749f08ee0d033975e74051677596"],
      [scoringChangelogV5Details["5.2"], "f55ea596e2d1f59a50ee3b2909f540eb96a4c8f9fd3704b798f6acea0b881a7a"],
      [<WeightRow key="weight-row" values={["multiplier", "30%", "—", "20%", "15%", "25%"]} />, "0a7a793232f583a746abbcea2d3a04cd073f61c12af921282d3f7f662bf2ac6b"],
    ];
    for (const [node, expected] of fixtures) expect(markupHash(node)).toBe(expected);
  });
});
