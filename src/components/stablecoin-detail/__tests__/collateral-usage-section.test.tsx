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
    expect(row.textContent).toContain("Wrapper");
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
    expect(row.textContent).toContain(label);
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

  it("orders collateral by share then wrappers by known dependent market cap", () => {
    render(<CollateralUsageSection entries={[
      entry("small-wrapper", "serial", null, 1),
      entry("small-basket", "basket", 0.01),
      entry("unknown-wrapper", "serial", null),
      entry("large-wrapper", "serial", null, 100),
      entry("large-basket", "basket", 0.521),
      entry("unknown-basket", "basket", null),
    ]} />);
    expect(screen.getAllByRole("link").map((row) => row.getAttribute("href"))).toEqual([
      "/stablecoin/large-basket", "/stablecoin/small-basket", "/stablecoin/unknown-basket",
      "/stablecoin/large-wrapper", "/stablecoin/small-wrapper", "/stablecoin/unknown-wrapper",
    ]);
  });

  it("omits Used by when no published dependents exist", () => {
    const { container } = render(<CollateralUsageSection entries={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
