// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AltPegsClient } from "@/app/alt-pegs/client";
import { makeStablecoin } from "@shared/test-utils/stablecoin";

const refetchMock = vi.fn();

const {
  useStablecoinsMock,
  useNonUsdShareMock,
  usePegSummaryMock,
  useDexLiquidityMock,
  useReportCardsV9Mock,
} = vi.hoisted(() => ({
  useStablecoinsMock: vi.fn(),
  useNonUsdShareMock: vi.fn(),
  usePegSummaryMock: vi.fn(),
  useDexLiquidityMock: vi.fn(),
  useReportCardsV9Mock: vi.fn(),
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/hooks/api-hooks", () => ({
  useNonUsdShare: useNonUsdShareMock,
  usePegSummary: usePegSummaryMock,
  useDexLiquidity: useDexLiquidityMock,
  useReportCardsV9: useReportCardsV9Mock,
}));

vi.mock("@/app/alt-pegs/alt-peg-stablecoin-table", () => ({
  AltPegStablecoinTable: () => (
    <div data-testid="alt-peg-stablecoin-table">
      <h2>Drill Into Each Alt-Peg Cohort</h2>
    </div>
  ),
}));

vi.mock("@/components/non-usd-share-chart", () => ({
  NonUsdShareChart: ({
    initialRange,
    isFocused,
    onOpenFocus,
    onCloseFocus,
    onRangeChange,
  }: {
    initialRange?: string;
    isFocused?: boolean;
    onOpenFocus?: (value: string) => void;
    onCloseFocus?: () => void;
    onRangeChange?: (value: string) => void;
  }) => (
    <div data-testid="non-usd-share-chart">
      share-chart {isFocused ? "focused" : "default"} {initialRange}
      <button type="button" onClick={() => onOpenFocus?.("90d")}>
        open-share
      </button>
      <button type="button" onClick={() => onOpenFocus?.("all")}>
        open-share-all
      </button>
      <button type="button" onClick={() => onCloseFocus?.()}>
        close-share
      </button>
      <button type="button" onClick={() => onRangeChange?.("30d")}>
        range-share
      </button>
    </div>
  ),
}));

vi.mock("@/app/alt-pegs/alt-peg-cohort-history-chart", () => ({
  AltPegCohortHistoryChart: ({
    initialRange,
    isFocused,
    onOpenFocus,
    onCloseFocus,
    onRangeChange,
  }: {
    initialRange?: string;
    isFocused?: boolean;
    onOpenFocus?: (value: string) => void;
    onCloseFocus?: () => void;
    onRangeChange?: (value: string) => void;
  }) => (
    <div data-testid="alt-peg-cohort-chart">
      cohort-chart {isFocused ? "focused" : "default"} {initialRange}
      <button type="button" onClick={() => onOpenFocus?.("90d")}>
        open-cohorts
      </button>
      <button type="button" onClick={() => onCloseFocus?.()}>
        close-cohorts
      </button>
      <button type="button" onClick={() => onRangeChange?.("all")}>
        range-cohorts
      </button>
    </div>
  ),
}));

function makeCoin(id: string, marketCap: number) {
  return makeStablecoin({
    id,
    name: id,
    symbol: id.toUpperCase(),
    pegMechanism: "",
    supplySource: "test",
    circulating: { usd: marketCap },
  });
}

function expectFocusSearch(expected: { view?: string | null; chart?: string | null; range?: string | null }) {
  const params = new URLSearchParams(window.location.search);
  expect(params.get("view")).toBe(expected.view ?? null);
  expect(params.get("chart")).toBe(expected.chart ?? null);
  expect(params.get("range")).toBe(expected.range ?? null);
}

