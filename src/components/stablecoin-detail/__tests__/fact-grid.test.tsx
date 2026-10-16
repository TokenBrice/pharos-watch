// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FactGrid } from "../fact-grid";

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
