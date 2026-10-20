// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import FreezeWatchClient from "./client";
import { installMatchMediaMock } from "@/test-utils/frontend";
import type { ApiMeta } from "@/lib/api";
import type { BlacklistSummaryResponse } from "@shared/types";

const mocks = vi.hoisted(() => ({
  useBlacklistSummary: vi.fn(),
  useBlacklistEventsPage: vi.fn(),
  useStablecoins: vi.fn(),
  useReportCardsV9: vi.fn(),
  usePegSummary: vi.fn(),
  useDexLiquidityTable: vi.fn(),
  replaceParams: vi.fn(),
  stablecoinTable: vi.fn(),
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
  useReportCardsV9Table: mocks.useReportCardsV9,
  usePegSummary: mocks.usePegSummary,
  useDexLiquidityTable: mocks.useDexLiquidityTable,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({ searchParams: new URLSearchParams(currentSearch), replaceParams: mocks.replaceParams }),
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
  trackSearch: vi.fn(),
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
  StablecoinTable: (props: { isLoading: boolean }) => {
    mocks.stablecoinTable(props);
    return <div data-testid="stablecoin-table" data-loading={String(props.isLoading)} />;
  },
}));

vi.mock("@/components/chart-primitives/quarterly-stacked-bar-chart", () => ({
  QuarterlyStackedBarChart: () => <div data-testid="quarterly-chart" />,
}));

interface QueryStub {
  data?: unknown;
  isLoading?: boolean;
  error?: unknown;
  dataUpdatedAt?: number;
  meta?: ApiMeta | null;
}

function stubQuery({ data, isLoading = false, error = null, dataUpdatedAt = data ? Date.now() : 0, meta = null }: QueryStub) {
  return { data, isLoading, error, dataUpdatedAt, refetch: vi.fn(), meta };
}

function makeSummary(): BlacklistSummaryResponse {
  return {
    chains: [{ id: "ethereum", name: "Ethereum" }, { id: "tron", name: "Tron" }],
    chart: [],
    totalEvents: 0,
    stats: {
      usdcBlacklisted: 0, usdtBlacklisted: 0, goldBlacklisted: 0, frozenAddresses: 0,
      destroyedTotal: 0, activeAddressCount: 0, activeFrozenTotal: 0, activeAmountGapCount: 0,
      trackedAddressCount: 0, trackedFrozenTotal: 0, trackedAmountGapCount: 0,
      recentCount: 0, recentCount24h: 0, recentFreezeCount24h: 0, recentFreezeCount7d: 0,
      recentFreezeAmount24hUsd: 0, recentFreezeAmount7dUsd: 0, recoverableGapCount: 0,
      perCoinBlacklistCounts: {}, perCoinTotalEvents: { USDC: 0 }, perCoinFrozenAddressCount: {},
      perCoinFrozenTotal: { USDC: 0 }, perCoinDestroyedTotal: {},
      perCoinQuarterlyEventTypes: {}, perCoinRecentEventTypes: {},
    },
    coverage: {
      supported: [{
        symbol: "USDC", stablecoinId: "usdc-circle", chainId: "ethereum", chainName: "Ethereum",
        contractAddress: "0x1234", configKey: "usdc-ethereum", providerSource: "evm-logs",
        eventFamilies: ["blacklist"], eventTypes: ["blacklist"],
      }],
      unsupportedDeferred: [],
      counts: { supportedConfigs: 1, unsupportedDeferredConfigs: 0, bySymbol: { USDC: 1 }, byChain: { ethereum: 1 }, byProviderSource: { "evm-logs": 1 } },
    },
  };
}

