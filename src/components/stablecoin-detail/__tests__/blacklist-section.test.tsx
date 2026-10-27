// @vitest-environment jsdom

import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});


vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistSummary: vi.fn(),
  useBlacklistEventsPage: vi.fn(() => ({ data: { events: [], total: 0 }, isLoading: false, isError: false })),
}));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: { current: null }, ready: false, width: 0, height: 0 }),
}));

// BlacklistSection renders after the mocks are defined so the vi.mock hoists apply.
import { BlacklistHistorySection, BlacklistSection } from "@/components/stablecoin-detail/blacklist-section";
import { useBlacklistEventsPage, useBlacklistSummary } from "@/hooks/use-blacklist-events";
import type { BlacklistEvent } from "@shared/types";
import type { ApiMeta } from "@/lib/api";

type EventsPageResult = ReturnType<typeof useBlacklistEventsPage>;

const FREEZE_EVENT: BlacklistEvent = {
  id: "evt-1",
  stablecoin: "USDC",
  chainId: "ethereum",
  chainName: "Ethereum",
  eventType: "blacklist",
  address: "0x0000000000000000000000000000000000000001",
  amountNative: null,
  amountUsdAtEvent: null,
  amountSource: "unavailable",
  amountStatus: "permanently_unavailable",
  txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  blockNumber: 1,
  timestamp: Date.parse("2026-05-30T00:00:00Z"),
  methodologyVersion: "5.91",
  contractAddress: null,
  configKey: null,
  eventSignature: null,
  eventTopic0: null,
  explorerTxUrl: "https://etherscan.io/tx/0x0",
  explorerAddressUrl: "https://etherscan.io/address/0x0",
};

const ONE_EVENT_PAGE = {
  data: { events: [FREEZE_EVENT], total: 1 },
  isLoading: false,
  isError: false,
} as unknown as EventsPageResult;

const EMPTY_EVENT_PAGE = {
  data: { events: [], total: 0 },
  isLoading: false,
  isError: false,
} as unknown as EventsPageResult;

function summaryStub(
  overrides: {
    perCoinTotalEvents?: Record<string, number>;
    perCoinFrozenAddressCount?: Record<string, number>;
    perCoinFrozenTotal?: Record<string, number>;
    perCoinDestroyedTotal?: Record<string, number>;
    perCoinQuarterlyEventTypes?: Record<
      string,
      Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>
    >;
  } = {},
) {
  return {
    data: {
      stats: {
        perCoinTotalEvents: overrides.perCoinTotalEvents ?? { USDC: 5 },
        perCoinFrozenAddressCount: overrides.perCoinFrozenAddressCount ?? { USDC: 3 },
        perCoinFrozenTotal: overrides.perCoinFrozenTotal ?? { USDC: 1000 },
        perCoinDestroyedTotal: overrides.perCoinDestroyedTotal ?? { USDC: 0 },
        perCoinQuarterlyEventTypes: overrides.perCoinQuarterlyEventTypes ?? {
          USDC: [{ quarter: "Q1 '26", blacklist: 5, unblacklist: 0, destroy: 0 }],
        },
      },
    },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useBlacklistSummary>;
}

describe("BlacklistSection", () => {
  it("returns null for a coin not in BLACKLIST_STABLECOINS", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub());
    const { container } = render(<BlacklistSection stablecoinId="makerdao-dai" symbol={"DAI" as "USDC"} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null for a supported coin with zero events", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub({ perCoinTotalEvents: { USDC: 0 } }));
    const { container } = render(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });

  it("links the full event feed through the canonical Freezewatch URL", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub());
    vi.mocked(useBlacklistEventsPage).mockReturnValueOnce(ONE_EVENT_PAGE);

    const { getByRole } = render(<BlacklistHistorySection stablecoinId="usdc-circle" symbol="USDC" />);

    // Freeze events are labelled with the user-facing verb, never the raw event type.
    expect(screen.getByText("Freeze")).toBeTruthy();
    expect(screen.queryByText("Blacklist")).toBeNull();
    expect(getByRole("link", { name: "See all events →" }).getAttribute("href")).toBe("/freezewatch/?stablecoin=USDC");
  });

  it("folds the event log behind a counted summary and tags a shared amount source once", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub());
    vi.mocked(useBlacklistEventsPage).mockReturnValueOnce({
      ...ONE_EVENT_PAGE,
      data: { events: [
        { ...FREEZE_EVENT, amountSource: "historical_balance" },
        { ...FREEZE_EVENT, id: "evt-2", amountSource: "historical_balance" },
      ], total: 2 },
    } as unknown as EventsPageResult);

    render(<BlacklistHistorySection stablecoinId="usdc-circle" symbol="USDC" />);

    const fold = screen.getByTestId("stablecoin-blacklist-events-table").closest("details");
    expect(fold?.open).toBe(false);
    expect(fold?.querySelector("summary")?.textContent).toMatch(/Latest events.*2/);
    expect(screen.getAllByText(/historical/i).map((el) => el.textContent)).toEqual(["Amount source: historical"]);
  });

  it("BlacklistHistorySection returns null for a supported coin with zero events", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub({ perCoinTotalEvents: { USDC: 0 } }));
    const { container } = render(<BlacklistHistorySection stablecoinId="usdc-circle" symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an explicit unavailable state when the summary errors", () => {
    vi.mocked(useBlacklistSummary).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("summary failed"),
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlacklistSummary>);
    render(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  });

  it("keeps cached summary data without a reader notice when a refresh fails", () => {
    const cachedSummary = summaryStub();
    vi.mocked(useBlacklistSummary).mockReturnValue({
      ...cachedSummary,
      error: new Error("summary refresh failed"),
      dataUpdatedAt: Date.parse("2026-07-10T00:00:00Z"),
      refetch: vi.fn(),
    } as ReturnType<typeof useBlacklistSummary>);

    render(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);

    expect(screen.queryByText(/refresh failed/i)).toBeNull();
    expect(screen.getByText(/Frozen addresses/i)).toBeTruthy();
  });

  describe("Activity and History split", () => {
    // Both sections mount on the same page; each piece of blacklist content
    // must render in exactly one of them.
    function renderBoth() {
      const { container } = render(
        <>
          <BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />
          <BlacklistHistorySection stablecoinId="usdc-circle" symbol="USDC" />
        </>,
      );
      const activity = container.querySelector<HTMLElement>("#blacklist");
      const history = container.querySelector<HTMLElement>("#blacklist-history");
      if (!activity || !history) throw new Error("both blacklist sections should be mounted");
      return { activity, history };
    }

    beforeEach(() => {
      vi.mocked(useBlacklistEventsPage).mockReturnValue(ONE_EVENT_PAGE);
    });

    afterEach(() => {
      vi.mocked(useBlacklistEventsPage).mockReturnValue(EMPTY_EVENT_PAGE);
    });

    it("keeps summary stats in Activity and the event feed in History", () => {
      vi.mocked(useBlacklistSummary).mockReturnValue(summaryStub());
      const { activity, history } = renderBoth();

      expect(within(activity).queryAllByText(/Frozen addresses/i)).toHaveLength(1);
      expect(within(history).queryAllByText(/Frozen addresses/i)).toHaveLength(0);
      expect(within(history).queryAllByTestId("stablecoin-blacklist-events-table")).toHaveLength(1);
      expect(within(activity).queryAllByTestId("stablecoin-blacklist-events-table")).toHaveLength(0);
    });

    it("reports a stale summary once, in Activity", () => {
      vi.mocked(useBlacklistSummary).mockReturnValue({
        ...summaryStub(),
        error: new Error("summary refresh failed"),
        dataUpdatedAt: Date.parse("2026-07-10T00:00:00Z"),
        refetch: vi.fn(),
      } as ReturnType<typeof useBlacklistSummary>);
      const { activity, history } = renderBoth();

      expect(within(activity).queryAllByRole("status").length).toBeGreaterThan(0);
      expect(within(history).queryAllByRole("status")).toHaveLength(0);
    });

    it("reports an unavailable summary once and still shows the independently loaded feed", () => {
      vi.mocked(useBlacklistSummary).mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        error: new Error("summary failed"),
        dataUpdatedAt: 0,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useBlacklistSummary>);
      const { activity, history } = renderBoth();

      expect(within(activity).getAllByRole("alert")).toHaveLength(1);
      expect(within(history).queryAllByRole("alert")).toHaveLength(0);
      expect(within(history).queryAllByTestId("stablecoin-blacklist-events-table")).toHaveLength(1);
    });
  });
});

