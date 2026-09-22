// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import FreezeWatchClient from "./client";

const mocks = vi.hoisted(() => ({
  useBlacklistSummary: vi.fn(),
  useBlacklistEventsPage: vi.fn(),
  useStablecoins: vi.fn(),
  useReportCardsV9: vi.fn(),
  usePegSummary: vi.fn(),
  useDexLiquidity: vi.fn(),
  replaceParams: vi.fn(),
}));

let currentSearch = "";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistSummary: mocks.useBlacklistSummary,
  useBlacklistEventsPage: mocks.useBlacklistEventsPage,
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: mocks.useStablecoins,
}));

vi.mock("@/hooks/api-hooks", () => ({
  useReportCardsV9: mocks.useReportCardsV9,
  usePegSummary: mocks.usePegSummary,
  useDexLiquidity: mocks.useDexLiquidity,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({ searchParams: new URLSearchParams(currentSearch), replaceParams: mocks.replaceParams }),
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
  trackSearch: vi.fn(),
}));

// Heavyweight leaves with their own measurement/fetch behaviour. The widgets under
// test (hero meter, stats grid, ledger chart, drilldown) stay real.
vi.mock("@/components/freezewatch/sovereignty-lattice", () => ({
  SovereigntyLattice: () => <div data-testid="sovereignty-lattice" />,
}));

vi.mock("@/components/freezewatch/intervention-seismograph", () => ({
  InterventionSeismograph: () => <div data-testid="intervention-seismograph" />,
}));

vi.mock("@/components/usds-status-card", () => ({
  UsdsStatusCard: () => <div data-testid="usds-status-card" />,
}));

vi.mock("@/components/eurc-blacklist-card", () => ({
  EurcBlacklistCard: () => <div data-testid="eurc-blacklist-card" />,
}));

vi.mock("@/components/coin-cross-tracker-hatnote", () => ({
  CoinCrossTrackerHatnote: () => <div data-testid="coin-cross-tracker-hatnote" />,
}));

vi.mock("@/components/blacklist-table", () => ({
  BlacklistTable: ({ isLoading }: { isLoading: boolean }) => (
    <div data-testid="blacklist-table" data-loading={String(isLoading)} />
  ),
}));

vi.mock("@/components/stablecoin-table", () => ({
  StablecoinTable: ({ isLoading }: { isLoading: boolean }) => (
    <div data-testid="stablecoin-table" data-loading={String(isLoading)} />
  ),
}));

vi.mock("@/components/chart-primitives/quarterly-stacked-bar-chart", () => ({
  QuarterlyStackedBarChart: () => <div data-testid="quarterly-chart" />,
}));

interface QueryStub {
  data?: unknown;
  isLoading?: boolean;
  error?: unknown;
}

function stubQuery({ data, isLoading = false, error = null }: QueryStub) {
  return { data, isLoading, error, dataUpdatedAt: 0, refetch: vi.fn(), meta: null };
}

beforeEach(() => {
  currentSearch = "";
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.useBlacklistSummary.mockReturnValue(stubQuery({ data: undefined, isLoading: true }));
  mocks.useBlacklistEventsPage.mockReturnValue(
    stubQuery({ data: { events: [], total: 0 }, isLoading: true }),
  );
  mocks.useStablecoins.mockReturnValue(stubQuery({ data: { peggedAssets: [] } }));
  mocks.useReportCardsV9.mockReturnValue(stubQuery({ data: { cards: [] } }));
  mocks.usePegSummary.mockReturnValue(stubQuery({ data: undefined }));
  mocks.useDexLiquidity.mockReturnValue(stubQuery({ data: undefined }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FreezeWatchClient", () => {
  it("reads the hero and the drilldown as unavailable when the support query fails", () => {
    const failure = new Error("stablecoin list unavailable");
    currentSearch = "?status=yes";
    mocks.useStablecoins.mockReturnValue(stubQuery({ data: undefined, error: failure }));

    render(<FreezeWatchClient />);

    expect(
      screen.getByText("Freezable supply data is temporarily unavailable. No status claim is being made."),
    ).toBeTruthy();
    expect(screen.getByText("Freeze status data is temporarily unavailable. No status claim is being made.")).toBeTruthy();
    expect(screen.getByText("stablecoin list unavailable")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("$0")).toBeNull();
    expect(screen.queryByTestId("stablecoin-table")).toBeNull();
  });

  it("keeps the support widgets out of the unavailable state when the support query answers", () => {
    currentSearch = "?status=yes";

    render(<FreezeWatchClient />);

    expect(screen.getByTestId("stablecoin-table").getAttribute("data-loading")).toBe("false");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("shows error notices instead of the empty-ledger copy and zeroed totals when the reads fail", () => {
    const failure = new Error("blacklist summary unavailable");
    mocks.useBlacklistSummary.mockReturnValue(stubQuery({ data: undefined, error: failure }));
    mocks.useStablecoins.mockReturnValue(stubQuery({ data: undefined, error: failure }));

    render(<FreezeWatchClient />);

    expect(screen.getByText("Freeze ledger chart is temporarily unavailable. No status claim is being made.")).toBeTruthy();
    expect(screen.queryByText("No freeze events recorded yet.")).toBeNull();
    expect(screen.queryByText("$0")).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
  });
});
