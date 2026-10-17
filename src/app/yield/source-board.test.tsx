// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { YieldSourceBoard } from "@/components/yield/yield-source-board";
import { buildYieldSourceBoardModel } from "@/lib/yield-source-board-model";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";

function makeBoardRanking(overrides = {}) {
  return makeYieldRanking({
    altSources: [makeAltYieldSource()],
    provenance: makeYieldProvenance({
      confidenceTier: "deterministic",
      sourceSwitch: true,
      previousBestSourceKey: "previous-source",
      anomalies: ["low-source-tvl"],
    }),
    ...overrides,
  });
}

describe("YieldSourceBoard", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });


  it("discloses bounded composition and unavailable anomalies on the summary path", () => {
    const rankings = [makeBoardRanking({
      provenance: null,
      altSources: Array.from({ length: 10 }, (_, i) => makeAltYieldSource({ sourceKey: `alt-${i}` })),
    })];
    const summary = projectYieldRankingsSummary({ rankings, riskFreeRate: 4, scalingFactor: 8, medianApy: null, updatedAt: 1_800_000_000 });
    render(<YieldSourceBoard model={buildYieldSourceBoardModel(summary.rankings)} />);
    expect(screen.getByText(/Lanes show 9 of 11 sources/)).toBeTruthy();
    expect(screen.getByText(/Anomaly evidence unavailable for 1 chosen source/)).toBeTruthy();
    expect(screen.queryByText(/Counts every chosen source plus retained alternates/)).toBeNull();
  });

});
