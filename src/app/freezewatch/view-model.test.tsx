// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseFreezeWatchPageFilters,
  useFreezeWatchPageController,
} from "./view-model";
import { makeReportCardsV9Response, makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";

const {
  useBlacklistSummaryMock,
  useBlacklistEventsPageMock,
  replaceParamsMock,
  trackEventMock,
  trackSearchMock,
  useReportCardsV9Mock,
} = vi.hoisted(() => ({
  useBlacklistSummaryMock: vi.fn(),
  useBlacklistEventsPageMock: vi.fn(),
  replaceParamsMock: vi.fn(),
  trackEventMock: vi.fn(),
  trackSearchMock: vi.fn(),
  useReportCardsV9Mock: vi.fn(),
}));

let currentSearch = "";

vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistSummary: useBlacklistSummaryMock,
  useBlacklistEventsPage: useBlacklistEventsPageMock,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({
    searchParams: new URLSearchParams(currentSearch),
    replaceParams: replaceParamsMock,
  }),
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: trackEventMock,
  trackSearch: trackSearchMock,
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: () => ({
    data: { peggedAssets: [] },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useReportCardsV9: useReportCardsV9Mock,
}));

describe("parseFreezeWatchPageFilters", () => {
  it("normalizes accepted values and falls back for invalid input", () => {
    const filters = parseFreezeWatchPageFilters(
      "?stablecoin=usdt&chain=tron&event=destroy&sortBy=event&sortDirection=asc&page=2&q=abc&status=yes",
    );

    expect(filters).toEqual({
      stablecoinFilter: "USDT",
      chainFilter: "tron",
      eventTypeFilter: "destroy",
      sortKey: "event",
      sortDirection: "asc",
      page: 2,
      searchQuery: "abc",
      statusBucket: "yes",
    });
  });

  it("treats invalid filters and sentinel query values as defaults", () => {
    const filters = parseFreezeWatchPageFilters("?stablecoin=bad&page=0&q=all&status=unknown");

    expect(filters.stablecoinFilter).toBe("all");
    expect(filters.page).toBe(1);
    expect(filters.searchQuery).toBe("");
    expect(filters.statusBucket).toBeNull();
  });

  it("accepts chainId as a URL alias for chain", () => {
    const filters = parseFreezeWatchPageFilters("?chainId=ethereum");

    expect(filters.chainFilter).toBe("ethereum");
  });

  it("accepts coin as a temporary URL alias for stablecoin", () => {
    const filters = parseFreezeWatchPageFilters("?coin=usdt");

    expect(filters.stablecoinFilter).toBe("USDT");
  });
});

