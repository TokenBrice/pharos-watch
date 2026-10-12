// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafetyGradeHero } from "../hero-card-identity";

describe("SafetyGradeHero read states", () => {
  it("shows a neutral placeholder, not a dash, while the first report-card read is in flight", () => {
    const { container } = render(<SafetyGradeHero reportCard={null} read="pending" mobile />);

    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Loading Safety Score");
    expect(container.textContent).not.toContain("—");
  });

  it("says the grade is unavailable after a failed read, never the unscored dash", () => {
    const { container } = render(<SafetyGradeHero reportCard={null} read="failed" mobile />);

    expect(container.textContent).toBe("Grade unavailable");
    expect(container.querySelector('[data-safety-state="unavailable"]')).not.toBeNull();
  });

  it("keeps the unscored dash once the read has settled without a card", () => {
    const { container } = render(<SafetyGradeHero reportCard={null} mobile />);

    expect(container.textContent).toBe("—");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
