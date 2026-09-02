// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useInfiniteQueryMock, apiFetchWithMetaMock, useRegisteredApiQueryMock } = vi.hoisted(() => ({
  useInfiniteQueryMock: vi.fn(),
  apiFetchWithMetaMock: vi.fn(),
  useRegisteredApiQueryMock: vi.fn(),
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

vi.mock("../api-hooks", () => ({
  useRegisteredApiQuery: useRegisteredApiQueryMock,
}));

import { CRON_TAPE } from "@/lib/cron-intervals";
import { useEvents, useLatestEvents } from "../use-events";

describe("useEvents", () => {
  beforeEach(() => {
    useInfiniteQueryMock.mockReset();
    apiFetchWithMetaMock.mockReset();
    useRegisteredApiQueryMock.mockReset();
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
      staleTime: number;
      refetchInterval: number;
      queryFn: ({ pageParam, signal }: { pageParam: string | null; signal?: AbortSignal }) => Promise<unknown>;
    };

    expect(options.staleTime).toBe(CRON_TAPE);
    expect(options.refetchInterval).toBe(2 * CRON_TAPE);

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
      expect.any(Object),
      expect.objectContaining({
        signal: undefined,
      }),
    );

    const schema = apiFetchWithMetaMock.mock.calls[0]?.[1];
    expect(schema.safeParse({ events: [{ id: "incomplete" }], nextCursor: null }).success).toBe(false);
  });

  it("uses the canonical Tape events runtime schema for latest-event queries", async () => {
    useRegisteredApiQueryMock.mockReturnValue({ data: undefined, meta: null });

    renderHook(() => useLatestEvents({ coin: "usdc-circle", limit: 10 }));

    expect(useRegisteredApiQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: expect.any(Array),
        path: "/api/events?coin=usdc-circle&limit=10",
        producerIntervalMs: CRON_TAPE,
        schema: expect.any(Function),
      }),
      { enabled: true },
    );
    const schema = await useRegisteredApiQueryMock.mock.calls[0]?.[0]?.schema();
    expect(schema.safeParse({ events: [], nextCursor: null, total: null, totalExact: true }).success).toBe(true);
    expect(schema.safeParse({ events: [], nextCursor: null }).success).toBe(false);
  });
});