describe("AltPegsClient", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    window.history.replaceState(null, "", "/alt-pegs/");
    refetchMock.mockReset();
    useStablecoinsMock.mockReturnValue({
      data: {
        peggedAssets: [
          makeCoin("eurc-circle", 60_000_000),
          makeCoin("paxg-paxos", 20_000_000),
          makeCoin("usdc-circle", 100_000_000),
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 1,
      refetch: refetchMock,
      meta: null,
    });
    usePegSummaryMock.mockReturnValue({
      data: { coins: [] },
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 0,
    });
    useDexLiquidityMock.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 0,
    });
    useReportCardsV9Mock.mockReturnValue({
      data: { cards: [] },
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 0,
    });
    useNonUsdShareMock.mockReturnValue({
      data: [
        {
          date: 1_700_000_000,
          commodityShare: 1,
          fiatNonUsdShare: 1,
          commodity: 10,
          fiatNonUsd: 10,
          total: 1000,
        },
        {
          date: 1_700_000_000 + 366 * 86400,
          commodityShare: 1.4,
          fiatNonUsdShare: 1.2,
          commodity: 18,
          fiatNonUsd: 15,
          total: 1200,
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
      dataUpdatedAt: 2,
    });
  });

  it("renders the core current-state sections and history block", () => {
    render(<AltPegsClient />);

    expect(screen.getByRole("heading", { name: "Which Non-USD Pegs Matter Now" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "How Much Of The Total Stablecoin Market Sits Outside USD?" }),
    ).toBeTruthy();
    expect(screen.getByTestId("non-usd-share-chart")).toBeTruthy();
    expect(screen.getByTestId("alt-peg-cohort-chart")).toBeTruthy();
    expect(screen.getByText(/share-chart default 1y/i)).toBeTruthy();
    expect(screen.getByText(/cohort-chart default 1y/i)).toBeTruthy();
  });

  it("places the distribution table below the alt-peg chart tabs", () => {
    const { container } = render(<AltPegsClient />);

    const pageText = container.textContent ?? "";
    const shareChartIndex = pageText.indexOf("How Much Of The Total Stablecoin Market Sits Outside USD?");
    const cohortChartIndex = pageText.indexOf("cohort-chart default 1y");
    const tableIndex = pageText.indexOf("Which Non-USD Pegs Matter Now");
    expect(shareChartIndex).toBeGreaterThanOrEqual(0);
    expect(cohortChartIndex).toBeGreaterThanOrEqual(0);
    expect(tableIndex).toBeGreaterThanOrEqual(0);
    expect(shareChartIndex).toBeLessThan(tableIndex);
    expect(cohortChartIndex).toBeLessThan(tableIndex);
  });

  it("leads with the atlas hero, then the workbench table, then cohort details", () => {
    const { container } = render(<AltPegsClient />);

    const pageText = container.textContent ?? "";
    const atlasIndex = pageText.indexOf("Peg Diversity Atlas");
    const cohortChartIndex = pageText.indexOf("cohort-chart default 1y");
    const directoryIndex = pageText.indexOf("Drill Into Each Alt-Peg Cohort");
    const tableIndex = pageText.indexOf("Which Non-USD Pegs Matter Now");
    expect(atlasIndex).toBeGreaterThanOrEqual(0);
    expect(cohortChartIndex).toBeGreaterThanOrEqual(0);
    expect(directoryIndex).toBeGreaterThanOrEqual(0);
    expect(tableIndex).toBeGreaterThanOrEqual(0);
    expect(atlasIndex).toBeLessThan(directoryIndex);
    expect(directoryIndex).toBeLessThan(cohortChartIndex);
    expect(directoryIndex).toBeLessThan(tableIndex);
  });

  it("renders peg drill-down links from the distribution card", () => {
    render(<AltPegsClient />);

    expect(screen.getByRole("link", { name: "Compliance Tracker" }).getAttribute("href")).toBe(
      "/compliance?regime=mica",
    );
    expect(
      screen.getAllByRole("link", { name: "Euro" }).some((link) => link.getAttribute("href") === "/stablecoins/eur"),
    ).toBe(true);
    expect(
      screen.getAllByRole("link", { name: "Gold" }).some((link) => link.getAttribute("href") === "/stablecoins/gold"),
    ).toBe(true);
  });

  it("restores a focused share chart from the URL", () => {
    window.history.replaceState(null, "", "/alt-pegs/?view=focused&chart=share&range=90d");

    render(<AltPegsClient />);

    expect(screen.getByText(/share-chart focused 90d/i)).toBeTruthy();
    expect(screen.getByText(/cohort-chart default 1y/i)).toBeTruthy();
  });

  it("preserves a hydrated focused range when returning to the overview", async () => {
    window.history.replaceState(null, "", "/alt-pegs/?view=focused&chart=share&range=90d#charts");
    const container = document.createElement("div");
    container.innerHTML = renderToString(<AltPegsClient />);
    document.body.append(container);
    const errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <AltPegsClient />, { onRecoverableError: (error) => errors.push(error) });
    });
    try {
      expect(screen.getByText(/share-chart focused 90d/i)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "close-share" }));
      await waitFor(() => expect(screen.getByText(/share-chart default 90d/i)).toBeTruthy());
      expectFocusSearch({});
      expect(window.location.hash).toBe("#charts");
      expect(errors).toEqual([]);
    } finally {
      act(() => root!.unmount());
      container.remove();
    }
  });

  it("opens and updates a focused share chart through URL state", async () => {
    render(<AltPegsClient />);

    fireEvent.click(screen.getByRole("button", { name: "open-share" }));

    await waitFor(() => {
      expectFocusSearch({ view: "focused", chart: "share", range: "90d" });
    });

    fireEvent.click(screen.getByRole("button", { name: "range-share" }));

    await waitFor(() => {
      expectFocusSearch({ view: "focused", chart: "share", range: "30d" });
    });
  });

  it("keeps an explicit all-range focused share URL", async () => {
    render(<AltPegsClient />);

    fireEvent.click(screen.getByRole("button", { name: "open-share-all" }));

    await waitFor(() => {
      expectFocusSearch({ view: "focused", chart: "share", range: "all" });
    });
  });

  it("closes the focused share chart and clears focus params", async () => {
    window.history.replaceState(null, "", "/alt-pegs/?view=focused&chart=share&range=90d");

    render(<AltPegsClient />);
    fireEvent.click(screen.getByRole("button", { name: "close-share" }));

    await waitFor(() => {
      expectFocusSearch({});
    });
  });

  it("opens, updates, and closes a focused cohort chart through URL state", async () => {
    render(<AltPegsClient />);

    fireEvent.click(screen.getByRole("button", { name: "open-cohorts" }));

    await waitFor(() => {
      expectFocusSearch({ view: "focused", chart: "cohorts", range: "90d" });
    });

    fireEvent.click(screen.getByRole("button", { name: "range-cohorts" }));

    await waitFor(() => {
      expectFocusSearch({ view: "focused", chart: "cohorts", range: "all" });
    });

    fireEvent.click(screen.getByRole("button", { name: "close-cohorts" }));

    await waitFor(() => {
      expectFocusSearch({});
    });
  });

  it("responds to popstate changes for focused chart URLs", async () => {
    render(<AltPegsClient />);

    await waitFor(() => {
      expect(screen.getByText(/share-chart default 1y/i)).toBeTruthy();
    });

    act(() => {
      window.history.replaceState(null, "", "/alt-pegs/?view=focused&chart=share&range=90d");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(screen.getByText(/share-chart focused 90d/i)).toBeTruthy();
    });

    act(() => {
      window.history.replaceState(null, "", "/alt-pegs/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(screen.getByText(/share-chart default 1y/i)).toBeTruthy();
    });
  });
});
