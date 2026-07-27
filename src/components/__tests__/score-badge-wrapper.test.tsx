// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";

afterEach(cleanup);

describe("ScoreBadgeWrapper", () => {
  it("renders the wrapped badge with an inline version suffix in suffix mode", () => {
    render(
      <ScoreBadgeWrapper topic="liquidityScore">
        <span data-testid="badge-content">B+</span>
      </ScoreBadgeWrapper>,
    );

    const versionLabel = METHODOLOGY_CONTEXT.liquidityScore.versionLabel;
    expect(versionLabel).toBeTruthy();

    // Badge content reaches the DOM (rendered through Sheet + Tooltip triggers).
    expect(screen.getAllByTestId("badge-content").length).toBeGreaterThan(0);
    const trigger = screen.getAllByRole("button", { name: /explain liquidity score/i })[0];
    expect(trigger).toBeTruthy();
    expect(trigger.className).toContain("min-h-11");
    expect(trigger.className).toContain("min-w-11");

    // Inline version suffix is rendered alongside the trigger.
    expect(screen.getByText(versionLabel as string)).toBeTruthy();
  });

  it("hides the version suffix in tooltip-only mode", () => {
    render(
      <ScoreBadgeWrapper topic="liquidityScore" variant="tooltip-only">
        <span data-testid="badge-content">82</span>
      </ScoreBadgeWrapper>,
    );

    const versionLabel = METHODOLOGY_CONTEXT.liquidityScore.versionLabel;
    expect(versionLabel).toBeTruthy();

    expect(screen.getAllByTestId("badge-content").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /explain liquidity score/i }).length).toBeGreaterThan(0);
    expect(screen.queryByText(versionLabel as string)).toBeNull();
  });

  it("can override the methodology trigger accessible label", () => {
    render(
      <ScoreBadgeWrapper
        topic="mintAuthorityScore"
        variant="tooltip-only"
        triggerAriaLabel="Mint Authority Score 70/100, Governed. Explain methodology."
      >
        <span data-testid="badge-content">70/100</span>
      </ScoreBadgeWrapper>,
    );

    expect(
      screen.getAllByRole("button", {
        name: /mint authority score 70\/100, governed\. explain methodology\./i,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("omits the suffix when the topic has no version label", () => {
    // `totalStablecoinMcap` has no methodology version.
    render(
      <ScoreBadgeWrapper topic="totalStablecoinMcap">
        <span data-testid="badge-content">$280B</span>
      </ScoreBadgeWrapper>,
    );

    expect(METHODOLOGY_CONTEXT.totalStablecoinMcap.versionLabel).toBeUndefined();
    expect(screen.getAllByTestId("badge-content").length).toBeGreaterThan(0);
    // No <sup> with a version label rendered.
    expect(document.querySelector("[data-score-badge-version]")).toBeNull();
  });

  it("can render a non-interactive badge for link-wrapped cards", () => {
    render(
      <ScoreBadgeWrapper topic="safetyScore" interactive={false}>
        <span data-testid="badge-content">A</span>
      </ScoreBadgeWrapper>,
    );

    expect(screen.getByTestId("badge-content")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /explain safety score/i })).toBeNull();
  });
});
