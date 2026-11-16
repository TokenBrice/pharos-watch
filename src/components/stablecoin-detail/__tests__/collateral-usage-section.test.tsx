// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CollateralUsageSection, type PublishedCollateralUsageEntry } from "../collateral-usage-section";

function entry(id: string, edgeType: "basket" | "serial", weight: number | null, marketCap: number | null = null): PublishedCollateralUsageEntry {
  return { coin: { id, name: id, symbol: id }, edgeType, relationshipType: edgeType === "basket" ? "collateral" : "wrapper", weight, marketCap };
}

describe("CollateralUsageSection", () => {
  it("shows serial claims as wrappers without a percentage", () => {
    render(<CollateralUsageSection entries={[entry("susde-ethena", "serial", null)]} symbol="USDe" />);
    const row = screen.getByRole("link");
    expect(screen.getByText("Wrapper")).toBeTruthy();
    expect(row.getAttribute("aria-label")).toBe("susde-ethena, Wrapper, exposure unavailable");
    expect(row.textContent).not.toContain("%");
    expect(row.textContent).not.toContain("share unknown");
  });

  it.each([
    { relationshipType: "mechanism", label: "Mechanism" },
    { relationshipType: "serial-claim", label: "Serial claim" },
  ] as const)("labels $label distinctly without implying a percentage", ({ relationshipType, label }) => {
    render(<CollateralUsageSection entries={[{
      ...entry("susdc-spark", "serial", null), relationshipType,
    }]} symbol="USDS" />);
    const row = screen.getByRole("link", { name: `susdc-spark, ${label}, exposure unavailable` });
    expect(screen.getByText(label)).toBeTruthy();
    expect(row.textContent).not.toContain("Wrapper");
    expect(row.textContent).not.toContain("%");
  });

  it("labels an impossible zero basket share as unavailable without dropping the dependent", () => {
    render(<CollateralUsageSection entries={[entry("zero", "basket", 0, 100)]} symbol="USDC" />);
    expect(screen.getByRole("link", { name: "zero, Collateral, share n/a, exposure unavailable" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Used by 1" })).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.queryByText("<1%")).toBeNull();
  });

  it("preserves tiny positive and unknown basket shares", () => {
    render(<CollateralUsageSection entries={[
      entry("tiny", "basket", 0.0001), entry("unknown", "basket", null),
    ]} symbol="USDC" />);
    expect(screen.getByRole("link", { name: /^tiny, Collateral, <0\.1% of backing/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^unknown, Collateral, share unknown/ })).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("ranks dependents by known exposure, scales bars to the largest, and dashes unknown rows", () => {
    const { container } = render(<CollateralUsageSection entries={[
      entry("small", "basket", 0.5, 100),
      entry("unknown", "basket", 0.9, null),
      entry("wrapper", "serial", null, 400),
      entry("half", "basket", 0.25, 800),
    ]} symbol="USDC" />);
    expect(screen.getAllByRole("link").map((row) => row.getAttribute("aria-label"))).toEqual([
      "wrapper, Wrapper, $400 known exposure",
      "half, Collateral, 25% of backing, $200 known exposure",
      "small, Collateral, 50% of backing, $50 known exposure",
      "unknown, Collateral, 90% of backing, exposure unavailable",
    ]);
    const fills = [...container.querySelectorAll<HTMLElement>("a span[aria-hidden] > span")].map((bar) => bar.style.width);
    expect(fills).toEqual(["100%", "50%", "12.5%"]);
    expect(container.querySelectorAll("a span.border-dashed")).toHaveLength(1);
  });

  it("caps the list at eight rows behind a Show all toggle", () => {
    render(<CollateralUsageSection entries={Array.from({ length: 10 }, (_, index) => entry(`coin-${index}`, "basket", 0.1, index + 1))} symbol="USDC" />);
    expect(screen.getAllByRole("link")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Show all 10 dependents" }));
    expect(screen.getAllByRole("link")).toHaveLength(10);
  });
});
