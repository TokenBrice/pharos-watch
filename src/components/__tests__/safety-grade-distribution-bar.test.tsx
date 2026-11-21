// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import { SafetyGradeDistributionBar, type SafetyGradeSupplyMix } from "../safety-scores/safety-grade-distribution-bar";

const COUNTS = { A: 1, B: 2, C: 0, D: 0, F: 0, NR: 1 };

function mix(overrides: Partial<SafetyGradeSupplyMix> = {}): SafetyGradeSupplyMix {
  return {
    supplyByGrade: { A: 995, B: 4, C: 1, D: 0, F: 0 },
    totalSupply: 1000,
    observedCount: 3,
    ratedCount: 3,
    ...overrides,
  };
}

describe("SafetyGradeDistributionBar", () => {
  afterEach(cleanupFrontendTest);

  it("labels the full distribution as assets, including not-rated members", () => {
    render(<SafetyGradeDistributionBar gradeCounts={COUNTS} totalCards={4} />);

    expect(screen.getByText("4 assets")).toBeTruthy();
    expect(screen.queryByText("4 rated")).toBeNull();
    expect(screen.getByRole("img", { name: "Safety grade distribution by asset count" })).toBeTruthy();
    expect(document.querySelector('[title="Grade B: 2"]')).toBeTruthy();
    expect(document.querySelector('[title="Grade NR: 1"]')).toBeTruthy();
    expect(screen.queryByText("By asset count")).toBeNull();
  });

  it("sets the supply-weighted mix of rated assets under the asset-count row", () => {
    render(<SafetyGradeDistributionBar gradeCounts={COUNTS} totalCards={4} supplyMix={mix()} />);

    expect(screen.getByText("By asset count")).toBeTruthy();
    expect(screen.getByText("By supply")).toBeTruthy();
    expect(screen.getByText("$1.00K · 3 rated")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Safety grade distribution by supply of rated assets" })).toBeTruthy();
    expect(screen.getByText(">99%")).toBeTruthy();
    expect(screen.getAllByText("<1%")).toHaveLength(2);
    // Grades without observed supply draw no segment and no legend entry.
    expect(document.querySelector('[title^="Grade D: "]')).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("discloses rated assets whose supply is unavailable instead of counting them as zero", () => {
    render(
      <SafetyGradeDistributionBar
        gradeCounts={COUNTS}
        totalCards={4}
        supplyMix={mix({ supplyByGrade: { A: 60, B: 40, C: 0, D: 0, F: 0 }, totalSupply: 100, observedCount: 2 })}
      />,
    );

    expect(screen.getByText("By known supply")).toBeTruthy();
    expect(screen.getByText("$100.00 · 2 of 3 rated")).toBeTruthy();
    expect(screen.getByText(/Supply unavailable for 1 rated asset: excluded, not counted as zero/)).toBeTruthy();
    expect(screen.getByText("60%")).toBeTruthy();
  });

  it.each([
    ["no observed supply", { totalSupply: 0, observedCount: 0 }, "Supply unavailable"],
    ["an observed zero total", { supplyByGrade: { A: 0, B: 0, C: 0, D: 0, F: 0 }, totalSupply: 0 }, "Observed supply is $0.00, so supply shares are undefined"],
  ])("degrades the supply row to a dashed strip for %s", (_state, overrides, message) => {
    render(<SafetyGradeDistributionBar gradeCounts={COUNTS} totalCards={4} supplyMix={mix(overrides)} />);

    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByRole("img", { name: /by supply/ })).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("wires bar segments and legend items as interactive grade filter toggles", () => {
    const onSelectGrade = vi.fn();
    render(
      <SafetyGradeDistributionBar
        gradeCounts={COUNTS}
        totalCards={4}
        activeGrade="B"
        onSelectGrade={onSelectGrade}
      />,
    );

    expect(screen.getByText("Filtered to Grade B")).toBeTruthy();
    const segmentB = screen.getByRole("button", { name: "Filter by grade B (2)" });
    expect(segmentB.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(segmentB);
    expect(onSelectGrade).toHaveBeenCalledWith("B");

    const legendA = screen.getByRole("button", { name: "Filter by grade A: 1" });
    expect(legendA.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(legendA);
    expect(onSelectGrade).toHaveBeenCalledWith("A");
  });
});
