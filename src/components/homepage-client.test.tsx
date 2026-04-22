// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomepageClient } from "@/components/homepage-client";

const refetchMock = vi.fn();
const handleGroupChangeMock = vi.fn();

const {
  useStablecoinsMock,
  usePegSummaryMock,
  useDexLiquidityMock,
  useReportCardsMock,
  useStressSignalsMock,
  useLogosMock,
  useHomepageFiltersMock,
  usePinnedStablecoinsMock,
} = vi.hoisted(() => ({
  useStablecoinsMock: vi.fn(),
  usePegSummaryMock: vi.fn(),
  useDexLiquidityMock: vi.fn(),
  useReportCardsMock: vi.fn(),
  useStressSignalsMock: vi.fn(),
  useLogosMock: vi.fn(),
  useHomepageFiltersMock: vi.fn(),
  usePinnedStablecoinsMock: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: () => (props: { toolbarActions?: ReactNode; filterPanel?: ReactNode }) => (
    <div data-testid="dynamic-home-section">
      {props.toolbarActions}
      {props.filterPanel}
    </div>
  ),
}));

vi.mock("@/hooks/api-hooks", () => ({
  usePegSummary: usePegSummaryMock,
  useDexLiquidity: useDexLiquidityMock,
  useReportCards: useReportCardsMock,
  useStressSignals: useStressSignalsMock,
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: useLogosMock,
}));

vi.mock("@/hooks/use-homepage-filters", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/hooks/use-homepage-filters")>();
  return {
    ...original,
    useHomepageFilters: useHomepageFiltersMock,
  };
});

vi.mock("@/hooks/use-pinned-stablecoins", () => ({
  usePinnedStablecoins: usePinnedStablecoinsMock,
}));

vi.mock("@/hooks/use-data-announce", () => ({
  useDataAnnounce: () => undefined,
  DataLiveRegion: () => null,
}));

function makeFilters(overrides: Record<string, unknown> = {}) {
  return {
    groupSelections: {},
    searchQuery: "",
    setSearchQuery: vi.fn(),
    handleGroupChange: handleGroupChangeMock,
    clearAll: vi.fn(),
    activeFilters: [] as string[],
    hasFilters: false,
    ...overrides,
  };
}

describe("HomepageClient", () => {
  beforeEach(() => {
    refetchMock.mockReset();
    handleGroupChangeMock.mockReset();
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [], fxFallbackRates: {} },
      isLoading: false,
      error: null,
      dataUpdatedAt: 0,
      refetch: refetchMock,
      meta: null,
    });
    usePegSummaryMock.mockReturnValue({ data: { coins: [], summary: {} }, dataUpdatedAt: 0, error: null, refetch: refetchMock, meta: null });
    useDexLiquidityMock.mockReturnValue({ data: {}, dataUpdatedAt: 0, error: null, refetch: refetchMock, meta: null });
    useReportCardsMock.mockReturnValue({ data: { cards: [], dependencyGraph: { edges: [] } }, dataUpdatedAt: 0, error: null, refetch: refetchMock, meta: null });
    useStressSignalsMock.mockReturnValue({ data: { signals: {} } });
    useLogosMock.mockReturnValue({ data: {} });
    usePinnedStablecoinsMock.mockReturnValue({ pinnedIds: [], togglePinned: vi.fn() });
    useHomepageFiltersMock.mockReturnValue(makeFilters());
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the sixth filter group when the filter panel is opened", () => {
    render(<HomepageClient />);

    fireEvent.click(screen.getByRole("button", { name: /^Filters$/ }));

    expect(screen.getByText("Variant")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "All variants" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Savings" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Risk-Abs" })).toBeTruthy();
  });

  it("uses the full accessibility wording for active variant filter chips", () => {
    useHomepageFiltersMock.mockReturnValue(makeFilters({
      groupSelections: { Variant: "variant-risk-absorption" },
      activeFilters: ["variant-risk-absorption"],
      hasFilters: true,
    }));

    render(<HomepageClient />);

    expect(screen.getByRole("button", { name: "Remove Risk absorption variant filter" })).toBeTruthy();
    expect(screen.getByText("Risk absorption variant")).toBeTruthy();
  });
});
