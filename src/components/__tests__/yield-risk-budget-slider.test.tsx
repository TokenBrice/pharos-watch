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

  it("commits the stop under the pointer when the custom state parks the thumb on All", () => {
    const onSelect = vi.fn();
    render(<YieldRiskBudgetSlider stops={unmatchedStops} onSelect={onSelect} />);

    const slider = screen.getByRole("slider", { name: "Risk tolerance" });
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 300, top: 0, bottom: 0, width: 300, height: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerUp(slider, { clientX: 299 });
    expect(onSelect).toHaveBeenCalledWith("all");
  });

  it("treats a pointer commit on the already-active stop as a no-op", () => {
    const onSelect = vi.fn();
    render(<YieldRiskBudgetSlider stops={stops} onSelect={onSelect} />);

    const slider = screen.getByRole("slider", { name: "Risk tolerance" });
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 300, top: 0, bottom: 0, width: 300, height: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerUp(slider, { clientX: 100 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("reports the no-match state via aria-valuetext when no stop is active", () => {
    render(<YieldRiskBudgetSlider stops={unmatchedStops} onSelect={vi.fn()} />);

    const slider = screen.getByRole("slider", { name: "Risk tolerance" }) as HTMLInputElement;
    expect(slider.getAttribute("aria-valuetext")).toBe("No band selected — custom filters active");
    expect(document.querySelector('[data-active="true"]')).toBeNull();
    expect(document.querySelectorAll('[data-active="false"]').length).toBe(stops.length);
  });
});
