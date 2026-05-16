// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";

afterEach(() => {
  cleanup();
});

describe("SafetyGradeBadge", () => {
  it("renders a labelled grade badge with optional score", () => {
    render(<SafetyGradeBadge grade="B+" score={78} />);

    const badge = screen.getByLabelText("Safety grade B+, score 78");
    expect(badge.textContent).toContain("B+");
    expect(badge.textContent).toContain("(78)");
    expect(badge.className).toContain("text-blue-700");
  });

  it("keeps score hidden when showScore is false", () => {
    render(<SafetyGradeBadge grade="F" score={21} showScore={false} />);

    expect(screen.getByLabelText("Safety grade F")).toBeTruthy();
    expect(screen.queryByText("(21)")).toBeNull();
  });

  it("appends a version suffix when versionTopic is set", () => {
    render(<SafetyGradeBadge grade="B+" score={78} versionTopic="safetyScore" />);
    const versionLabel = METHODOLOGY_CONTEXT.safetyScore.versionLabel as string;
    expect(versionLabel).toBeTruthy();
    expect(screen.getByText(versionLabel)).toBeTruthy();
    expect(screen.getAllByLabelText("Safety grade B+, score 78").every((badge) => badge.getAttribute("tabindex") === "0")).toBe(true);
  });

  it("hides the version suffix in tooltip-only mode", () => {
    render(
      <SafetyGradeBadge
        grade="B+"
        score={78}
        versionTopic="safetyScore"
        versionVariant="tooltip-only"
      />,
    );
    const versionLabel = METHODOLOGY_CONTEXT.safetyScore.versionLabel as string;
    expect(screen.queryByText(versionLabel)).toBeNull();
  });
});