it.each([
  { meta: { updatedAt: Math.floor(Date.now() / 1000) - 86_400, status: "fresh", freshBudgetSec: 60, degradedBudgetSec: 120 }, state: "stale" },
  { meta: { updatedAt: null, status: "unknown", ageSeconds: null }, state: "unavailable" },
  { meta: { updatedAt: Math.floor(Date.now() / 1000), status: "fresh", warning: "Scan incomplete" }, state: null },
] as { meta: ApiMeta; state: string | null }[])("keeps blacklist producer metadata authoritative after refetch ($state)", ({ meta, state }) => {
  const receipt = Date.now();
  const result = { ...summaryStub(), meta, dataUpdatedAt: receipt, error: null, refetch: vi.fn() };
  vi.mocked(useBlacklistSummary).mockReturnValue(result);
  const { container, rerender } = render(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);
  const producerTime = meta.updatedAt != null ? new Date(meta.updatedAt * 1000).toISOString() : null;
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  // A source advisory over a current generation is operator signal; only stale or missing data is public.
  if (state) expect(container.querySelector(`[data-health-state="${state}"]`)).toBeTruthy();
  else expect(container.querySelector("[data-health-state]")).toBeNull();
  vi.mocked(useBlacklistSummary).mockReturnValue({ ...result, dataUpdatedAt: receipt + 30_000 });
  rerender(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  vi.mocked(useBlacklistSummary).mockReturnValue({ ...result, error: new Error("refresh failed") });
  rerender(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  expect(screen.queryByText(/refresh failed/i)).toBeNull();
  expect(screen.getByText(/Frozen addresses/i)).toBeTruthy();
});

it("ages the saved blacklist generation without a query update", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const receipt = Date.now();
  vi.mocked(useBlacklistSummary).mockReturnValue({
    ...summaryStub(), dataUpdatedAt: receipt, error: null,
    meta: { updatedAt: receipt / 1000, ageSeconds: 0, status: "fresh", freshBudgetSec: 60, degradedBudgetSec: 120 },
  });
  const { container } = render(<BlacklistSection stablecoinId="usdc-circle" symbol="USDC" />);
  expect(container.querySelector("[data-health-state]")).toBeNull();
  act(() => vi.advanceTimersByTime(50));
  act(() => vi.advanceTimersByTime(60_001));
  expect(container.querySelector("[data-health-state]")).toBeNull();
  act(() => vi.advanceTimersByTime(60_000));
  expect(container.querySelector('[data-health-state="stale"]')).toBeTruthy();
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(new Date(receipt).toISOString());
});
