// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YieldSourceRiskBar } from "@/components/yield-source-risk-bar";


describe("YieldSourceRiskBar", () => {
  it("renders unavailable state for null score", () => {
    render(<YieldSourceRiskBar score={null} />);
    expect(screen.getByLabelText("Source-risk score unavailable")).toBeTruthy();
  });

  it("renders aria label for score 0", () => {
    render(<YieldSourceRiskBar score={0} />);
    expect(screen.getByLabelText("Source-risk score: 0 of 100")).toBeTruthy();
  });

  it("renders aria label for score 50", () => {
    render(<YieldSourceRiskBar score={50} />);
    expect(screen.getByLabelText("Source-risk score: 50 of 100")).toBeTruthy();
  });

  it("renders aria label for score 100", () => {
    render(<YieldSourceRiskBar score={100} />);
    expect(screen.getByLabelText("Source-risk score: 100 of 100")).toBeTruthy();
  });

  it("applies compact width when compact prop is set", () => {
    const { container } = render(<YieldSourceRiskBar score={75} compact />);
    const bar = container.querySelector('[role="img"]');
    expect(bar?.className).toContain("w-[80px]");
  });
});
