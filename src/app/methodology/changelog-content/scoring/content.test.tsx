import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SAFETY_SCORE_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/registry";
import type { MethodologyChangelogDetailBlock } from "@shared/types/editorial-content";
import { ScoringChangelogContent, scoringAnchorId } from "./content";

describe("ScoringChangelogContent", () => {

  it("renders every table, heading and formula the published detail bodies declare", () => {
    const html = renderToStaticMarkup(<ScoringChangelogContent />);
    let tables = 0;
    let headings = 0;

    const escaped = (text: string) =>
      text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
        .replaceAll("'", "&#x27;");

    const assertBlock = (block: MethodologyChangelogDetailBlock) => {
      if (block.kind === "table") {
        tables += 1;
        expect(html).toContain(`data-table-id="${block.tableId}"`);
        expect(html).toContain(`data-testid="${block.testId}"`);
        expect(html).toContain(`aria-label="${escaped(block.ariaLabel)}"`);
        for (const row of block.rows) {
          for (const cell of Object.values(row.cells)) expect(html).toContain(escaped(cell));
        }
      }
      if (block.kind === "section") {
        headings += 1;
        expect(html).toContain(`<h3 class="text-foreground font-medium">${escaped(block.heading)}</h3>`);
        for (const nested of block.blocks) assertBlock(nested);
      }
      if (block.kind === "formula") expect(html).toContain(escaped(block.text));
    };

    for (const entry of SAFETY_SCORE_METHODOLOGY_CHANGELOG) {
      for (const block of entry.detail ?? []) assertBlock(block);
    }

    expect(tables).toBe(5);
    expect(headings).toBe(6);
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