describe("useFreezeWatchPageController", () => {
  beforeEach(() => {
    currentSearch = "?stablecoin=usdt&chain=tron&event=destroy&sortBy=event&sortDirection=asc&page=2&q=abc&status=yes";
    useBlacklistSummaryMock.mockReset();
    useBlacklistEventsPageMock.mockReset();
    replaceParamsMock.mockReset();
    trackEventMock.mockReset();
    trackSearchMock.mockReset();
    useReportCardsV9Mock.mockReset();
    useReportCardsV9Mock.mockReturnValue({
      data: { cards: [] },
      isLoading: false,
    });
    useBlacklistSummaryMock.mockReturnValue({
      data: {
        chains: [
          { id: "tron", name: "Tron" },
          { id: "ethereum", name: "Ethereum" },
        ],
        stats: { totalEvents: 2 },
        chart: null,
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: 123,
      refetch: vi.fn(),
      meta: { preset: "blacklist" },
    });
    useBlacklistEventsPageMock.mockImplementation((params) => {
      return {
        data: {
          events: [{ id: "evt-1" }],
          total: 120,
        },
        isLoading: false,
        error: null,
        dataUpdatedAt: 456,
        refetch: vi.fn(),
        meta: { preset: "blacklist" },
        params,
      };
    });
    replaceParamsMock.mockImplementation((updater: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(currentSearch);
      updater(params);
      currentSearch = params.toString() ? `?${params.toString()}` : "";
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("derives page state, updates URL filters, and preserves pagination semantics", () => {
    const { result, rerender } = renderHook(() => useFreezeWatchPageController());

    expect(useBlacklistEventsPageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoin: "USDT",
        chainName: "Tron",
        eventType: "destroy",
        query: "abc",
        sortBy: "event",
        sortDirection: "asc",
        limit: 50,
        offset: 50,
      }),
    );
    expect(result.current.stablecoinFilter).toBe("USDT");
    expect(result.current.chainFilter).toBe("tron");
    expect(result.current.statusBucket).toBe("yes");
    expect(result.current.clampedPage).toBe(2);
    expect(result.current.totalPages).toBe(3);
    expect(result.current.rangeStart).toBe(51);
    expect(result.current.rangeEnd).toBe(100);

    act(() => {
      result.current.handleStablecoinChange("all");
    });

    const nextSearch = new URLSearchParams(currentSearch);
    expect(nextSearch.get("stablecoin")).toBeNull();
    expect(nextSearch.get("page")).toBeNull();
    expect(nextSearch.get("q")).toBe("abc");
    expect(trackEventMock).toHaveBeenCalledWith("filter_applied", {
      page: "freezewatch",
      filter_type: "stablecoin",
      filter_value: "all",
    });

    act(() => {
      result.current.handleNextPage();
    });
    expect(new URLSearchParams(currentSearch).get("page")).toBe("3");

    rerender();
    act(() => {
      result.current.handlePreviousPage();
    });
    expect(new URLSearchParams(currentSearch).get("page")).toBe("2");
  });

  it("debounces search updates and scrolls the drilldown when the status bucket changes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(() => useFreezeWatchPageController());
    const drilldownEl = document.createElement("div");
    drilldownEl.scrollIntoView = vi.fn();
    result.current.drilldownRef.current = drilldownEl;

    act(() => {
      result.current.handleSearchChange("0xdeadbeef");
    });
    expect(result.current.searchInput).toBe("0xdeadbeef");
    expect(trackSearchMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(trackSearchMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(trackSearchMock).toHaveBeenCalledWith("freezewatch", "0xdeadbeef".length);
    expect(new URLSearchParams(currentSearch).get("q")).toBe("0xdeadbeef");

    currentSearch = "?status=possible";
    act(() => {
      rerender();
    });
    expect(drilldownEl.scrollIntoView).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("clamps page to totalPages when navigating beyond bounds", () => {
    currentSearch = "?page=99";
    useBlacklistEventsPageMock.mockReturnValue({
      data: { events: [], total: 25 },
      isLoading: false,
      error: null,
      dataUpdatedAt: 456,
      refetch: vi.fn(),
      meta: { preset: "blacklist" },
    });
    const { result } = renderHook(() => useFreezeWatchPageController());
    expect(result.current.clampedPage).toBe(1);
  });

  it("returns zero range bounds when total is 0", () => {
    useBlacklistEventsPageMock.mockReturnValue({
      data: { events: [], total: 0 },
      isLoading: false,
      error: null,
      dataUpdatedAt: 456,
      refetch: vi.fn(),
      meta: { preset: "blacklist" },
    });
    const { result } = renderHook(() => useFreezeWatchPageController());
    expect(result.current.rangeStart).toBe(0);
    expect(result.current.rangeEnd).toBe(0);
  });

  it("projects the V9 score into the freezewatch drilldown row, not the legacy weighted-pillar mean", () => {
    const bindingCap = {
      kind: "reason:missing-mint-authority",
      limit: 61,
      source: "evidence" as const,
      reason: "Mint control evidence caps the published score.",
      binding: true,
    };
    // The legacy weighted-pillar mean (qualityScore 88) and the V9 post-cap
    // published score (61) diverge; the drilldown row must carry the V9 one.
    const response = makeReportCardsV9Response({
      cards: [
        makeV9Card({
          id: "shared-freezewatch-asset",
          score: 61,
          grade: "C+",
          qualityScore: 88,
          pegAdjustedScore: 88,
          pillars: makeV9Pillars({ backing: 86, exit: 88, control: 90 }),
          caps: [bindingCap],
          bindingCap,
        }),
      ],
    });

    useReportCardsV9Mock.mockReturnValue({ data: response, isLoading: false });
    const { result } = renderHook(() => useFreezeWatchPageController());

    const row = result.current.reportCardMap?.["shared-freezewatch-asset"];
    expect(row?.score).toBe(61);
    expect(row?.grade).toBe("C+");
    expect(row?.pillars.backing.score).toBe(86);
    expect(row?.pillars.exit.score).toBe(88);
    expect(row?.pillars.control.score).toBe(90);
    expect(row?.weakestPillar).toEqual({ pillar: "backing", score: 86 });
    expect(row?.bindingCapReason).toBe("Mint control evidence caps the published score.");
  });

  it("removes stale chainId alias when updating the chain filter", () => {
    currentSearch = "?chainId=ethereum&page=2";
    const { result, rerender } = renderHook(() => useFreezeWatchPageController());

    expect(result.current.chainFilter).toBe("ethereum");

    act(() => {
      result.current.handleChainChange("all");
    });

    let nextParams = new URLSearchParams(currentSearch);
    expect(nextParams.get("chain")).toBeNull();
    expect(nextParams.get("chainId")).toBeNull();
    expect(nextParams.get("page")).toBeNull();

    currentSearch = "?chainId=ethereum";
    rerender();
    act(() => {
      result.current.handleChainChange("tron");
    });

    nextParams = new URLSearchParams(currentSearch);
    expect(nextParams.get("chain")).toBe("tron");
    expect(nextParams.get("chainId")).toBeNull();
  });

  it("resets page to 1 when applying a new filter", () => {
    currentSearch = "?page=3";
    const { result } = renderHook(() => useFreezeWatchPageController());
    act(() => result.current.handleStablecoinChange("USDC"));
    const nextParams = new URLSearchParams(currentSearch);
    expect(nextParams.get("page")).toBeNull();
  });
});
