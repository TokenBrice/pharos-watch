// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoreImpactPanel } from "../score-impact-panel";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { makeReserveComposition } from "@shared/types/__tests__/status.test-support";


describe("ScoreImpactPanel", () => {
  it("keeps missing reserve evidence unknown rather than clean or zero", () => {
    const { container } = render(
      <ScoreImpactPanel
        reserveComposition={makeReserveComposition({ status: "unavailable" })}
      />,
    );
    expect(screen.getByText("unavailable")).toBeTruthy();
    expect(screen.queryByText("clean")).toBeNull();
    expect(container.textContent).not.toContain("0.0%");
    expect(screen.getAllByText("Unknown")).toHaveLength(4);
  });
  it("renders conservative reserve input without duplicating the drift watchlist", () => {
    const data = makeHealthyStatusResponse();
    if (data.reserveComposition.status === "unavailable") throw new Error("Expected an observed reserve fixture");
    const reserveComposition = {
      ...data.reserveComposition,
      status: "degraded" as const,
      deferredCoins: 48,
      runBudgetTruncated: true,
      freshCoverageRatio: 0.7365,
      authoritativeFreshCoverageRatio: 0.7329,
      degradedCoins: 71,
    };

    render(
      <ScoreImpactPanel
        reserveComposition={reserveComposition}
      />,
    );

    expect(screen.getByText("Score impact monitor")).toBeTruthy();
    expect(screen.getByText("conservative")).toBeTruthy();
    expect(screen.queryByText("Drift rows")).toBeNull();
    expect(screen.queryByText("Classification warnings")).toBeNull();
    expect(screen.getByText(/Safety Scores may look lower/)).toBeTruthy();
  });

  it("reports a clean reserve input for a healthy lane at live 73.7% score-grade coverage", () => {
    const data = makeHealthyStatusResponse();
    if (data.reserveComposition.status === "unavailable") throw new Error("Expected an observed reserve fixture");

    render(
      <ScoreImpactPanel
        reserveComposition={{
          ...data.reserveComposition,
          freshCoins: 74,
          degradedCoins: 39,
          errorCoins: 7,
          freshCoverageRatio: 0.7374,
          authoritativeFreshCoverageRatio: 0.7374,
        }}
      />,
    );

    expect(screen.getAllByText("73.7%").length).toBeGreaterThan(0);
    expect(screen.queryByText("conservative")).toBeNull();
  });

});
