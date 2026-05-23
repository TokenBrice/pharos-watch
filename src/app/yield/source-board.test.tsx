// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { YieldSourceBoard } from "@/app/yield/source-board";
import { buildYieldSourceBoardModel } from "@/app/yield/source-board-model";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "@/test/fixtures/yield";

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

  it("renders the source-mix heading, disclosure toggles, and per-lane observation counts", () => {
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
    expect(screen.getByRole("button", { name: /1 source changed/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /1 chosen source with anomalies/i })).toBeTruthy();

    const laneList = screen.getByRole("list", { name: "Yield source lanes" });
    expect(within(laneList).getAllByRole("listitem").length).toBe(model.groups.length);
    expect(within(laneList).getAllByText(/observation/).length).toBe(model.groups.length);

    expect(screen.queryByText(/Provenance/i)).toBeNull();
    expect(screen.queryByText(/Per-coin yield/i)).toBeNull();
    expect(screen.queryByText(/Pharos Yield Score \(PYS\)/i)).toBeNull();
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
    expect(confidenceSegments.length).toBe(2);
    const widthValues = Array.from(confidenceSegments).map((node) =>
      (node as HTMLElement).style.width,
    );
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

  it("toggles the anomaly disclosure inline and lists affected coins with their reason", () => {
    const model = buildYieldSourceBoardModel([
      makeBoardRanking({ id: "usde-ethena", symbol: "USDe" }),
    ]);

    render(<YieldSourceBoard model={model} />);

    const trigger = screen.getByRole("button", { name: /1 chosen source with anomalies/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Low source TVL")).toBeTruthy();
    expect(screen.getByRole("link", { name: "USDe" })).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("only shows the top 5 lanes by default and reveals the rest via the ledger toggle", () => {
    const ranks = Array.from({ length: 7 }, (_, idx) =>
      makeBoardRanking({
        id: `coin-${idx}`,
        symbol: `C${idx}`,
        name: `Coin ${idx}`,
        dataSource: `source-${idx}`,
        altSources: [],
        provenance: makeYieldProvenance({
          sourceKey: `source-${idx}`,
          confidenceTier: "curated",
          sourceSwitch: false,
          anomalies: [],
        }),
      }),
    );
    const model = buildYieldSourceBoardModel(ranks);
    expect(model.groups.length).toBe(7);

    render(<YieldSourceBoard model={model} />);

    const visibleLanes = screen.getByRole("list", { name: "Yield source lanes" });
    expect(within(visibleLanes).getAllByRole("listitem").length).toBe(5);

    const toggle = screen.getByRole("button", { name: /Show full ledger \(2 more lanes\)/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const extraLanes = screen.getByRole("list", { name: "Additional yield source lanes" });
    expect(within(extraLanes).getAllByRole("listitem").length).toBe(2);
    expect(screen.getByRole("button", { name: /Collapse ledger/i })).toBeTruthy();
  });
});
