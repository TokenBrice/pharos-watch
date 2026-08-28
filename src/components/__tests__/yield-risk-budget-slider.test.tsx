// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { YieldRiskBudgetSlider } from "@/components/yield-risk-budget-slider";
import type { YieldRiskBudgetStop } from "@/lib/yield-view-model";


const stops: YieldRiskBudgetStop[] = [
  { key: "conservative", label: "Conservative", description: "", count: 3, active: false, overrides: {} },
  { key: "balanced", label: "Balanced", description: "", count: 19, active: true, overrides: {} },
  { key: "opportunistic", label: "Opportunistic", description: "", count: 70, active: false, overrides: {} },
  { key: "all", label: "All", description: "", count: 163, active: false, overrides: {} },
];

const unmatchedStops: YieldRiskBudgetStop[] = stops.map((stop) => ({ ...stop, active: false }));

describe("YieldRiskBudgetSlider", () => {
  it("renders all stops with their counts and labels", () => {
    render(<YieldRiskBudgetSlider stops={stops} onSelect={vi.fn()} />);

    expect(screen.getByText("Conservative")).toBeTruthy();
    // Active band label appears twice: once inline with the header, once as the stop label.
    expect(screen.getAllByText("Balanced")).toHaveLength(2);
    expect(screen.getByText("Opportunistic")).toBeTruthy();
    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("19")).toBeTruthy();
    expect(screen.getByText("70")).toBeTruthy();
    expect(screen.getByText("163")).toBeTruthy();
  });

  it("renders 'Custom' inline when no band matches", () => {
    render(<YieldRiskBudgetSlider stops={unmatchedStops} onSelect={vi.fn()} />);
    expect(screen.getByText("Custom")).toBeTruthy();
  });

  it("exposes a single range slider control wired to the active stop index", () => {
    render(<YieldRiskBudgetSlider stops={stops} onSelect={vi.fn()} />);

    const slider = screen.getByRole("slider", { name: "Risk tolerance" }) as HTMLInputElement;
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("3");
    expect(slider.step).toBe("1");
    expect(slider.value).toBe("1");
    expect(slider.getAttribute("aria-valuetext")).toContain("Balanced");
  });

  it("calls onSelect with the new stop key when the slider value changes", () => {
    const onSelect = vi.fn();
    render(<YieldRiskBudgetSlider stops={stops} onSelect={onSelect} />);

    const slider = screen.getByRole("slider", { name: "Risk tolerance" }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "2" } });
    expect(onSelect).toHaveBeenCalledWith("opportunistic");
  });

  it("does not call onSelect when the slider value resolves to the already-active stop", () => {
    const onSelect = vi.fn();
    render(<YieldRiskBudgetSlider stops={stops} onSelect={onSelect} />);

    const slider = screen.getByRole("slider", { name: "Risk tolerance" }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "1" } });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks the active stop visually via data-active", () => {
    render(<YieldRiskBudgetSlider stops={stops} onSelect={vi.fn()} />);

    const activeStop = document.querySelector('[data-active="true"]');
    expect(activeStop?.textContent).toContain("Balanced");

    const inactiveStops = document.querySelectorAll('[data-active="false"]');
    expect(inactiveStops.length).toBe(3);
  });

  it("reports the no-match state via aria-valuetext when no stop is active", () => {
    render(<YieldRiskBudgetSlider stops={unmatchedStops} onSelect={vi.fn()} />);

    const slider = screen.getByRole("slider", { name: "Risk tolerance" }) as HTMLInputElement;
    expect(slider.getAttribute("aria-valuetext")).toBe("No band selected — custom filters active");
    expect(document.querySelector('[data-active="true"]')).toBeNull();
    expect(document.querySelectorAll('[data-active="false"]').length).toBe(stops.length);
  });
});
