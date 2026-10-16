import { beforeEach, describe, expect, it, vi } from "vitest";

const { useQueryMock } = vi.hoisted(() => ({ useQueryMock: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));

import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { useHealth, useStabilityIndex, useTelegramPulse } from "../api-hooks";
import { usePublicEndpointProbes } from "../use-endpoint-probes";

function queryContext(queryKey: readonly unknown[]) {
  return { signal: new AbortController().signal, queryKey, meta: undefined } as never;
}

describe("query polling policy", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
      isFetching: false,
      dataUpdatedAt: 0,
    });
    vi.restoreAllMocks();
  });

  it.each([
    { name: "health", useHook: useHealth, descriptor: FRONTEND_API_QUERY_DESCRIPTORS.health, retry: 1 },
    {
      name: "stability index",
      useHook: useStabilityIndex,
      descriptor: FRONTEND_API_QUERY_DESCRIPTORS.stabilityIndex,
      retry: 2,
    },
    {
      name: "Telegram pulse",
      useHook: useTelegramPulse,
      descriptor: FRONTEND_API_QUERY_DESCRIPTORS.telegramPulse,
      retry: 2,
    },
  ])("binds the $name hook to its registered descriptor", ({ useHook, descriptor, retry }) => {
    useHook();
    const options = useQueryMock.mock.calls[0][0] as {
      queryKey: readonly unknown[];
      staleTime: number;
      retry: number;
    };

    expect(options.queryKey).toEqual(descriptor.queryKey);
    expect(options.staleTime).toBe(descriptor.producerIntervalMs);
    expect(options.retry).toBe(retry);
  });


  it("keeps public probes on their own endpoint set and cache key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "healthy" }),
    } as Response);

    usePublicEndpointProbes({ enabled: false });
    const options = useQueryMock.mock.calls[0][0] as {
      enabled: boolean;
      retry: number;
      staleTime: number;
      refetchInterval: number;
      queryKey: readonly unknown[];
      queryFn: (context: ReturnType<typeof queryContext>) => Promise<unknown[]>;
    };

    expect(options.enabled).toBe(false);
    expect(options.retry).toBe(0);
    expect(options.queryKey).toEqual(["endpoint-probes", "public"]);
    expect(options.staleTime).toBe(900_000);
    expect(options.refetchInterval).toBe(1_800_000);
    await options.queryFn(queryContext(options.queryKey));
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map((call) => {
      const input = call[0];
      return input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://pharos.watch").pathname;
    })).toEqual([
      "/api/health",
      "/api/stablecoins",
      "/api/peg-summary",
      "/api/dex-liquidity",
      "/api/report-cards/v9",
    ]);
  });

});
