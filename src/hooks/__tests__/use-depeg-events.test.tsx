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

import { useActiveDepegEvents, useInfiniteDepegEvents } from "../use-depeg-events";
import { latestInfiniteQueryOptions, makeInfiniteQueryResult } from "./infinite-event-hooks.test-support";
import type { CursorPageFixture } from "./infinite-event-hooks.test-support";

/**
 * Cursor pages as the depeg-events endpoint serves them: the terminal page
 * carries no cursor and omits `pending`/`counts` once nothing is outstanding.
 */
interface DepegEventsPageFixtureData {
  events: { id: number }[];
  total: number;
  totalExact: boolean;
  nextCursor: string | null;
  pending?: { stablecoinId: string }[];
  counts?: { incidents: number; thresholdCrossings: number };
}

const FIRST_PAGE: CursorPageFixture<DepegEventsPageFixtureData> = {
  data: {
    events: [{ id: 1 }, { id: 2 }],
    total: 3,
    totalExact: false,
    nextCursor: "cursor-2",
    pending: [{ stablecoinId: "coin-a" }],
    counts: { incidents: 3, thresholdCrossings: 5 },
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
      counts: { incidents: 3, thresholdCrossings: 5 },
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

  it("keeps derived data references stable when query pages are unchanged", () => {
    const page = {
      data: {
        events: [{ id: 1 }],
        total: 1,
        totalExact: true,
        nextCursor: null,
        pending: [{ stablecoinId: "coin-a" }],
      },
      meta: { status: "fresh" },
    };
    useInfiniteQueryMock.mockReturnValue(makeInfiniteQueryResult([page]));

    const { result, rerender } = renderHook(() => useInfiniteDepegEvents());
    const firstData = result.current.data;
    const firstEvents = result.current.data.events;
    const firstPending = result.current.data.pending;

    rerender();

    expect(result.current.data).toBe(firstData);
    expect(result.current.data.events).toBe(firstEvents);
    expect(result.current.data.pending).toBe(firstPending);
    expect(result.current.meta).toBe(page.meta);
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
