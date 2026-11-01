// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { YieldInstrumentBoard } from "@/components/yield-instrument-board";
import type { YieldBenchmarkRegistry } from "@shared/types";
import type { YieldTableSortKey } from "@/components/yield-table-logic";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import { REGISTRY_WITH_EUR, makeYieldViewModelRow, renderYieldMobileCard, YIELD_TEST_PROVENANCE } from "./yield-test-support";

vi.mock("@/components/yield-history-chart", () => ({
  YieldHistoryChart: ({ benchmarkRate, benchmarkLabel }: { benchmarkRate: number | null; benchmarkLabel?: string }) => (
    <div data-testid="yield-history-chart" data-benchmark-rate={benchmarkRate} data-benchmark-label={benchmarkLabel} />
  ),
}));

const baseRow = makeYieldViewModelRow({
  benchmarkLabel: "USD 3M T-Bill",
  benchmarkRate: 3.7,
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
    benchmarks?: YieldBenchmarkRegistry | null;
    methodologyVersion?: string | null;
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
        benchmarks={overrides.benchmarks}
        methodologyVersion={overrides.methodologyVersion}
      />
    </TooltipProvider>,
  );
}

const rowRenderers = [
  ["desktop", renderBoard],
  ["mobile", renderMobileCard],
] as const;

