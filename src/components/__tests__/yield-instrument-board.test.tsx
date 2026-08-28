// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { YieldInstrumentBoard } from "@/components/yield-instrument-board";
import type { YieldTableSortKey } from "@/components/yield-table-logic";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import { makeYieldViewModelRow, renderYieldMobileCard, YIELD_TEST_PROVENANCE } from "./yield-test-support";

vi.mock("@/components/yield-history-chart", () => ({
  YieldHistoryChart: () => <div data-testid="yield-history-chart" />,
}));

const baseRow = makeYieldViewModelRow({
  benchmarkLabel: "USD 3M T-Bill",
  warningSignals: [],
  provenance: { ...YIELD_TEST_PROVENANCE, sourceFreshness: "fresh" },
  sourceRisk: { sourceRiskScore: 70, sourceRiskPenalty: 1.02, sourceAgeSeconds: 60 },
});

function renderMobileCard(
  row: YieldViewModelRow,
  expanded = false,
  overrides: { isCompared?: boolean; compareDisabled?: boolean; onToggleCompare?: (id: string) => void } = {},
) {
  return renderYieldMobileCard(row, { expanded, ...overrides });
}

function renderBoard(
  row: YieldViewModelRow,
  expanded: boolean = false,
  overrides: {
    isCompared?: boolean;
    compareDisabled?: boolean;
    onToggleCompare?: (id: string) => void;
    onToggleSort?: (key: YieldTableSortKey) => void;
  } = {},
) {
  return render(
    <TooltipProvider>
      <YieldInstrumentBoard
        rows={[row]}
        logos={{}}
        riskFreeRate={3.5}
        medianApy={4}
        scalingFactor={1}
        pageStartIndex={0}
        sortKey="pys"
        sortDirection="desc"
        onToggleSort={overrides.onToggleSort ?? vi.fn()}
        rangeStart={1}
        rangeEnd={1}
        total={1}
        expandedId={expanded ? row.id : null}
        compareHas={() => overrides.isCompared ?? false}
        compareCanAdd={!(overrides.compareDisabled ?? false)}
        onPrefetch={vi.fn()}
        onToggleExpanded={vi.fn()}
        onOpenSourceSheet={vi.fn()}
        onToggleCompare={overrides.onToggleCompare ?? vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe("YieldInstrumentBoard", () => {
  it("renders the rank-attribution chip when pys delta is material", () => {
    const row = {
      ...baseRow,
      rankChangeAttribution: {
        rankDelta: 3,
        pysDelta: 2.4,
        primaryDriver: "apy",
      },
    } as YieldViewModelRow;

    renderBoard(row);

    expect(screen.getByLabelText("Rank change: +3, driver APY")).toBeTruthy();
  });

  it("omits the rank chip when pys delta is below threshold", () => {
    const row = {
      ...baseRow,
      rankChangeAttribution: {
        rankDelta: 1,
        pysDelta: 0.3,
        primaryDriver: "apy",
      },
    } as YieldViewModelRow;

    renderBoard(row);

    expect(screen.queryByLabelText(/Rank change/)).toBeNull();
  });

  it("renders a null PYS reason tooltip when pysNullReason is set", () => {
    const row = {
      ...baseRow,
      pharosYieldScore: null,
      pysNullReason: "missing-inputs",
    } as YieldViewModelRow;

    renderBoard(row);

    const dashes = screen.getAllByText("—");
    const cursorHelpDash = dashes.find((el) => el.className.includes("cursor-help"));
    expect(cursorHelpDash).toBeTruthy();
  });

  it("renders the Deep dive link with proper href", () => {
    renderBoard(baseRow);

    const link = screen.getByRole("link", { name: "Open full yield analysis for USDT" });
    expect(link.getAttribute("href")).toBe("/stablecoin/usdt-tether/yield");
  });

  it("renders a labeled source-risk summary when the source penalty is material", () => {
    const row = {
      ...baseRow,
      sourceRisk: { sourceRiskScore: 42, sourceRiskPenalty: 1.32, sourceAgeSeconds: 60 },
    } as YieldViewModelRow;

    renderBoard(row);

    expect(screen.getByText("Source risk 42/100 | 1.32x")).toBeTruthy();
  });

  it("reads a native row with no venue TVL as Native depth-not-applicable, board and card alike", () => {
    // `rebase` keeps the yield-type badge off the word "Native", so the only
    // "Native" in the DOM is the TVL cell under test.
    const row = {
      ...baseRow,
      yieldType: "rebase",
      sourceTvlUsd: null,
      sourceDepthLens: "unknown",
    } as YieldViewModelRow;

    const desktop = renderBoard(row);
    expect(screen.getByText("Native")).toBeTruthy();
    expect(screen.getByText("Venue TVL not applicable: yield accrues on the asset itself")).toBeTruthy();
    expect(screen.getByText("Native · depth n/a")).toBeTruthy();
    expect(screen.queryByText("Unknown depth")).toBeNull();
    desktop.unmount();

    renderMobileCard(row);
    expect(screen.getByText("Native")).toBeTruthy();
    expect(screen.getByText("Native · depth n/a")).toBeTruthy();
    expect(screen.queryByText("Depth: Unknown")).toBeNull();
  });

  it("keeps the em dash and unknown depth for an external opportunity with no venue TVL", () => {
    const row = {
      ...baseRow,
      yieldType: "lending-opportunity",
      sourceTvlUsd: null,
      sourceDepthLens: "unknown",
    } as YieldViewModelRow;

    renderBoard(row);

    expect(screen.getByText("TVL unavailable")).toBeTruthy();
    expect(screen.getByText("Unknown depth")).toBeTruthy();
    expect(screen.queryByText("Native")).toBeNull();
    expect(screen.queryByText("Native · depth n/a")).toBeNull();
  });

  it("renders published stale status for a 4h-old default source", () => {
    const row = {
      ...baseRow,
      provenance: { ...baseRow.provenance, sourceFreshness: "stale" },
      sourceRisk: { ...baseRow.sourceRisk, sourceAgeSeconds: 4 * 60 * 60 },
    } as YieldViewModelRow;

    renderBoard(row);

    const freshness = screen.getByText("Stale · 4h ago");
    expect(freshness.className).toContain("text-amber-700");
    expect(screen.queryByText("Fresh · 4h ago")).toBeNull();
  });

  it("renders published fresh status for a 30h-old price-derived source", () => {
    const row = {
      ...baseRow,
      dataSource: "price-derived",
      provenance: { ...baseRow.provenance, calculationMode: "price-return", sourceFreshness: "fresh" },
      sourceRisk: { ...baseRow.sourceRisk, sourceAgeSeconds: 30 * 60 * 60 },
    } as YieldViewModelRow;

    renderMobileCard(row);

    const freshness = screen.getByText("Fresh · 1d ago");
    expect(freshness.className).toContain("text-emerald-700");
    expect(screen.queryByText("Stale · 1d ago")).toBeNull();
  });

  it("invokes onToggleCompare with the row id when the compare checkbox is clicked", () => {
    const onToggleCompare = vi.fn();
    renderBoard(baseRow, false, { onToggleCompare });

    fireEvent.click(screen.getByLabelText("Add USDT to compare"));

    expect(onToggleCompare).toHaveBeenCalledWith("usdt-tether");
  });

  it("renders sort pills wired to the sort handler", () => {
    const onToggleSort = vi.fn();
    renderBoard(baseRow, false, { onToggleSort });

    fireEvent.click(screen.getByRole("button", { name: /APY sort/ }));
    expect(onToggleSort).toHaveBeenCalledWith("apy30d");
  });

  it("keeps core board and mobile card row affordances in parity", () => {
    const desktop = renderBoard(baseRow);
    const desktopDisplay = desktop.container.querySelector(`[data-yield-row-display="${baseRow.id}"]`);
    const displayAttributes = [
      "data-yield-grade",
      "data-yield-safety-score",
      "data-yield-pys",
      "data-yield-source-risk",
      "data-yield-freshness",
      "data-yield-warning-count",
      "data-yield-benchmark",
    ];
    const desktopContract = Object.fromEntries(
      displayAttributes.map((attribute) => [attribute, desktopDisplay?.getAttribute(attribute)]),
    );
    expect(screen.getAllByText("30-day APY: 4.3 percent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Pharos Yield Score 76.0 out of 100").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByLabelText("Safety grade: B+, score 82 out of 100").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText("Add USDT to compare")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full yield analysis for USDT" }).getAttribute("href")).toBe(
      "/stablecoin/usdt-tether/yield",
    );
    expect(desktop.container.textContent).toContain("Aave");
    // No warnings → the board surfaces no warning indicator (clean row, tint only).
    expect(screen.queryByLabelText(/warning signal/)).toBeNull();
    desktop.unmount();

    const mobile = renderMobileCard(baseRow);
    const mobileDisplay = mobile.container.querySelector(`[data-yield-row-display="${baseRow.id}"]`);
    expect(Object.fromEntries(
      displayAttributes.map((attribute) => [attribute, mobileDisplay?.getAttribute(attribute)]),
    )).toEqual(desktopContract);
    expect(screen.getByText("4.30%")).toBeTruthy();
    expect(screen.getByText("PYS 76.0")).toBeTruthy();
    expect(screen.getByText("B+")).toBeTruthy();
    expect(screen.getByLabelText("Add USDT to compare")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full yield analysis for USDT" }).getAttribute("href")).toBe(
      "/stablecoin/usdt-tether/yield",
    );
    expect(mobile.container.textContent).toContain("Aave");
    expect(mobile.container.textContent).toContain("No warnings");
  });
});

describe("YieldInstrumentBoard — Why this PYS strip", () => {
  it("renders the strip with all four factor cells when expanded with a non-null PYS", () => {
    renderBoard(baseRow, true);

    const strip = screen.getByRole("group", { name: "Why this PYS" });
    expect(strip).toBeTruthy();
    expect(strip.textContent).toContain("Bench spread");
    expect(strip.textContent).toContain("vs USD 3M T-Bill");
    expect(strip.textContent).toContain("Stability");
    expect(strip.textContent).toContain("90%");
    expect(strip.textContent).toContain("30d APY variance");
    expect(strip.textContent).toContain("Safety");
    expect(strip.textContent).toContain("B+");
    expect(strip.textContent).toContain("Source risk");
    expect(strip.textContent).toContain("1.02×");
    expect(strip.textContent).toContain("Neutral");
  });

  it("hides the strip when expanded with a null PYS but still renders the chart", () => {
    const row = { ...baseRow, pharosYieldScore: null } as YieldViewModelRow;
    renderBoard(row, true);

    expect(screen.queryByRole("group", { name: "Why this PYS" })).toBeNull();
    expect(screen.getByTestId("yield-history-chart")).toBeTruthy();
  });

  it("renders the decision-ledger card in expanded row details", () => {
    const row = {
      ...baseRow,
      decisionLedger: {
        selectedReasonCode: "curated-over-discovered",
        sourceSwitch: false,
        rejectedCount: 1,
        alternatives: [],
      },
    } as YieldViewModelRow;

    renderBoard(row, true);

    expect(screen.getByLabelText("Why this source won")).toBeTruthy();
    expect(screen.getByText("Curated source preferred")).toBeTruthy();
    expect(screen.getByText("1 alternate rejected")).toBeTruthy();
  });

  it("does not render the strip when the row is collapsed", () => {
    renderBoard(baseRow, false);
    expect(screen.queryByRole("group", { name: "Why this PYS" })).toBeNull();
  });
});

describe("YieldInstrumentBoard — cohort percentile chip", () => {
  it("renders the percentile chip when cohortPercentile has a numeric value", () => {
    const row = {
      ...baseRow,
      cohortPercentile: { value: 64, cohortSize: 18, cohortKey: "USD:lending-vault" },
    } as YieldViewModelRow;

    renderBoard(row);

    expect(screen.getByText("p64 of 18")).toBeTruthy();
  });

  it("renders the small-peer-set chip when cohortPercentile.value is null", () => {
    const row = {
      ...baseRow,
      cohortPercentile: { value: null, cohortSize: 4, cohortKey: "EUR:lending-vault" },
    } as YieldViewModelRow;

    renderBoard(row);

    expect(screen.getByText("small peer set")).toBeTruthy();
  });

  it("renders nothing when cohortPercentile is null", () => {
    const row = { ...baseRow, cohortPercentile: null } as YieldViewModelRow;

    renderBoard(row);

    expect(screen.queryByText(/^p\d+ of \d+/)).toBeNull();
    expect(screen.queryByText("small peer set")).toBeNull();
  });
});
