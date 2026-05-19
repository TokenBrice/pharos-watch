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

  it("renders confidence and depth stack bars with segment widths and summary text", () => {
    const model = buildYieldSourceBoardModel([
      makeBoardRanking(),
      makeBoardRanking({
        id: "usdt-tether",
        symbol: "USDT",
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
      makeBoardRanking({
        id: "dai-maker",
        symbol: "DAI",
        apy30d: 7,
        yieldSource: "Sky DAI",
        dataSource: "defillama",
        provenance: makeYieldProvenance({
          sourceKey: "sky-dai",
          confidenceTier: "curated",
          sourceSwitch: false,
          anomalies: [],
        }),
        altSources: [],
      }),
    ]);

    render(<YieldSourceBoard model={model} />);

    const confidenceBar = screen.getByRole("img", { name: /Confidence tier mix:/i });
    expect(confidenceBar.getAttribute("aria-label")).toBe(
      "Confidence tier mix: 1 deterministic, 2 curated",
    );

    const confidenceSegments = confidenceBar.querySelectorAll("span[style]");
    // deterministic=1, curated=2 -> two non-zero segments
    expect(confidenceSegments.length).toBe(2);
    const widthValues = Array.from(confidenceSegments).map((node) =>
      (node as HTMLElement).style.width,
    );
    // 1/3 and 2/3 of 100%
    expect(widthValues).toEqual([
      `${(1 / 3) * 100}%`,
      `${(2 / 3) * 100}%`,
    ]);

    expect(screen.getByText(/1 deterministic · 2 curated/)).toBeTruthy();
  });

  it("hides confidence and depth bars when there are no counts to show", () => {
    const model = buildYieldSourceBoardModel([
      makeBoardRanking({ provenance: null, altSources: [] }),
    ]);
    // override to simulate zero confidence/depth counts (everything unknown)
    const zeroModel = {
      ...model,
      selectedConfidenceCounts: { deterministic: 0, curated: 0, discovered: 0, fallback: 0 },
      selectedConfidenceUnknownCount: 0,
      depthCounts: { deep: 0, moderate: 0, thin: 0, unknown: 0 },
    };

    render(<YieldSourceBoard model={zeroModel} />);

    expect(screen.queryByRole("img", { name: /Confidence tier mix/i })).toBeNull();
    expect(screen.queryByRole("img", { name: /Depth mix/i })).toBeNull();
  });

  it("does not render an empty board", () => {
    const { container } = render(<YieldSourceBoard model={buildYieldSourceBoardModel([])} />);

    expect(container.textContent).toBe("");
  });
});
