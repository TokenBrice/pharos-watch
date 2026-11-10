import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { resolveSchemaLike } from "@shared/lib/schema-like";

const { useQueryMock, apiFetchMock, apiFetchWithMetaMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
  apiFetchMock: vi.fn(async () => []),
  apiFetchWithMetaMock: vi.fn(async () => ({ data: {}, meta: null })),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: useQueryMock,
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: apiFetchMock,
  apiFetchWithMeta: apiFetchWithMetaMock,
}));

import { useHealth, useStabilityIndex, useTelegramPulse } from "../api-hooks";
import { usePublicEndpointProbes } from "../use-endpoint-probes";
import { supplyHistoryQueryOptions } from "../use-stablecoins";
import { mintBurnFlowsCoinQueryOptions } from "../use-mint-burn-flows";

function queryContext(queryKey: readonly unknown[]) {
  return { signal: new AbortController().signal, queryKey, meta: undefined } as never;
}

function builderQueryContext<TQueryKey extends readonly unknown[]>(
  queryKey: TQueryKey,
  signal = new AbortController().signal,
) {
  return { client: new QueryClient(), signal, queryKey, meta: undefined };
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

describe("query option builders", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async () => []);
    apiFetchWithMetaMock.mockReset();
    apiFetchWithMetaMock.mockImplementation(async () => ({ data: {}, meta: null }));
  });

  it("builds canonical supply-history options", async () => {
    const options = supplyHistoryQueryOptions("usdc-circle");

    expect(options.queryKey).toEqual(["supply-history", "usdc-circle", 1825]);
    expect(options.staleTime).toBe(24 * 60 * 60 * 1000);
    expect(options.refetchInterval).toBe(2 * 24 * 60 * 60 * 1000);
    expect(options.enabled).toBe(true);

    if (typeof options.queryFn !== "function") throw new Error("Expected a supply-history query function");
    await options.queryFn(builderQueryContext(options.queryKey));
    expect(apiFetchWithMetaMock).toHaveBeenCalledWith(
      "/api/supply-history?stablecoin=usdc-circle&days=1825",
      FRONTEND_API_QUERY_DESCRIPTORS.supplyHistory("usdc-circle").schema,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      undefined,
      { bootstrapQueryKey: options.queryKey },
    );
    expect(await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.supplyHistory("usdc-circle").schema))
      .toEqual(expect.objectContaining({ safeParse: expect.any(Function) }));
  });

  it("builds canonical mint/burn per-coin options", async () => {
    const options = mintBurnFlowsCoinQueryOptions("usdc-circle", 168);

    expect(options.queryKey).toEqual(["mint-burn-flows", "usdc-circle", 168]);
    expect(options.staleTime).toBe(30 * 60 * 1000);
    expect(options.refetchInterval).toBe(60 * 60 * 1000);
    expect(options.enabled).toBe(true);

    if (typeof options.queryFn !== "function") throw new Error("Expected a mint/burn query function");
    await options.queryFn(builderQueryContext(options.queryKey));
    expect(apiFetchWithMetaMock).toHaveBeenCalledWith(
      "/api/mint-burn-flows?stablecoin=usdc-circle&hours=168",
      FRONTEND_API_QUERY_DESCRIPTORS.mintBurnFlowsCoin("usdc-circle", 168).schema,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      undefined,
      { bootstrapQueryKey: options.queryKey },
    );
    expect(await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.mintBurnFlowsCoin("usdc-circle", 168).schema))
      .toEqual(expect.objectContaining({ safeParse: expect.any(Function) }));
  });
});
