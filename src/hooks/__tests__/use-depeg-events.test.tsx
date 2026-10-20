// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { useInfiniteQueryMock, apiFetchWithMetaMock } = vi.hoisted(() => ({
  useInfiniteQueryMock: vi.fn(),
  apiFetchWithMetaMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  infiniteQueryOptions: (options: unknown) => options,
  keepPreviousData: Symbol("keepPreviousData"),
  useQuery: vi.fn(),
  useInfiniteQuery: useInfiniteQueryMock,
}));

vi.mock("@/lib/api", () => ({
  apiFetchWithMeta: apiFetchWithMetaMock,
}));

import { DEFAULT_MAX_AUTO_PAGES } from "../use-auto-load-infinite-pages";
import { useActiveDepegEvents, useInfiniteDepegEvents } from "../use-depeg-events";
import { latestInfiniteQueryOptions, makeInfiniteQueryResult } from "./infinite-event-hooks.test-support";
import type { CursorPageFixture } from "./infinite-event-hooks.test-support";
import { DepegEventsResponseSchema } from "@shared/types/market";

/**
 * Cursor pages as the depeg-events endpoint serves them: the terminal page
 * carries no cursor and omits `pending` once nothing is outstanding.
 */
interface DepegEventsPageFixtureData {
  events: { id: number }[];
  total: number;
  totalExact: boolean;
  nextCursor: string | null;
  pending?: { stablecoinId: string }[];
}

const FIRST_PAGE: CursorPageFixture<DepegEventsPageFixtureData> = {
  data: {
    events: [{ id: 1 }, { id: 2 }],
    total: 3,
    totalExact: false,
    nextCursor: "cursor-2",
    pending: [{ stablecoinId: "coin-a" }],
  },
  meta: { status: "fresh" },
};

const TERMINAL_PAGE: CursorPageFixture<DepegEventsPageFixtureData> = {
  data: {
    events: [{ id: 3 }],
    total: 3,
    totalExact: false,
    nextCursor: null,
  },
  meta: null,
};