describe("YieldInstrumentBoard", () => {
  it.each([
    { apy30d: 4.3, spread: "+0.60 pp" },
    { apy30d: 2.5, spread: "-1.20 pp" },
    { apy30d: 3.699, spread: "+0.00 pp" },
  ])("labels the collapsed board benchmark difference in pp: $spread", ({ apy30d, spread }) => {
    const { container } = renderBoard({ ...baseRow, apy30d });
    expect(container.textContent).toContain(`${spread} vs USD 3M T-Bill`);
    expect(screen.getByText(`30-day APY: ${apy30d.toFixed(2)}%`)).toBeTruthy();
  });

  it("marks the current APY inside the 30-day range, not the 30-day mean", () => {
    renderBoard({
      ...baseRow,
      currentApy: 9.8,
      apy30d: 4.3,
      apyMin30d: 4,
      apyMax30d: 9.9,
    });
    const marker = screen.getByRole("img", { name: "30 day APY range 4.0% to 9.9%, current 9.8%" });
    const dot = marker.querySelectorAll("div")[1]!;
    expect(Number.parseFloat(dot.style.left)).toBeCloseTo(((9.8 - 4) / (9.9 - 4)) * 100, 6);
  });

  it("places the range marker at the low edge after an APY collapse", () => {
    renderBoard({
      ...baseRow,
      currentApy: 4,
      apy30d: 9,
      apyMin30d: 4,
      apyMax30d: 9.9,
    });
    const marker = screen.getByRole("img", { name: "30 day APY range 4.0% to 9.9%, current 4.0%" });
    expect(Number.parseFloat(marker.querySelectorAll("div")[1]!.style.left)).toBe(0);
  });

  it.each(rowRenderers)("routes dynamically covered USDC to the honest fallback on %s", (_name, renderRow) => {
    renderRow({ ...baseRow, id: "usdc-circle", symbol: "USDC" });
    expect(screen.getByRole("link", { name: "View yield opportunities for USDC" }).getAttribute("href"))
      .toBe("/yield?workbenchFallback=usdc-circle");
  });
  it.each(rowRenderers)("retains the exported workbench link on %s", (_name, renderRow) => {
    renderRow({ ...baseRow, id: "susde-ethena", symbol: "sUSDe" });
    expect(screen.getByRole("link", { name: "View full yield analysis for sUSDe" }).getAttribute("href"))
      .toBe("/stablecoin/susde-ethena/yield");
  });
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

  it.each(rowRenderers)("renders the deep-dive destination on %s", (_surface, renderRow) => {
    renderRow(baseRow);

    const link = screen.getByRole("link", { name: "View yield opportunities for USDT" });
    expect(link.getAttribute("href")).toBe("/yield?workbenchFallback=usdt-tether");
  });

  it.each(rowRenderers)("renders material source risk on %s", (_surface, renderRow) => {
    const row = {
      ...baseRow,
      sourceRisk: { sourceRiskScore: 42, sourceRiskPenalty: 1.32, sourceAgeSeconds: 60 },
    } as YieldViewModelRow;

    renderRow(row);

    expect(screen.getByText("Source risk 42/100 | 1.32x")).toBeTruthy();
  });

  it.each([null, undefined])("discloses score-only risk with penalty %s in the board indicator", async (sourceRiskPenalty) => {
    renderBoard({ ...baseRow, sourceRisk: { sourceRiskScore: 42, sourceRiskPenalty } });
    const indicator = screen.getByRole("button", { name: "Source risk 42/100 | n/a" });
    fireEvent.focus(indicator);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Source risk 42/100 | n/a");
    expect(tooltip.textContent).not.toMatch(/0\.00[x×]|1\.00[x×]/);
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

  it("labels a scoring-stale 4h-old default source neutrally below the public gate", () => {
    const row = {
      ...baseRow,
      provenance: { ...baseRow.provenance, sourceFreshness: "stale" },
      sourceRisk: { ...baseRow.sourceRisk, sourceAgeSeconds: 4 * 60 * 60 },
    } as YieldViewModelRow;

    renderBoard(row);

    const freshness = screen.getByText("Observed 4h ago");
    expect(freshness.className).not.toContain("text-state-warn");
    expect(screen.queryByText("Stale · 4h ago")).toBeNull();
    expect(screen.queryByText("stale source")).toBeNull();
  });

  it("labels a 30h-old price-derived source by its observation age", () => {
    const row = {
      ...baseRow,
      dataSource: "price-derived",
      provenance: { ...baseRow.provenance, calculationMode: "price-return", sourceFreshness: "fresh" },
      sourceRisk: { ...baseRow.sourceRisk, sourceAgeSeconds: 30 * 60 * 60 },
    } as YieldViewModelRow;

    renderMobileCard(row);

    const freshness = screen.getByText("Observed 1d ago");
    expect(freshness.className).toContain("text-foreground");
    expect(screen.queryByText("Stale · 1d ago")).toBeNull();
  });

  it.each(rowRenderers)("toggles compare by row identity on %s", (_surface, renderRow) => {
    const onToggleCompare = vi.fn();
    renderRow(baseRow, false, { onToggleCompare });

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
    expect(screen.getAllByText("30-day APY: 4.30%").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Pharos Yield Score 76.0 out of 100").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByLabelText("Safety grade: B+, score 82 out of 100").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText("Add USDT to compare")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View yield opportunities for USDT" }).getAttribute("href")).toBe(
      "/yield?workbenchFallback=usdt-tether",
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
    expect(screen.getByRole("link", { name: "View yield opportunities for USDT" }).getAttribute("href")).toBe(
      "/yield?workbenchFallback=usdt-tether",
    );
    expect(mobile.container.textContent).toContain("Aave");
    expect(mobile.container.textContent).toContain("No warnings");
  });
});

describe("YieldInstrumentBoard — Why this PYS strip", () => {
  it.each(rowRenderers)("renders expanded PYS factors on %s", (_surface, renderRow) => {
    renderRow(baseRow, true);

    const strip = screen.getByRole("group", { name: "Why this PYS" });
    expect(strip).toBeTruthy();
    expect(strip.textContent).toContain("Bench spread");
    expect(strip.textContent).toContain("+0.60 pp");
    expect(strip.textContent).not.toContain("+0.60%");
    expect(strip.textContent).toContain("vs USD 3M T-Bill (3.70%)");
    expect(strip.textContent).toContain("Stability");
    expect(strip.textContent).toContain("90%");
    expect(strip.textContent).toContain("30d APY variance");
    expect(strip.textContent).toContain("Safety");
    expect(strip.textContent).toContain("B+");
    expect(strip.textContent).toContain("Source risk");
    expect(strip.textContent).toContain("1.02×");
    expect(strip.textContent).toContain("Neutral");
  });

  it.each(rowRenderers)("hides null PYS but keeps history on %s", (_surface, renderRow) => {
    const row = { ...baseRow, pharosYieldScore: null } as YieldViewModelRow;
    renderRow(row, true);

    expect(screen.queryByRole("group", { name: "Why this PYS" })).toBeNull();
    expect(screen.getByTestId("yield-history-chart")).toBeTruthy();
  });

});



// A row published without a benchmarkRate used to fall straight to the
// chart-wide USD risk-free frame; the chip must resolve the row's OWN
// benchmark from the registry first (ZONE-CHIP).
describe("YieldInstrumentBoard — zone chip benchmark resolution", () => {
  function eurRowWithoutRate(): YieldViewModelRow {
    return {
      ...baseRow,
      benchmarkKey: "EUR",
      benchmarkLabel: "EUR 3M compounded €STR",
      benchmarkRate: undefined,
      apy30d: 2.0,
      safetyScore: 82,
    } as YieldViewModelRow;
  }

  it("resolves a missing row rate from the registry EUR entry, not the USD frame", () => {
    // 2.0% APY beats the EUR benchmark (1.94) but not the chart-wide USD
    // frame (3.5): a Sweet Spot chip proves the EUR rate was used.
    renderBoard(eurRowWithoutRate(), false, { benchmarks: REGISTRY_WITH_EUR });
    expect(screen.getByText("Sweet Spot")).toBeTruthy();
    expect(screen.getByText("+0.06 pp vs EUR 3M compounded €STR")).toBeTruthy();
    expect(screen.getByRole("img", { name: /benchmark 1.9 percent/ })).toBeTruthy();
  });

  it("uses the same resolved EUR benchmark for the expanded history chart", () => {
    renderBoard(eurRowWithoutRate(), true, { benchmarks: REGISTRY_WITH_EUR });
    const chart = screen.getByTestId("yield-history-chart");
    expect(chart.getAttribute("data-benchmark-rate")).toBe("1.94");
    expect(chart.getAttribute("data-benchmark-label")).toBe("EUR 3M compounded €STR");
    expect(screen.getByRole("group", { name: "Why this PYS" }).textContent).toContain("Benchmark unavailable");
  });

  it("uses an explicitly USD display frame without attributing it to the published PYS", () => {
    renderBoard(eurRowWithoutRate(), true);
    expect(screen.getByText("Play It Safe")).toBeTruthy();
    const chart = screen.getByTestId("yield-history-chart");
    expect(chart.getAttribute("data-benchmark-rate")).toBe("3.5");
    expect(chart.getAttribute("data-benchmark-label")).toBe("USD benchmark (display fallback)");
    expect(screen.getByRole("group", { name: "Why this PYS" }).textContent).toContain("Benchmark unavailable");
  });
});
