// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";


describe("ScoreBadgeWrapper", () => {

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
