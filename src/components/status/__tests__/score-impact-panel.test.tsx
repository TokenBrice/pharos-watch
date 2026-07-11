// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScoreImpactPanel } from "../score-impact-panel";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

afterEach(() => cleanup());

describe("ScoreImpactPanel", () => {
  it("renders conservative reserve input and affected drift rows", () => {
    const data = makeHealthyStatusResponse();
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
        reserveDrift={[
          {
            coinId: "unknown-coin",
            liveCollateralScore: 52,
            curatedCollateralScore: 78,
            delta: 26,
          },
        ]}
        classificationWarnings={[
          {
            coinId: "unknown-coin",
            governance: "decentralized",
            centralizedCustodyPct: 61,
            threshold: 50,
          },
        ]}
      />,
    );

    expect(screen.getByText("Score impact monitor")).toBeTruthy();
    expect(screen.getByText("conservative")).toBeTruthy();
    expect(screen.getByText("unknown-coin")).toBeTruthy();
    expect(screen.getByText("52.0")).toBeTruthy();
    expect(screen.getByText("78.0")).toBeTruthy();
    expect(screen.getByText("26.0")).toBeTruthy();
    expect(screen.getByText(/Safety Scores may look lower/)).toBeTruthy();
  });

  it("renders absent optional payloads as Unknown instead of zero", () => {
    const data = makeHealthyStatusResponse();

    render(
      <ScoreImpactPanel
        reserveComposition={data.reserveComposition}
        reserveDrift={undefined}
        classificationWarnings={undefined}
      />,
    );

    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    expect(screen.getByText("Reserve drift payload is unavailable; no zero count is inferred.")).toBeTruthy();
  });
});
