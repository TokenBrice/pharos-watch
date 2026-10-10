import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SAFETY_SCORE_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/registry";
import type { MethodologyChangelogDetailBlock } from "@shared/lib/methodology-versions/base";
import { ScoringChangelogContent, scoringAnchorId } from "./content";
import { StructuredChangelogDetail } from "./content-shared";

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
    for (const [id, label] of [
      ["scoring-weight-evolution", "Safety Score weight evolution"],
      ["scoring-grade-threshold-evolution", "Safety Score grade threshold evolution"],
    ]) {
      expect(html).toContain(`data-table-id="${id}"`);
      expect(html).toContain(`data-testid="${id}-table"`);
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('scope="row"');
  });

  it("supports typed column class overrides while retaining semantic row headers", () => {
    const detail: MethodologyChangelogDetailBlock = {
      kind: "table",
      ariaLabel: "Column overrides",
      tableId: "column-overrides",
      testId: "column-overrides-table",
      columns: [
        { id: "label", label: "Label", rowHeader: true, headClassName: "text-right", cellClassName: "italic" },
        { id: "value", label: "Value" },
      ],
      rows: [{ id: "example", cells: { label: "Example", value: "42" } }],
    };
    const html = renderToStaticMarkup(
      <StructuredChangelogDetail entry={{ ...SAFETY_SCORE_METHODOLOGY_CHANGELOG[0], detail: [detail] }} />,
    );
    const headers = Array.from(html.matchAll(/<th\b[^>]*>/g), ([tag]) => tag);
    const columnClasses = headers.find((tag) => tag.includes('scope="col"'))?.match(/class="([^"]*)"/)?.[1].split(" ");
    const rowClasses = headers.find((tag) => tag.includes('scope="row"'))?.match(/class="([^"]*)"/)?.[1].split(" ");
    expect(columnClasses).toContain("text-right");
    expect(rowClasses).toContain("italic");
    expect(html).toContain('data-row-intent="static"');
  });

  it("renders every machine-readable safety score changelog version", () => {
    const html = renderToStaticMarkup(<ScoringChangelogContent />);

    for (const entry of SAFETY_SCORE_METHODOLOGY_CHANGELOG) {
      expect(html).toContain(`id="${scoringAnchorId(`v${entry.version}`)}"`);
    }
  });

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

  it("renders the v4.0 card body in published order", () => {
    const html = renderToStaticMarkup(<ScoringChangelogContent />);
    const card = html.slice(html.indexOf('id="scoring-v4-0"'), html.indexOf('id="scoring-v3-3"'));

    expect(card).toContain(
      '<span class="text-foreground font-medium">Biggest structural change.</span> Peg Stability removed from the'
      + " weighted base dimensions entirely and applied as a post-hoc power-curve multiplier:",
    );
    expect(card.indexOf("final = base × (pegScore / 100) ^ 0.20")).toBeLessThan(
      card.indexOf("scoring-v4-pegscore-multiplier"),
    );
    expect(card.indexOf("scoring-v4-pegscore-multiplier")).toBeLessThan(card.indexOf("Grade thresholds lowered 5"));
    expect(card).toContain("Dep Risk");
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
