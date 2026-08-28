// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HomeAltRankingsSection } from "@/components/home-alt-rankings-section";

const {
  stablecoinTablePropsMock,
  togglePinnedMock,
  useStablecoinsMock,
  usePegSummaryMock,
  useDexLiquidityMock,
  useReportCardsV9Mock,
  useStressSignalsMock,
  useHomeAltFiltersMock,
  usePinnedStablecoinsMock,
  setActiveUniverseMock,
} = vi.hoisted(() => ({
  stablecoinTablePropsMock: vi.fn(),
  togglePinnedMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
  usePegSummaryMock: vi.fn(),
  useDexLiquidityMock: vi.fn(),
  useReportCardsV9Mock: vi.fn(),
  useStressSignalsMock: vi.fn(),
  useHomeAltFiltersMock: vi.fn(),
  usePinnedStablecoinsMock: vi.fn(),
  setActiveUniverseMock: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: (loader: () => unknown) => {
    const source = String(loader);
    if (source.includes("stablecoin-table")) {
      function MockStablecoinTable(props: Record<string, unknown>) {
        stablecoinTablePropsMock(props);
        return <div data-testid="stablecoin-table" />;
      }

      return MockStablecoinTable;
    }

    return () => null;
  },
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: usePegSummaryMock,
  useDexLiquidity: useDexLiquidityMock,
  useReportCardsV9: useReportCardsV9Mock,
  useStressSignals: useStressSignalsMock,
}));

vi.mock("@/hooks/use-home-alt-filters", () => ({
  useHomeAltFilters: useHomeAltFiltersMock,
}));

vi.mock("@/hooks/use-pinned-stablecoins", () => ({
  usePinnedStablecoins: usePinnedStablecoinsMock,
}));

vi.mock("@/components/homepage-client-view-model", () => ({
  buildHomepageCriticalViewModel: () => ({
    pegRates: {},
    pegScores: new Map(),
    filteredRowCount: 392,
  }),
  buildHomepageOptionalViewModel: () => ({
    reportCardMap: {},
    dewsRiskLevel: "normal",
  }),
}));

vi.mock("@/components/peg-distribution-grid", () => ({
  PegBrowseStrip: () => <div data-testid="peg-browse-strip" />,
}));

describe("HomeAltRankingsSection", () => {
  beforeEach(() => {
    stablecoinTablePropsMock.mockClear();
    togglePinnedMock.mockClear();
    setActiveUniverseMock.mockClear();
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [{ id: "usdt-tether" }] },
      isLoading: false,
    });
    usePegSummaryMock.mockReturnValue({ data: { coins: [], summary: {} } });
    useDexLiquidityMock.mockReturnValue({ data: {} });
    useReportCardsV9Mock.mockReturnValue({ data: { cards: [], dependencyGraph: { edges: [] } } });
    useStressSignalsMock.mockReturnValue({ data: { signals: {} } });
    useHomeAltFiltersMock.mockReturnValue({
      activeFilters: [],
      activeUniverse: "core",
      setActiveUniverse: setActiveUniverseMock,
    });
    usePinnedStablecoinsMock.mockReturnValue({ pinnedIds: ["usdc-circle"], togglePinned: togglePinnedMock });
  });


  it("configures the main table with homepage defaults", () => {
    render(<HomeAltRankingsSection titleId="home-alt-rankings-title" />);

    expect(screen.getByTestId("peg-browse-strip")).toBeTruthy();
    expect(screen.getByTestId("stablecoin-table")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Core" }).getAttribute("data-state")).toBe("on");
    expect(screen.getByRole("radio", { name: "Variants" })).toBeTruthy();
    // The section now owns the "Stablecoin Overview" heading (carrying the
    // region's labelled id) rather than the table toolbar.
    const heading = screen.getByRole("heading", { name: "Stablecoin Overview" });
    expect(heading.getAttribute("id")).toBe("home-alt-rankings-title");
    expect(stablecoinTablePropsMock).toHaveBeenCalledTimes(1);
    expect(stablecoinTablePropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialVisibleColumns: [
          "rank",
          "name",
          "price",
          "peg",
          "mcap",
          "change24h",
          "change7d",
          "grade",
          "stability",
          "liquidity",
          "blacklistable",
          "backing",
          "type",
        ],
        columnPreferenceNamespace: "pharos-home-alt-table-v3",
        showHeaderMethodologyHints: false,
        pinnedStablecoinIds: ["usdc-circle"],
        onTogglePinnedStablecoin: togglePinnedMock,
        toolbarVariant: "figmaOverview",
        eligibleIds: expect.any(Set),
      }),
    );
    expect(stablecoinTablePropsMock.mock.calls[0]?.[0]).not.toHaveProperty("usePageVerticalScroll");
  });

  it("does not render a generic empty table when the market query fails", () => {
    useStablecoinsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("market feed unavailable"),
      refetch: vi.fn(),
      dataUpdatedAt: 0,
    });

    render(<HomeAltRankingsSection titleId="home-alt-rankings-title" />);

    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
    expect(screen.getByText("Stablecoin rankings are temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByTestId("stablecoin-table")).toBeNull();
  });
});
