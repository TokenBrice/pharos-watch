// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { YieldSourceBoard } from "@/app/yield/source-board";
import { buildYieldSourceBoardModel } from "@/app/yield/source-board-model";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "./test-helpers";

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
  afterEach(() => {
    cleanup();
  });

  it("renders exact source counts, selected-source confidence, observation APY, and caveat text", () => {
    const model = buildYieldSourceBoardModel([
      makeBoardRanking(),
      makeBoardRanking({
        id: "usdt-tether",
        symbol: "USDT",
        name: "Tether",
        apy30d: 6,
        yieldSource: "Morpho USDT",
        dataSource: "protocol-api",
        provenance: makeYieldProvenance({
          sourceKey: "morpho-usdt",
          confidenceTier: "curated",
          sourceSwitch: false,
          anomalies: [],
        }),
        altSources: [],
      }),
    ]);

    render(<YieldSourceBoard model={model} />);

    expect(screen.getByRole("heading", { name: "Source provenance in the current view" })).toBeTruthy();
    expect(screen.getByText(/This is provenance coverage, not a recommendation ranking/i)).toBeTruthy();
    expect(screen.getByText("Chosen-source confidence")).toBeTruthy();
    expect(screen.queryByText(/alternate-source confidence/i)).toBeNull();

    const sourceCounts = screen.getByText("Source observations").closest("dl");
    expect(sourceCounts ? within(sourceCounts).getByText("Chosen sources") : null).toBeTruthy();
    expect(sourceCounts ? within(sourceCounts).getByText("2") : null).toBeTruthy();
    expect(sourceCounts ? within(sourceCounts).getByText("Retained alternates") : null).toBeTruthy();
    expect(sourceCounts ? within(sourceCounts).getByText("1") : null).toBeTruthy();
    expect(sourceCounts ? within(sourceCounts).getByText("3") : null).toBeTruthy();

    expect(screen.getByText("1 source changed")).toBeTruthy();
    expect(screen.getByText("1 chosen source with anomalies")).toBeTruthy();
    expect(screen.getAllByText("Observation APY").length).toBeGreaterThan(1);
    expect(screen.getByText("4.00% / 4.00% / 4.00%")).toBeTruthy();
    expect(screen.getByText("USD 3M T-Bill")).toBeTruthy();
    expect(screen.getByText(/not guaranteed executable capacity/i)).toBeTruthy();
  });

  it("does not render an empty board", () => {
    const { container } = render(<YieldSourceBoard model={buildYieldSourceBoardModel([])} />);

    expect(container.textContent).toBe("");
  });
});
