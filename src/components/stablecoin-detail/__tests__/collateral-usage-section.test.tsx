// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CollateralUsageSection, type PublishedCollateralUsageEntry } from "../collateral-usage-section";

function entry(id: string, edgeType: "basket" | "serial", weight: number | null, marketCap: number | null = null): PublishedCollateralUsageEntry {
  return { coin: { id, name: id, symbol: id }, edgeType, relationshipType: edgeType === "basket" ? "collateral" : "wrapper", weight, marketCap };
}

describe("CollateralUsageSection", () => {
  it("shows serial claims as wrappers without a percentage", () => {
    render(<CollateralUsageSection entries={[entry("susde-ethena", "serial", null)]} />);
    const row = screen.getByRole("link");
    // The tag heads the group once rather than repeating on every row.
    expect(screen.getByText("Wrapper")).toBeTruthy();
    expect(row.getAttribute("aria-label")).toContain("Wrapper");
    expect(row.textContent).not.toContain("%");
    expect(row.textContent).not.toContain("share unknown");
  });

  it.each([
    { relationshipType: "mechanism", label: "Mechanism" },
    { relationshipType: "serial-claim", label: "Serial claim" },
  ] as const)("labels $label distinctly without implying a percentage", ({ relationshipType, label }) => {
    render(<CollateralUsageSection entries={[{
      ...entry("susdc-spark", "serial", null), relationshipType,
    }]} />);
    const row = screen.getByRole("link", { name: `susdc-spark ${label}` });
    expect(screen.getByText(label)).toBeTruthy();
    expect(row.textContent).not.toContain("Wrapper");
    expect(row.textContent).not.toContain("%");
  });

  it("labels an impossible zero basket share as unavailable without dropping the dependent", () => {
    render(<CollateralUsageSection entries={[entry("zero", "basket", 0)]} />);
    expect(screen.getByRole("link", { name: "zero Collateral n/a" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Used by 1" })).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.queryByText("<1%")).toBeNull();
  });

  it("preserves tiny positive and unknown basket shares", () => {
    render(<CollateralUsageSection entries={[
      entry("tiny", "basket", 0.0001), entry("unknown", "basket", null),
    ]} />);
    expect(screen.getByRole("link", { name: /tiny Collateral <1%/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /unknown Collateral share unknown/ })).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });
});
