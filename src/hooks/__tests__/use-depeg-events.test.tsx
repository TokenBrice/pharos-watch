// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { useInfiniteQueryMock, apiFetchWithMetaMock } = vi.hoisted(() => ({
  useInfiniteQueryMock: vi.fn(),
  apiFetchWithMetaMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  infiniteQueryOptions: (options: unknown) => options,
  useInfiniteQuery: useInfiniteQueryMock,
}));

vi.mock("@/lib/api", () => ({
  apiFetchWithMeta: apiFetchWithMetaMock,
}));

import { useActiveDepegEvents, useInfiniteDepegEvents } from "../use-depeg-events";

describe("useInfiniteDepegEvents", () => {
  it("flattens paged results and auto-loads remaining pages when requested", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    useInfiniteQueryMock.mockReturnValue({
      data: {
        pages: [
          {
            data: {
              events: [{ id: 1 }, { id: 2 }],
              total: 3,
              totalExact: false,
              nextCursor: "cursor-2",
              pending: [{ stablecoinId: "coin-a" }],
              counts: { incidents: 3, thresholdCrossings: 5 },
            },
            meta: { status: "fresh" },
          },
          {
            data: {
              events: [{ id: 3 }],
              total: 3,
              totalExact: false,
              nextCursor: null,
            },
            meta: null,
          },
        ],
      },
      error: null,
      fetchNextPage,
      hasNextPage: true,
      isFetchingNextPage: false,
      isLoading: false,
      isError: false,
    });

    const { result } = renderHook(() => useInfiniteDepegEvents({
      stablecoinId: "usdc-circle",
      autoLoadAll: true,
    }));

    await waitFor(() => expect(fetchNextPage).toHaveBeenCalledOnce());

    expect(result.current.data).toEqual({
      events: [{ id: 1 }, { id: 2 }, { id: 3 }],
      total: 3,
      totalExact: false,
      nextCursor: null,
      pending: [{ stablecoinId: "coin-a" }],
      counts: { incidents: 3, thresholdCrossings: 5 },
    });
    expect(result.current.loadedCount).toBe(3);
    expect(result.current.isFullyLoaded).toBe(true);
    expect(result.current.meta).toEqual({ status: "fresh" });

    const options = useInfiniteQueryMock.mock.calls[0][0] as {
      staleTime: number;
      refetchInterval: number;
      queryKey: unknown[];
      getNextPageParam: (lastPage: { data: { nextCursor?: string | null } }) => string | undefined;
      queryFn: ({ pageParam, signal }: { pageParam: string | null; signal?: AbortSignal }) => Promise<unknown>;
    };
    expect(options.queryKey).toEqual([
      "depeg-events",
      "infinite",
      "usdc-circle",
      { activeOnly: false, includePending: false },
    ]);
    expect(options.staleTime).toBe(15 * 60 * 1000);
    expect(options.refetchInterval).toBe(30 * 60 * 1000);
    expect(options.getNextPageParam(
      { data: { nextCursor: "cursor-3" } },
    )).toBe("cursor-3");

    await options.queryFn({ pageParam: "cursor-2" });
    expect(apiFetchWithMetaMock).toHaveBeenCalledWith(
      "/api/depeg-events?stablecoin=usdc-circle&limit=100&cursor=cursor-2&includeTotal=false",
      expect.anything(),
      { signal: undefined },
    );
  });

  it("keeps derived data references stable when query pages are unchanged", () => {
    const pages = [
      {
        data: {
          events: [{ id: 1 }],
          total: 1,
          totalExact: true,
          nextCursor: null,
          pending: [{ stablecoinId: "coin-a" }],
        },
        meta: { status: "fresh" },
      },
    ];
    useInfiniteQueryMock.mockReturnValue({
      data: { pages },
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      isError: false,
    });

    const { result, rerender } = renderHook(() => useInfiniteDepegEvents());
    const firstData = result.current.data;
    const firstEvents = result.current.data.events;
    const firstPending = result.current.data.pending;

    rerender();

    expect(result.current.data).toBe(firstData);
    expect(result.current.data.events).toBe(firstEvents);
    expect(result.current.data.pending).toBe(firstPending);
    expect(result.current.meta).toBe(pages[0].meta);
  });

  it("builds active-only cursor queries", async () => {
    useInfiniteQueryMock.mockReturnValue({
      data: undefined,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      isError: false,
    });

    renderHook(() => useActiveDepegEvents({ stablecoinId: "usdt-tether" }));

    const latestCall = useInfiniteQueryMock.mock.calls[useInfiniteQueryMock.mock.calls.length - 1];
    const options = latestCall?.[0] as {
      queryKey: unknown[];
      queryFn: ({ pageParam, signal }: { pageParam: string | null; signal?: AbortSignal }) => Promise<unknown>;
    };
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
    useInfiniteQueryMock.mockReturnValue({
      data: undefined,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      isError: false,
    });

    renderHook(() => useInfiniteDepegEvents({ includePending: true }));

    const latestCall = useInfiniteQueryMock.mock.calls[useInfiniteQueryMock.mock.calls.length - 1];
    const options = latestCall?.[0] as {
      queryKey: unknown[];
      queryFn: ({ pageParam, signal }: { pageParam: string | null; signal?: AbortSignal }) => Promise<unknown>;
    };
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
