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

  it("renders the source-mix heading, anomaly chips, and per-lane observation counts", () => {
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

    expect(screen.getByRole("heading", { name: "Source mix in the current view" })).toBeTruthy();
    expect(screen.getByText(/Counts every chosen source plus retained alternates/i)).toBeTruthy();
    expect(screen.getByText("1 source changed")).toBeTruthy();
    expect(screen.getByText("1 chosen source with anomalies")).toBeTruthy();

    const laneList = screen.getByRole("list", { name: "Yield source lanes" });
    expect(within(laneList).getAllByRole("listitem").length).toBe(model.groups.length);
    expect(within(laneList).getAllByText(/observation/).length).toBe(model.groups.length);

    expect(screen.queryByText(/Chosen-source confidence/i)).toBeNull();
    expect(screen.queryByText(/Observation APY/i)).toBeNull();
    expect(screen.queryByText(/Depth lens/i)).toBeNull();
    expect(screen.queryByText(/Benchmarks in view/i)).toBeNull();
    expect(screen.queryByText(/not guaranteed executable capacity/i)).toBeNull();
  });

  it("does not render an empty board", () => {
    const { container } = render(<YieldSourceBoard model={buildYieldSourceBoardModel([])} />);

    expect(container.textContent).toBe("");
  });
});
