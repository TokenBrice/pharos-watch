// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { PsiBeamDimmers } from "./psi-beam-dimmers";
import type { PsiBeamDimmerLane } from "./view-model";

describe("PsiBeamDimmers", () => {
  it("renders current component pressure lanes with the causality caveat", () => {
    const lanes: PsiBeamDimmerLane[] = [
      {
        key: "severity",
        label: "Severity",
        value: 12,
        delta: 2,
        pressurePct: 18,
        max: 68,
        role: "penalty",
        detail: "Current depeg depth penalty",
      },
      {
        key: "trend",
        label: "Trend",
        value: 1.5,
        delta: 0.5,
        pressurePct: 0,
        max: 5,
        role: "support",
        detail: "7-day market-cap momentum",
      },
    ];

    render(createElement(PsiBeamDimmers, { lanes }));

    expect(screen.getByText(/Beam Dimmers.*Component pressure/)).toBeTruthy();
    expect(screen.getByText("Severity")).toBeTruthy();
    expect(screen.getByText("Trend")).toBeTruthy();
    expect(screen.getByText(/not a causal timeline/i)).toBeTruthy();
    expect(screen.getByText("support")).toBeTruthy();
  });
});