beforeEach(() => {
  currentSearch = "";
  for (const mock of Object.values(mocks)) mock.mockReset();
  installMatchMediaMock();
  mocks.replaceParams.mockImplementation((update: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(currentSearch);
    update(params);
    currentSearch = params.toString();
  });
  mocks.useBlacklistSummary.mockReturnValue(stubQuery({ data: undefined, isLoading: true }));
  mocks.useBlacklistEventsPage.mockReturnValue(
    stubQuery({ data: { events: [], total: 0 }, isLoading: true }),
  );
  mocks.useStablecoins.mockReturnValue(stubQuery({ data: { peggedAssets: [] } }));
  mocks.useReportCardsV9.mockReturnValue(stubQuery({ data: { cards: [] } }));
  mocks.usePegSummary.mockReturnValue(stubQuery({ data: undefined }));
  mocks.useDexLiquidityTable.mockReturnValue(stubQuery({ data: undefined }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FreezeWatchClient", () => {
  it.each(["", "?stablecoin=USDT&chain=tron"])("applies the real USDC/Ethereum lattice cell from %s", (search) => {
    currentSearch = search;
    mocks.useBlacklistSummary.mockReturnValue(stubQuery({ data: makeSummary() }));
    const { rerender } = render(<FreezeWatchClient />);
    fireEvent.click(screen.getByRole("button", { name: "USDC Ethereum coverage supported" }));
    expect(mocks.replaceParams).toHaveBeenCalledOnce();
    rerender(<FreezeWatchClient />);
    expect(new URLSearchParams(currentSearch).get("stablecoin")).toBe("USDC");
    expect(new URLSearchParams(currentSearch).get("chain")).toBe("ethereum");
    expect(mocks.useBlacklistEventsPage).toHaveBeenLastCalledWith(expect.objectContaining({
      stablecoin: "USDC", chainName: "Ethereum", cursor: undefined,
    }));
  });

  it.each([
    ["Supply", "useStablecoins", { peggedAssets: [] }],
    ["Report Cards", "useReportCardsV9", { cards: [] }],
  ] as const)("names stale-success %s independently of fresh blacklist clocks", (label, hook, data) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    mocks.useBlacklistSummary.mockReturnValue(stubQuery({ data: makeSummary() }));
    mocks.useBlacklistEventsPage.mockReturnValue(stubQuery({ data: { events: [], total: 0 } }));
    mocks.useStablecoins.mockReturnValue(stubQuery({ data: { peggedAssets: [] } }));
    mocks.useReportCardsV9.mockReturnValue(stubQuery({ data: { cards: [] } }));
    mocks[hook].mockReturnValue(stubQuery({
      data, meta: {
        updatedAt: Date.now() / 1000 - 100, ageSeconds: 100, status: "fresh",
        freshBudgetSec: 10, degradedBudgetSec: 20,
      },
    }));
    const { rerender } = render(<FreezeWatchClient />);
    const notice = screen.getByText((text) => text.startsWith(`${label} last refreshed`));
    expect(notice.closest('[role="status"]')?.getAttribute("data-health-state")).toBe("stale");
    expect(notice.textContent).not.toContain("Blacklist");
    mocks[hook].mockReturnValue({
      ...mocks[hook].mock.results.at(-1)?.value, dataUpdatedAt: Date.now() + 1000,
    });
    rerender(<FreezeWatchClient />);
    expect(screen.getByText((text) => text.startsWith(`${label} last refreshed`))).toBeTruthy();
  });

  it("names both failed support reads without treating fresh blacklist as failed", () => {
    mocks.useBlacklistSummary.mockReturnValue(stubQuery({ data: makeSummary() }));
    mocks.useBlacklistEventsPage.mockReturnValue(stubQuery({ data: { events: [], total: 0 } }));
    mocks.useStablecoins.mockReturnValue(stubQuery({ error: new Error("supply offline") }));
    mocks.useReportCardsV9.mockReturnValue(stubQuery({ error: new Error("scores offline") }));
    render(<FreezeWatchClient />);
    expect(screen.getByText("Could not refresh Supply and Report Cards.")).toBeTruthy();
    expect(screen.queryByText(/Could not refresh Blacklist/)).toBeNull();
  });

  it("keeps retained supply and score data visible with source-qualified refresh warnings", () => {
    currentSearch = "?status=yes";
    mocks.useStablecoins.mockReturnValue(stubQuery({ data: { peggedAssets: [] }, error: new Error("supply offline") }));
    mocks.useReportCardsV9.mockReturnValue(stubQuery({ data: { cards: [] }, error: new Error("scores offline") }));
    render(<FreezeWatchClient />);
    expect(screen.getByTestId("stablecoin-table")).toBeTruthy();
    expect(screen.getByText(/Supply and Report Cards remain available/)).toBeTruthy();
    expect(screen.queryByText(/Freeze status data is temporarily unavailable/)).toBeNull();
  });

  it("does not warn about support sources during their first pending reads", () => {
    mocks.useStablecoins.mockReturnValue(stubQuery({ isLoading: true }));
    mocks.useReportCardsV9.mockReturnValue(stubQuery({ isLoading: true }));
    render(<FreezeWatchClient />);
    expect(screen.queryByText(/has not populated|have not populated|Could not refresh/)).toBeNull();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("keeps successful empty summary semantics in both real auxiliary panels", () => {
    const summary = makeSummary();
    summary.coverage!.supported = [];
    summary.coverage!.counts = {
      supportedConfigs: 0, unsupportedDeferredConfigs: 0, bySymbol: {}, byChain: {}, byProviderSource: {},
    };
    mocks.useBlacklistSummary.mockReturnValue(stubQuery({ data: summary }));
    render(<FreezeWatchClient />);
    expect(screen.getByText("Events tracked").nextElementSibling?.textContent).toBe("0");
    expect(screen.getByText(/No live coverage configurations/)).toBeTruthy();
    expect(screen.getByText(/No freeze-ledger quarter data/)).toBeTruthy();
  });

  it("retains auxiliary summary facts and labels failed refreshes", () => {
    const summary = makeSummary();
    summary.stats.perCoinQuarterlyEventTypes.USDC = [{ quarter: "Q1 '26", blacklist: 7, unblacklist: 0, destroy: 0 }];
    mocks.useBlacklistSummary.mockReturnValue(stubQuery({ data: summary, error: new Error("summary offline") }));
    render(<FreezeWatchClient />);
    expect(screen.getByText("Events tracked").nextElementSibling?.textContent).toBe("7");
    expect(screen.getByRole("button", { name: "USDC Ethereum coverage supported" })).toBeTruthy();
    expect(screen.getByText(/Intervention seismograph refresh failed/)).toBeTruthy();
    expect(screen.getByText(/Watched contract coverage refresh failed/)).toBeTruthy();
  });

  it("reads the hero and the drilldown as unavailable when the support query fails", () => {
    const failure = new Error("stablecoin list unavailable");
    currentSearch = "?status=yes";
    mocks.useStablecoins.mockReturnValue(stubQuery({ data: undefined, error: failure }));

    render(<FreezeWatchClient />);

    expect(
      screen.getByText("Freezable supply data is temporarily unavailable. No status claim is being made."),
    ).toBeTruthy();
    expect(screen.getByText("Freeze status data is temporarily unavailable. No status claim is being made.")).toBeTruthy();
    // Support failures use the source-qualified freshness notice, not raw transport errors.
    expect(screen.getByText("Could not refresh Supply.")).toBeTruthy();
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

  it("passes compact DEX scores and the original producer generation to the drilldown", () => {
    currentSearch = "?status=yes";
    const dexLiquidity = { "usdc-circle": { liquidityScore: 0 }, "usdt-tether": { liquidityScore: null } };
    mocks.useDexLiquidityTable.mockReturnValue({
      ...stubQuery({ data: dexLiquidity }), meta: { updatedAt: 1_700_000_000 },
    });
    render(<FreezeWatchClient />);
    expect(mocks.stablecoinTable.mock.calls.at(-1)?.[0]).toMatchObject({
      dexLiquidity, sourceGenerations: { dexLiquidity: 1_700_000_000 },
    });
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
    expect(screen.queryByText("Events tracked")).toBeNull();
    expect(screen.queryByText(/No live coverage configurations/)).toBeNull();
    expect(screen.getByText(/Watched contract coverage is temporarily unavailable/)).toBeTruthy();
    expect(screen.getByText(/Intervention seismograph is temporarily unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry watched contract coverage" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry intervention seismograph" }));
    expect(mocks.useBlacklistSummary.mock.results.at(-1)?.value.refetch).toHaveBeenCalledTimes(2);
  });
});
