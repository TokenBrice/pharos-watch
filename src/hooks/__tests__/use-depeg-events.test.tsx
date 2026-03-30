// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { useInfiniteQueryMock, apiFetchWithMetaMock } = vi.hoisted(() => ({
  useInfiniteQueryMock: vi.fn(),
  apiFetchWithMetaMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: useInfiniteQueryMock,
}));

vi.mock("@/lib/api", () => ({
  apiFetchWithMeta: apiFetchWithMetaMock,
}));

import { useInfiniteDepegEvents } from "../use-depeg-events";

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
            },
            meta: { status: "fresh" },
          },
          {
            data: {
              events: [{ id: 3 }],
              total: 3,
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
    });
    expect(result.current.loadedCount).toBe(3);
    expect(result.current.isFullyLoaded).toBe(true);
    expect(result.current.meta).toEqual({ status: "fresh" });

    const options = useInfiniteQueryMock.mock.calls[0][0] as {
      staleTime: number;
      refetchInterval: number;
      queryKey: unknown[];
      getNextPageParam: (lastPage: { data: { events: unknown[]; total: number } }, allPages: Array<{ data: { events: unknown[]; total: number } }>) => number | undefined;
      queryFn: ({ pageParam }: { pageParam: number }) => Promise<unknown>;
    };
    expect(options.queryKey).toEqual(["depeg-events", "infinite", "usdc-circle"]);
    expect(options.staleTime).toBe(15 * 60 * 1000);
    expect(options.refetchInterval).toBe(30 * 60 * 1000);
    expect(options.getNextPageParam(
      { data: { events: [{ id: 3 }], total: 5 } },
      [
        { data: { events: [{ id: 1 }, { id: 2 }], total: 5 } },
        { data: { events: [{ id: 3 }], total: 5 } },
      ],
    )).toBe(3);

    await options.queryFn({ pageParam: 200 });
    expect(apiFetchWithMetaMock).toHaveBeenCalledWith(
      "/api/depeg-events?stablecoin=usdc-circle&limit=100&offset=200",
      expect.anything(),
    );
  });
});
