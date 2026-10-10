// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafetyGradeDistributionBar } from "../safety-grade-distribution-bar";

describe("SafetyGradeDistributionBar", () => {

  it("labels the full distribution as assets, including not-rated members", () => {
    render(<SafetyGradeDistributionBar gradeCounts={{ A: 1, B: 2, C: 0, D: 0, F: 0, NR: 1 }} totalCards={4} />);

    expect(screen.getByText("4 assets")).toBeTruthy();
    expect(screen.queryByText("4 rated")).toBeNull();
    expect(screen.getByRole("img", { name: "Safety grade distribution by asset count" })).toBeTruthy();
    expect(document.querySelector('[title="Grade B: 2"]')).toBeTruthy();
    expect(document.querySelector('[title="Grade NR: 1"]')).toBeTruthy();
  });
});
