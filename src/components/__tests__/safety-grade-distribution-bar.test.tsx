// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafetyGradeDistributionBar } from "../safety-grade-distribution-bar";

describe("SafetyGradeDistributionBar", () => {

  it("preserves the rated-total default for the V8 consumer", () => {
    render(<SafetyGradeDistributionBar gradeCounts={{ A: 1, B: 2, C: 0, D: 0, F: 0, NR: 1 }} totalCards={4} />);

    expect(screen.getByText("4 rated")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Safety grade distribution by asset count" })).toBeTruthy();
    expect(document.querySelector('[title="Grade B: 2"]')).toBeTruthy();
    expect(document.querySelector('[title="Grade NR: 1"]')).toBeTruthy();
  });
});
