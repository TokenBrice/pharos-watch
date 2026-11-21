// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { YieldRiskBudgetSlider } from "@/components/yield/yield-risk-budget-slider";
import type { YieldRiskBudgetStop } from "@/lib/yield-view-model";

const stops: YieldRiskBudgetStop[] = [
  { key: "conservative", label: "Conservative", description: "A- safety", count: 3, active: false, overrides: { minSafety: 80 } },
  { key: "balanced", label: "Balanced", description: "B safety", count: 19, active: true, overrides: { minSafety: 70 } },
  { key: "opportunistic", label: "Opportunistic", description: "safety 50+", count: 70, active: false, overrides: { minSafety: 50 } },
  { key: "all", label: "All", description: "Show all rows", count: 163, active: false, overrides: {} },
];

const unmatchedStops: YieldRiskBudgetStop[] = stops.map((stop) => ({ ...stop, active: false }));

describe("YieldRiskBudgetSlider", () => {
  it("renders a segmented Risk tolerance bar with inline safety thresholds and row counts", () => {
    render(<YieldRiskBudgetSlider stops={stops} onSelect={vi.fn()} />);

    const conservative = screen.getByRole("button", { name: /Conservative/ });
    const balanced = screen.getByRole("button", { name: /Balanced/ });
    const opportunistic = screen.getByRole("button", { name: /Opportunistic/ });
    const all = screen.getByRole("button", { name: /^All/ });

    expect(conservative.textContent).toContain("≥80");
    expect(conservative.textContent).toContain("(3)");
    expect(balanced.textContent).toContain("≥70");
    expect(balanced.getAttribute("aria-pressed")).toBe("true");
    expect(balanced.getAttribute("data-active")).toBe("true");
    expect(opportunistic.textContent).toContain("≥50");
    expect(all.textContent).not.toContain("≥");
  });

  it("calls onSelect with the clicked stop key", () => {
    const onSelect = vi.fn();
    render(<YieldRiskBudgetSlider stops={stops} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /Opportunistic/ }));
    expect(onSelect).toHaveBeenCalledWith("opportunistic");
  });

  it("treats clicking the already-active stop as a no-op", () => {
    const onSelect = vi.fn();
    render(<YieldRiskBudgetSlider stops={stops} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /Balanced/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders Custom state when no stop is active and allows selecting All", () => {
    const onSelect = vi.fn();
    render(<YieldRiskBudgetSlider stops={unmatchedStops} onSelect={onSelect} />);

    expect(screen.getByText("Custom")).toBeTruthy();
    expect(document.querySelector('[data-active="true"]')).toBeNull();
    expect(document.querySelectorAll('[data-active="false"]').length).toBe(stops.length);

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(onSelect).toHaveBeenCalledWith("all");
  });
});
