import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { resolveSchemaLike } from "@shared/lib/schema-like";

const { apiFetchMock, apiFetchWithMetaMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(async () => []),
  apiFetchWithMetaMock: vi.fn(async () => ({ data: {}, meta: null })),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: apiFetchMock,
  apiFetchWithMeta: apiFetchWithMetaMock,
}));

import { supplyHistoryQueryOptions } from "../use-stablecoins";
import { mintBurnFlowsCoinQueryOptions } from "../use-mint-burn-flows";

function queryContext<TQueryKey extends readonly unknown[]>(
  queryKey: TQueryKey,
  signal = new AbortController().signal,
) {
  return { client: new QueryClient(), signal, queryKey, meta: undefined };
}

describe("query option builders", () => {

  it("builds canonical supply-history options", async () => {
    const options = supplyHistoryQueryOptions("usdc-circle");

    expect(options.queryKey).toEqual(["supply-history", "usdc-circle", 1825]);
    expect(options.staleTime).toBe(24 * 60 * 60 * 1000);
    expect(options.refetchInterval).toBe(2 * 24 * 60 * 60 * 1000);
    expect(options.enabled).toBe(true);

    if (typeof options.queryFn !== "function") throw new Error("Expected a supply-history query function");
    await options.queryFn(queryContext(options.queryKey));
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
    await options.queryFn(queryContext(options.queryKey));
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
