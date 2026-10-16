import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

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
      expect.objectContaining({ safeParse: expect.any(Function) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      undefined,
    );
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
      expect.objectContaining({ safeParse: expect.any(Function) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      undefined,
    );
  });

});
