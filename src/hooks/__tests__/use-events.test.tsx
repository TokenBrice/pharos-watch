// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { useEvents } from "../use-events";

describe("useEvents", () => {
  beforeEach(() => {
    useInfiniteQueryMock.mockReset();
    apiFetchWithMetaMock.mockReset();
  });

  it("flattens paged results and auto-loads remaining pages when requested", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    useInfiniteQueryMock.mockReturnValue({
      data: {
        pages: [
          {
            data: {
              events: [{ id: "evt-1" }, { id: "evt-2" }],
              nextCursor: "cursor-2",
              total: 3,
            },
            meta: { status: "fresh" },
          },
          {
            data: {
              events: [{ id: "evt-3" }],
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

    const { result } = renderHook(() => useEvents({ coin: "usdc-circle" }, { autoLoadAll: true }));

    await waitFor(() => expect(fetchNextPage).toHaveBeenCalledOnce());

    expect(result.current.data).toEqual({
      events: [{ id: "evt-1" }, { id: "evt-2" }, { id: "evt-3" }],
      nextCursor: null,
    });
    expect(result.current.loadedCount).toBe(3);
    expect(result.current.isFullyLoaded).toBe(true);
    expect(result.current.meta).toEqual({ status: "fresh" });
    expect(result.current.total).toBe(3);
  });

  it("builds stable infinite query keys and cursor paths", async () => {
    useInfiniteQueryMock.mockReturnValue({
      data: undefined,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      isError: false,
    });

    renderHook(() => useEvents({ coin: "usdc-circle", type: ["peg.alert", "depeg.confirmed"] }));

    const options = useInfiniteQueryMock.mock.calls[0][0] as {
      queryKey: unknown[];
      queryFn: ({ pageParam, signal }: { pageParam: string | null; signal?: AbortSignal }) => Promise<unknown>;
    };

    expect(options.queryKey).toEqual([
      "events",
      "infinite",
      {
        type: ["depeg.confirmed", "peg.alert"],
        coin: "usdc-circle",
        pegCurrency: null,
        chain: null,
        severityFloor: null,
        since: null,
        until: null,
        q: null,
      },
    ]);

    await options.queryFn({ pageParam: "cursor-2" });
    expect(apiFetchWithMetaMock).toHaveBeenCalledWith(
      "/api/events?type=peg.alert&type=depeg.confirmed&coin=usdc-circle&limit=500&cursor=cursor-2",
      expect.anything(),
      { signal: undefined },
    );
  });
});
