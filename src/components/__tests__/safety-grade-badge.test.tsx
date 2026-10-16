// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";

describe("SafetyGradeBadge", () => {
  it("never turns a technical gap into a grade or a numeric score", () => {
    const { container } = render(<SafetyGradeBadge grade={null} score={null} />);
    expect(container.textContent).toContain("Pipeline gap");
    expect(container.textContent).not.toMatch(/\b(?:NR|F|0|100)\b/);
  });
  it("renders a labelled grade badge with optional score", () => {
    render(<SafetyGradeBadge grade="B+" score={78} />);

    const badge = screen.getByLabelText("Safety grade B+, score 78");
    expect(badge.textContent).toContain("B+");
    expect(badge.textContent).toContain("(78)");
  });

});
