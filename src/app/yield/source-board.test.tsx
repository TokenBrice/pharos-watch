// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { YieldSourceBoard } from "@/app/yield/source-board";
import { buildYieldSourceBoardModel } from "@/app/yield/source-board-model";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "./test-helpers";
import type {
  YieldBenchmarkRegistry,
  YieldSafetySnapshotMeta,
  YieldSourceInputMeta,
} from "@shared/types";

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

  it("renders the trust band, disclaimer footer, and coin-index navigation when props are supplied", () => {
    const model = buildYieldSourceBoardModel([makeBoardRanking()]);
    const benchmarks: YieldBenchmarkRegistry = {
      USD: {
        key: "USD",
        label: "USD 3M T-Bill",
        currency: "USD",
        rate: 4.25,
        recordDate: "2026-04-23",
        fetchedAt: 1_776_000_000,
        ageSeconds: 60,
        source: "fred-dgs3mo",
        isFallback: false,
        fallbackMode: null,
      },
    };
    const poolInputMeta: YieldSourceInputMeta = {
      mode: "dex-cache",
      updatedAt: 1_776_000_000,
      ageSeconds: 240,
      poolCount: 142,
      fallbackMode: null,
    };
    const safetySnapshot: YieldSafetySnapshotMeta = {
      kind: "ok",
      coverageRatio: 0.91,
      coveredCount: 356,
      trackedCount: 391,
      reason: null,
    };

    render(
      <YieldSourceBoard
        model={model}
        benchmarks={benchmarks}
        poolInputMeta={poolInputMeta}
        safetySnapshot={safetySnapshot}
      />,
    );

    expect(screen.getByText("Provenance")).toBeTruthy();
    expect(screen.getByText("USD 3M T-Bill")).toBeTruthy();
    expect(screen.getByText(/as of 2026-04-23/i)).toBeTruthy();
    expect(screen.getByText(/Pool input age 4m/i)).toBeTruthy();
    expect(screen.getByText("91%")).toBeTruthy();
    expect(screen.getByText(/Pharos Yield Score \(PYS\) is for informational/i)).toBeTruthy();
    expect(screen.getByText("Per-coin yield analysis")).toBeTruthy();
  });
});
