// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScreenerClient } from "./client";

const mocks = vi.hoisted(() => ({
  QueryFreshnessNotices: vi.fn(),
  useDexLiquidity: vi.fn(),
  useHydrated: vi.fn(),
  usePegSummary: vi.fn(),
  useReportCardsV9: vi.fn(),
  useSort: vi.fn(),
  useStablecoins: vi.fn(),
  useStressSignals: vi.fn(),
  useUrlFilters: vi.fn(),
}));

vi.mock("@/components/query-freshness-notices", () => ({
  QueryFreshnessNotices: (props: { hasData: boolean; queries: Array<{ preset?: string }>; error?: unknown }) => {
    mocks.QueryFreshnessNotices(props);
    return <div data-testid="freshness-notices" />;
  },
}));

vi.mock("@/components/selector/selector-callout", () => ({
  SelectorCallout: () => <div data-testid="selector-callout" />,
}));

vi.mock("@/components/screener/screener-toolbar", () => ({
  ScreenerToolbar: ({ rightSlot }: { rightSlot?: ReactNode }) => (
    <div data-testid="screener-toolbar">{rightSlot}</div>
  ),
}));

vi.mock("@/components/screener/screener-table", () => ({
  ScreenerTable: () => <div data-testid="screener-table" />,
}));

vi.mock("@/components/table-export-menu", () => ({
  TableExportMenu: () => <div data-testid="table-export-menu" />,
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: mocks.useStablecoins,
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDexLiquidity: mocks.useDexLiquidity,
  usePegSummary: mocks.usePegSummary,
  useReportCardsV9: mocks.useReportCardsV9,
  useStressSignals: mocks.useStressSignals,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: mocks.useUrlFilters,
}));

vi.mock("@/hooks/use-sort", () => ({
  useSort: mocks.useSort,
}));

vi.mock("@/hooks/use-hydrated", () => ({
  useHydrated: mocks.useHydrated,
}));

function refetch() {
  return Promise.resolve({});
}

function setDefaultMocks() {
  mocks.useHydrated.mockReturnValue(true);
  mocks.useUrlFilters.mockReturnValue({
    searchParams: new URLSearchParams(),
    replaceParams: vi.fn(),
  });
  mocks.useSort.mockReturnValue({
    sortKey: "safetyScore",
    sortDirection: "desc",
    toggleSort: vi.fn(),
    getAriaSortValue: vi.fn(() => "none"),
  });
  mocks.useStablecoins.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    dataUpdatedAt: 0,
    meta: null,
    refetch,
  });
  mocks.usePegSummary.mockReturnValue({
    data: {
      coins: [{ id: "usdc-circle", currentDeviationBps: 0, worstDeviationBps: 0 }],
    },
    error: null,
    dataUpdatedAt: 1_700_000_000,
    meta: null,
    refetch,
  });
  mocks.useReportCardsV9.mockReturnValue({
    data: { cards: [] },
    isLoading: false,
    error: null,
    dataUpdatedAt: 1_700_000_000,
    meta: null,
    refetch,
  });
  mocks.useStressSignals.mockReturnValue({
    data: { signals: { "usdc-circle": { score: 12 } } },
    isLoading: false,
    error: null,
    dataUpdatedAt: 1_700_000_000,
    meta: null,
    refetch,
  });
  mocks.useDexLiquidity.mockReturnValue({
    data: { "usdc-circle": { liquidityScore: 80 } },
    error: null,
    dataUpdatedAt: 1_700_000_000,
    meta: null,
    refetch,
  });
}

function getFreshnessProps() {
  expect(mocks.QueryFreshnessNotices).toHaveBeenCalledTimes(1);
  return mocks.QueryFreshnessNotices.mock.calls[0]?.[0] as {
    hasData: boolean;
    queries: Array<{ preset?: string; hasData?: boolean }>;
    error?: unknown;
  };
}

describe("ScreenerClient freshness notices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the global data gate tied to the primary stablecoin rows", () => {
    const stablecoinsError = new Error("stablecoin list unavailable");
    mocks.useStablecoins.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: stablecoinsError,
      dataUpdatedAt: 0,
      meta: null,
      refetch,
    });

    render(<ScreenerClient />);

    const props = getFreshnessProps();
    expect(props.hasData).toBe(false);
    expect(props.error).toBe(stablecoinsError);
    expect(props.queries.some((query) => query.preset === "pegSummary" && query.hasData)).toBe(true);
    expect(props.queries.some((query) => query.preset === "stressSignals" && query.hasData)).toBe(true);
    expect(props.queries.some((query) => query.preset === "dexLiquidity" && query.hasData)).toBe(true);
  });
});
