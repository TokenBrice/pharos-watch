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
  default: () => {
    return function MockStablecoinTable(props: Record<string, unknown>) {
      stablecoinTablePropsMock(props);
      return <div data-testid="stablecoin-table" />;
    };
  },
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: usePegSummaryMock,
  useDexLiquidityTable: useDexLiquidityMock,
  useReportCardsV9Table: useReportCardsV9Mock,
  useStressSignals: useStressSignalsMock,
}));

vi.mock("@/hooks/use-home-alt-filters", () => ({
  useHomeAltFilters: useHomeAltFiltersMock,
}));

vi.mock("@/hooks/use-pinned-stablecoins", () => ({
  usePinnedStablecoins: usePinnedStablecoinsMock,
}));

vi.mock("@/components/homepage-client-view-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/homepage-client-view-model")>()),
  buildHomepageOptionalViewModel: () => ({
    reportCardMap: {},
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



  it("does not render a generic empty table when the market query fails", () => {
    useStablecoinsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("market feed unavailable"),
      refetch: vi.fn(),
      dataUpdatedAt: 0,
    });

    render(<HomeAltRankingsSection titleId="home-alt-rankings-title" />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Stablecoin rankings are updating.")).toBeTruthy();
    expect(screen.queryByTestId("stablecoin-table")).toBeNull();
  });
});
