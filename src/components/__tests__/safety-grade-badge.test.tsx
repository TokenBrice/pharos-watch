// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";


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

  it("appends a version suffix when the methodology topic has one", () => {
    render(<SafetyGradeBadge grade="B+" score={78} versionTopic="liquidityScore" />);
    const versionLabel = METHODOLOGY_CONTEXT.liquidityScore.versionLabel as string;
    expect(versionLabel).toBeTruthy();
    expect(screen.getByText(versionLabel)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /explain DEX market liquidity/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Safety grade B+, score 78").every((badge) => !badge.hasAttribute("tabindex"))).toBe(true);
  });

  it("hides the version suffix in tooltip-only mode", () => {
    render(
      <SafetyGradeBadge
        grade="B+"
        score={78}
        versionTopic="liquidityScore"
        versionVariant="tooltip-only"
      />,
    );
    const versionLabel = METHODOLOGY_CONTEXT.liquidityScore.versionLabel as string;
    expect(screen.queryByText(versionLabel)).toBeNull();
    expect(screen.getAllByRole("button", { name: /explain DEX market liquidity/i }).length).toBeGreaterThan(0);
  });

  it("can suppress methodology triggers inside link-wrapped cards", () => {
    render(
      <SafetyGradeBadge
        grade="B+"
        score={78}
        versionTopic="liquidityScore"
        versionInteractive={false}
      />,
    );

    expect(screen.queryByRole("button", { name: /explain DEX market liquidity/i })).toBeNull();
    expect(screen.getByText(METHODOLOGY_CONTEXT.liquidityScore.versionLabel as string)).toBeTruthy();
  });

  it("omits a suffix for the active identity-based Safety Score methodology", () => {
    render(<SafetyGradeBadge grade="B+" score={78} versionTopic="safetyScore" />);

    expect(METHODOLOGY_CONTEXT.safetyScore.versionLabel).toBeUndefined();
    expect(document.querySelector("[data-score-badge-version]")).toBeNull();
    expect(screen.getAllByRole("button", { name: /explain safety score/i }).length).toBeGreaterThan(0);
  });
});
