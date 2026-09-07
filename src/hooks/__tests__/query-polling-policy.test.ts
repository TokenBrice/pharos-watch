import { beforeEach, describe, expect, it, vi } from "vitest";

const { useQueryMock } = vi.hoisted(() => ({ useQueryMock: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@shared/lib/api-endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/api-endpoints")>();
  return {
    ...actual,
    getProbePaths: (group: "public" | "admin" | "manual") => {
      if (group === "public") return ["/api/health"];
      if (group === "admin") return ["/api/status"];
      return ["/api/sync-stablecoins"];
    },
  };
});

import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { makeApiRequestAttributionResponse } from "@/test-utils/status-fixtures";
import { useHealth, useStabilityIndex, useTelegramPulse } from "../api-hooks";
import { useRequestSourceStats, useStatus } from "../admin-api-hooks";
import { useEndpointProbes, usePublicEndpointProbes } from "../use-endpoint-probes";

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

  it("keeps one admin hook smoke for proxying and abort-signal forwarding", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeApiRequestAttributionResponse(),
    } as Response);

    useRequestSourceStats();
    const options = useQueryMock.mock.calls[0][0] as {
      enabled?: boolean;
      retry: number;
      queryKey: readonly unknown[];
      queryFn: (context: ReturnType<typeof queryContext>) => Promise<unknown>;
    };

    expect(options.enabled).toBeUndefined();
    expect(options.retry).toBe(0);
    expect(options.queryKey).toEqual(["request-source-stats", 24, 3600, 5, 25, "ops-proxy"]);

    await options.queryFn(queryContext(options.queryKey));
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/admin/request-source-stats?hours=24&bucketSec=3600&routeLimit=5&apiKeyLimit=25");
    expect(init).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("lets operator workspaces disable status polling", () => {
    useStatus({ enabled: false });
    const options = useQueryMock.mock.calls[0][0] as { enabled: boolean; queryKey: readonly unknown[] };

    expect(options.enabled).toBe(false);
    expect(options.queryKey).toEqual(["status", "ops-proxy"]);
  });

  it("uses the public and admin probe sets with same-origin admin proxying", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "healthy", overallStatus: "healthy", causes: { overall: [] } }),
    } as Response);

    useEndpointProbes();
    const options = useQueryMock.mock.calls[0][0] as {
      enabled: boolean;
      retry: number;
      queryKey: readonly unknown[];
      queryFn: (context: ReturnType<typeof queryContext>) => Promise<unknown[]>;
    };

    expect(options.enabled).toBe(true);
    expect(options.retry).toBe(0);
    expect(options.queryKey).toEqual(["endpoint-probes", "ops-proxy"]);
    await options.queryFn(queryContext(options.queryKey));

    const [publicCall, adminCall] = fetchMock.mock.calls;
    expect(publicCall[0]).toEqual(expect.stringContaining("/api/health"));
    expect((publicCall[1] as RequestInit).headers).toBeUndefined();
    expect(adminCall[0]).toBe("/api/admin/status");
    expect((adminCall[1] as RequestInit).headers).toBeUndefined();
  });

  it("gives critical operator probes a distinct cache key and supports disabling them", () => {
    useEndpointProbes({ mode: "critical", enabled: false });
    const options = useQueryMock.mock.calls[0][0] as { enabled: boolean; queryKey: readonly unknown[] };

    expect(options.enabled).toBe(false);
    expect(options.queryKey).toEqual(["endpoint-probes", "ops-proxy", "critical"]);
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

  it("gives admin probes a longer timeout budget than public probes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
          });
        }),
    );

    useEndpointProbes();
    const options = useQueryMock.mock.calls[0][0] as {
      queryFn: (context: ReturnType<typeof queryContext>) => Promise<Array<{ error?: string; status: number | null }>>;
      queryKey: readonly unknown[];
    };

    const resultPromise = options.queryFn(queryContext(options.queryKey));
    const publicSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    const adminSignal = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.signal;

    expect(publicSignal?.aborted).toBe(false);
    expect(adminSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publicSignal?.aborted).toBe(true);
    expect(adminSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(adminSignal?.aborted).toBe(true);

    await expect(resultPromise).resolves.toEqual([
      expect.objectContaining({ status: null, error: "Browser probe timed out" }),
      expect.objectContaining({ status: null, error: "Browser probe timed out" }),
    ]);
  });
});
