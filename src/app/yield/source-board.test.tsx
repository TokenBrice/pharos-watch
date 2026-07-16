// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
    expect(screen.getByRole("button", { name: /^source changed: 1 row$/i })).toBeTruthy();

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

    const confidenceBar = screen.getByRole("group", { name: /Confidence tier mix:/i });
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
    expect(screen.getByRole("group", { name: /Source posture mix:/i })).toBeTruthy();
    expect(screen.getByText(/3 watch/)).toBeTruthy();
  });

  it("turns source-quality segments into filters when a handler is provided", () => {
    const onFilterChange = vi.fn();
    const model = buildYieldSourceBoardModel([
      makeBoardRanking(),
    ]);

    render(<YieldSourceBoard model={model} onFilterChange={onFilterChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Watch: 1\..*Filter rows/i }));
    expect(onFilterChange).toHaveBeenCalledWith("sourcePosture", "watch-only");
  });

  it("keeps source-quality filter segments at the 24px target floor", () => {
    const model = buildYieldSourceBoardModel([makeBoardRanking()]);

    render(<YieldSourceBoard model={model} onFilterChange={vi.fn()} />);

    const watchSegment = screen.getByRole("button", { name: /Watch: 1\..*Filter rows/i });
    expect(watchSegment.className).toContain("h-6");
    expect(watchSegment.className).toContain("min-w-6");
    expect(watchSegment.querySelector('span[aria-hidden="true"]')?.className).toContain("top-2 h-2");
  });

  it("uses inverse-surface contrast for source-quality tooltip descriptions", async () => {
    const model = buildYieldSourceBoardModel([makeBoardRanking()]);

    render(<YieldSourceBoard model={model} onFilterChange={vi.fn()} />);

    fireEvent.focus(screen.getByRole("button", { name: /Watch: 1\..*Filter rows/i }));

    const descriptions = await screen.findAllByText(/Medium or explainable source-risk evidence/i);
    expect(descriptions.length).toBeGreaterThan(0);
    for (const description of descriptions) {
      expect(description.className).toContain("text-background/75");
      expect(description.className).not.toContain("text-muted-foreground");
    }
  });

  it("clears an active source-quality segment when clicked again", () => {
    const onFilterChange = vi.fn();
    const model = buildYieldSourceBoardModel([
      makeBoardRanking(),
    ]);

    render(
      <YieldSourceBoard
        model={model}
        activeFilters={{ sourcePosture: "watch-only" }}
        onFilterChange={onFilterChange}
      />,
    );

    const watchSegment = screen.getByRole("button", { name: /Watch: 1\..*Clear filter/i });
    expect(watchSegment.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(watchSegment);
    expect(onFilterChange).toHaveBeenCalledWith("sourcePosture", "all");
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
      postureCounts: { clean: 0, watch: 0, speculative: 0 },
      topSourceRiskDrivers: [],
    };

    render(<YieldSourceBoard model={zeroModel} />);

    expect(screen.queryByRole("group", { name: /Confidence tier mix/i })).toBeNull();
    expect(screen.queryByRole("group", { name: /Depth mix/i })).toBeNull();
    expect(screen.queryByRole("group", { name: /Source posture mix/i })).toBeNull();
    expect(screen.getByText(/No populated source-risk drivers/i)).toBeTruthy();
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