describe("useInfiniteDepegEvents", () => {
  it("preserves unavailable first-page data after a settled error, but observes an empty success", () => {
    useInfiniteQueryMock.mockReturnValue(makeInfiniteQueryResult([], { isError: true, error: new Error("unavailable") }));
    const { result, rerender } = renderHook(() => useInfiniteDepegEvents({ includePending: true }));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.isFullyLoaded).toBe(false);
    useInfiniteQueryMock.mockReturnValue(makeInfiniteQueryResult([{
      data: { events: [], pending: [], total: 0, totalExact: true, nextCursor: null },
    }]));
    rerender();
    expect(result.current.data).toMatchObject({ events: [], pending: [], total: 0 });
  });
  it("auto-loads the outstanding cursor page exactly once and flattens the result", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    // First render: one page with an outstanding cursor. After the fetch, the query
    // reports both pages and no further cursor — the only state real pagination reaches.
    useInfiniteQueryMock.mockReturnValueOnce(
      makeInfiniteQueryResult([FIRST_PAGE], { fetchNextPage, hasNextPage: true }),
    );
    useInfiniteQueryMock.mockReturnValue(
      makeInfiniteQueryResult([FIRST_PAGE, TERMINAL_PAGE], { fetchNextPage }),
    );

    const { result, rerender } = renderHook(() => useInfiniteDepegEvents({
      stablecoinId: "usdc-circle",
      autoLoadAll: true,
    }));

    await waitFor(() => expect(fetchNextPage).toHaveBeenCalledOnce());
    expect(result.current.isFullyLoaded).toBe(false);

    rerender();

    expect(result.current.data).toEqual({
      events: [{ id: 1 }, { id: 2 }, { id: 3 }],
      total: 3,
      totalExact: false,
      nextCursor: null,
      pending: [{ stablecoinId: "coin-a" }],
    });
    expect(result.current.loadedCount).toBe(3);
    // An inexact total does not hold completion open once the cursor is exhausted.
    expect(result.current.isFullyLoaded).toBe(true);
    expect(result.current.meta).toEqual({ status: "fresh" });
    // Traversal stops at exhaustion instead of re-firing on every render.
    rerender();
    expect(fetchNextPage).toHaveBeenCalledOnce();

    const options = latestInfiniteQueryOptions(useInfiniteQueryMock);
    expect(options.queryKey).toEqual([
      "depeg-events",
      "infinite",
      "usdc-circle",
      { activeOnly: false, includePending: false },
    ]);
    expect(options.staleTime).toBe(15 * 60 * 1000);
    expect(options.refetchInterval).toBe(30 * 60 * 1000);
    expect(options.getNextPageParam({ data: { nextCursor: "cursor-3" } })).toBe("cursor-3");

    await options.queryFn({ pageParam: "cursor-2" });
    expect(apiFetchWithMetaMock).toHaveBeenCalledWith(
      "/api/depeg-events?stablecoin=usdc-circle&limit=100&cursor=cursor-2&includeTotal=false",
      expect.anything(),
      { signal: undefined },
    );
  });

  it("holds an exact total open until every counted event is loaded", () => {
    const exactPage = (events: { id: number }[]) => ({
      data: { events, total: 3, totalExact: true, nextCursor: null, pending: [] },
      meta: null,
    });
    useInfiniteQueryMock.mockReturnValue(makeInfiniteQueryResult([exactPage([{ id: 1 }, { id: 2 }])]));

    const { result, rerender } = renderHook(() => useInfiniteDepegEvents());

    // Cursor exhausted, but the exact total still promises a third event.
    expect(result.current.loadedCount).toBe(2);
    expect(result.current.isFullyLoaded).toBe(false);

    useInfiniteQueryMock.mockReturnValue(
      makeInfiniteQueryResult([exactPage([{ id: 1 }, { id: 2 }, { id: 3 }])]),
    );
    rerender();

    expect(result.current.isFullyLoaded).toBe(true);
  });

  it("stays incomplete while a cursor remains even after the exact total is reached", () => {
    useInfiniteQueryMock.mockReturnValue(makeInfiniteQueryResult([{
      data: {
        events: [{ id: 1 }, { id: 2 }],
        total: 2,
        totalExact: true,
        nextCursor: "cursor-2",
        pending: [],
      },
      meta: null,
    }]));

    const { result } = renderHook(() => useInfiniteDepegEvents());

    expect(result.current.loadedCount).toBe(2);
    expect(result.current.isFullyLoaded).toBe(false);
  });

  it("stops auto-loading at the page ceiling and reports the history partial", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    const cappedPages = Array.from({ length: DEFAULT_MAX_AUTO_PAGES }, (_, index) => ({
      data: {
        events: [{ id: index + 1 }],
        total: 5_000,
        totalExact: true,
        nextCursor: `cursor-${index + 2}`,
        pending: [],
      },
      meta: null,
    }));
    useInfiniteQueryMock.mockReturnValue(
      makeInfiniteQueryResult(cappedPages, { fetchNextPage, hasNextPage: true }),
    );

    const { result, rerender } = renderHook(() => useActiveDepegEvents({ autoLoadAll: true }));

    rerender();
    await waitFor(() => expect(result.current.isAutoLoadCapped).toBe(true));
    expect(fetchNextPage).not.toHaveBeenCalled();
    expect(result.current.isFullyLoaded).toBe(false);
    expect(result.current.loadedCount).toBe(DEFAULT_MAX_AUTO_PAGES);
  });

  it("builds active-only cursor queries", async () => {
    useInfiniteQueryMock.mockReturnValue(makeInfiniteQueryResult([]));

    renderHook(() => useActiveDepegEvents({ stablecoinId: "usdt-tether" }));

    const options = latestInfiniteQueryOptions(useInfiniteQueryMock);
    expect(options.queryKey).toEqual([
      "depeg-events",
      "infinite",
      "usdt-tether",
      { activeOnly: true, includePending: false },
    ]);

    await options.queryFn({ pageParam: null });
    expect(apiFetchWithMetaMock).toHaveBeenLastCalledWith(
      "/api/depeg-events?stablecoin=usdt-tether&limit=100&active=true&includeTotal=false",
      expect.anything(),
      { signal: undefined },
    );
  });

  it("admits complete canonical active IDs across pages without requiring constituent identities", () => {
    const event = {
      stablecoinId: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", direction: "below",
      peakDeviationBps: -300, startedAt: 1_700_000_000, endedAt: null,
      startPrice: 0.97, peakPrice: 0.96, recoveryPrice: null, pegReference: 1, source: "live",
    };
    const first = {
      data: DepegEventsResponseSchema.parse({
        events: [{ ...event, id: 102, constituentEventCount: 2 }],
        total: 2, totalExact: false, nextCursor: "next",
      }),
      meta: { updatedAt: 1_700_000_300, status: "fresh" },
    };
    const last = {
      data: DepegEventsResponseSchema.parse({
        events: [{ ...event, id: 103, startedAt: 1_699_000_000 }],
        total: 1, totalExact: false, nextCursor: null,
      }),
      meta: null,
    };
    useInfiniteQueryMock.mockReturnValue(makeInfiniteQueryResult([first], { hasNextPage: true }));
    const { result, rerender } = renderHook(() => useActiveDepegEvents());
    expect(result.current.isFullyLoaded).toBe(false);
    useInfiniteQueryMock.mockReturnValue(makeInfiniteQueryResult([first, last]));
    rerender();
    expect(result.current.isFullyLoaded).toBe(true);
    expect(result.current.data?.events.map(({ id }) => id)).toEqual([102, 103]);
    expect(result.current.data?.events[0]?.constituentEventCount).toBe(2);
    expect(result.current.meta).toEqual(first.meta);
    useInfiniteQueryMock.mockReturnValue(makeInfiniteQueryResult([first, last], { error: new Error("refresh failed") }));
    rerender();
    expect(result.current.data?.events).toHaveLength(2);
    expect(result.current.isFullyLoaded).toBe(false);
  });

  it("requests pending incidents when enabled", async () => {
    useInfiniteQueryMock.mockReturnValue(makeInfiniteQueryResult([]));

    renderHook(() => useInfiniteDepegEvents({ includePending: true }));

    const options = latestInfiniteQueryOptions(useInfiniteQueryMock);
    expect(options.queryKey).toEqual([
      "depeg-events",
      "infinite",
      null,
      { activeOnly: false, includePending: true },
    ]);

    await options.queryFn({ pageParam: null });
    expect(apiFetchWithMetaMock).toHaveBeenLastCalledWith(
      "/api/depeg-events?limit=100&includeTotal=false&includePending=true",
      expect.anything(),
      { signal: undefined },
    );
  });
});
