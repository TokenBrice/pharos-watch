// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeAltClient } from "@/components/home-alt-client";
import { ALL_COLUMNS } from "@/lib/column-visibility";

const {
  stablecoinTablePropsMock,
  togglePinnedMock,
  useStablecoinsMock,
  useLogosMock,
  usePegSummaryMock,
  useDexLiquidityMock,
  useReportCardsMock,
  useStressSignalsMock,
  useHomeAltFiltersMock,
  useHomepageDiscoverySuggestionsMock,
  usePinnedStablecoinsMock,
} = vi.hoisted(() => ({
  stablecoinTablePropsMock: vi.fn(),
  togglePinnedMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
  useLogosMock: vi.fn(),
  usePegSummaryMock: vi.fn(),
  useDexLiquidityMock: vi.fn(),
  useReportCardsMock: vi.fn(),
  useStressSignalsMock: vi.fn(),
  useHomeAltFiltersMock: vi.fn(),
  useHomepageDiscoverySuggestionsMock: vi.fn(),
  usePinnedStablecoinsMock: vi.fn(),
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

    function MockDailyDigest() {
      return <div data-testid="daily-digest" />;
    }

    return MockDailyDigest;
  },
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: useLogosMock,
}));

vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: usePegSummaryMock,
  useDexLiquidity: useDexLiquidityMock,
  useReportCards: useReportCardsMock,
  useStressSignals: useStressSignalsMock,
}));

vi.mock("@/hooks/use-home-alt-filters", () => ({
  useHomeAltFilters: useHomeAltFiltersMock,
}));

vi.mock("@/hooks/use-homepage-discovery", () => ({
  useHomepageDiscoverySuggestions: useHomepageDiscoverySuggestionsMock,
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

vi.mock("@/components/home-alt-hero", () => ({
  HomeAltHero: () => <div data-testid="home-alt-hero" />,
}));

vi.mock("@/components/home-alt-mini-card-grid", () => ({
  HomeAltMiniCardGrid: () => <div data-testid="home-alt-mini-card-grid" />,
}));

vi.mock("@/components/homepage-discovery-module", () => ({
  HomepageDiscoveryModule: () => <div data-testid="homepage-discovery-module" />,
}));

vi.mock("@/components/peg-distribution-grid", () => ({
  PegBrowseStrip: () => <div data-testid="peg-browse-strip" />,
}));

describe("HomeAltClient", () => {
  beforeEach(() => {
    stablecoinTablePropsMock.mockClear();
    togglePinnedMock.mockClear();
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [{ id: "usdt-tether" }] },
      isLoading: false,
    });
    useLogosMock.mockReturnValue({ data: {} });
    usePegSummaryMock.mockReturnValue({ data: { coins: [], summary: {} } });
    useDexLiquidityMock.mockReturnValue({ data: {} });
    useReportCardsMock.mockReturnValue({ data: { cards: [], dependencyGraph: { edges: [] } } });
    useStressSignalsMock.mockReturnValue({ data: { signals: {} } });
    useHomeAltFiltersMock.mockReturnValue({ activeFilters: [] });
    useHomepageDiscoverySuggestionsMock.mockReturnValue([]);
    usePinnedStablecoinsMock.mockReturnValue({ pinnedIds: ["usdc-circle"], togglePinned: togglePinnedMock });
  });

  afterEach(() => {
    cleanup();
  });

  it("configures the main table with homepage defaults", () => {
    render(<HomeAltClient />);

    expect(screen.getByTestId("stablecoin-table")).toBeTruthy();
    expect(stablecoinTablePropsMock).toHaveBeenCalledTimes(1);
    expect(stablecoinTablePropsMock).toHaveBeenCalledWith(expect.objectContaining({
      initialVisibleColumns: ALL_COLUMNS.map((column) => column.id),
      columnPreferenceNamespace: "pharos-home-alt-table-v2",
      suppressDesktopHorizontalScroll: true,
      showHeaderMethodologyHints: false,
      pinnedStablecoinIds: ["usdc-circle"],
      onTogglePinnedStablecoin: togglePinnedMock,
    }));
    expect(stablecoinTablePropsMock.mock.calls[0]?.[0]).not.toHaveProperty("usePageVerticalScroll");
  });
});
