// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FactGrid, resolveFactValueStyle } from "../fact-grid";

describe("resolveFactValueStyle", () => {
  it.each([
    ["a number", 42],
    ["a percentage", "12.4%"],
    ["a one-word enum", "Omnibus"],
    ["a hyphenated one-word enum", "Third-party"],
    ["an unavailable dash", "–"],
    ["a figure with unit words", "$662k of $25m"],
    ["a short digit-bearing enum", "Tier 2"],
  ])("keeps mono figure style for %s", (_case, value) => {
    expect(resolveFactValueStyle(value)).toBe("figure");
  });

  it.each([
    ["a two-word phrase", "Pathway unresolved"],
    ["a multi-word classification", "Asset-referenced token"],
    ["a digit-bearing phrase", "13 reviewed routes on 13 chains"],
  ])("renders %s as sentence-case text", (_case, value) => {
    expect(resolveFactValueStyle(value)).toBe("text");
  });
});

describe("FactGrid", () => {
  it("renders every fact as a label/value pair in a named group", () => {
    render(
      <FactGrid
        aria-label="Custody facts"
        className="mt-3 grid-cols-3"
        items={[
          { key: "structure", label: "Structure", value: "Omnibus" },
          { key: "protection", label: "Protection", value: "Not disclosed", valueStyle: "figure" },
          { key: "share", label: "Share", value: "62%" },
        ]}
      />,
    );

    const group = screen.getByRole("group", { name: "Custody facts" });
    expect(group.textContent).toContain("Structure");
    expect(group.textContent).toContain("Not disclosed");
    expect(group.children).toHaveLength(3);
  });

  it("renders nothing without facts", () => {
    const { container } = render(<FactGrid items={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
