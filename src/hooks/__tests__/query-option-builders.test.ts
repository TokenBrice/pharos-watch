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

import { dexLiquidityHistoryQueryOptions } from "../api-hooks";
import { depegEventsInfiniteQueryOptions } from "../use-depeg-events";
import { supplyHistoryQueryOptions } from "../use-stablecoins";
import { mintBurnFlowsCoinQueryOptions } from "../use-mint-burn-flows";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";

function queryContext<TQueryKey extends readonly unknown[]>(
  queryKey: TQueryKey,
  signal = new AbortController().signal,
) {
  return { client: new QueryClient(), signal, queryKey, meta: undefined };
}

describe("query option builders", () => {
  it("keeps low-risk API hook descriptors in the frontend registry", () => {
    expect(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9).toMatchObject({
      queryKey: ["report-cards", "v9"],
      path: "/api/report-cards/v9",
      producerIntervalMs: 30 * 60 * 1000,
      metaMaxAgeSec: 3600,
    });
    expect(FRONTEND_API_QUERY_DESCRIPTORS.safetyScoreHistory("usdc-circle", 3650)).toMatchObject({
      queryKey: ["safety-score-history", "usdc-circle", 3650],
      path: "/api/safety-score-history?stablecoin=usdc-circle&days=3650",
      producerIntervalMs: 24 * 60 * 60 * 1000,
      metaMaxAgeSec: 24 * 60 * 60,
    });
    expect(FRONTEND_API_QUERY_DESCRIPTORS.safetyScoreHistoryV2("usdc-circle", 3650)).toMatchObject({
      queryKey: ["safety-score-history-v2", "usdc-circle", 3650],
      path: "/api/safety-score-history-v2?stablecoin=usdc-circle&days=3650",
      producerIntervalMs: 24 * 60 * 60 * 1000,
      metaMaxAgeSec: 24 * 60 * 60,
    });
  });

  it("builds canonical supply-history options", async () => {
    const options = supplyHistoryQueryOptions("usdc-circle");

    expect(options.queryKey).toEqual(["supply-history", "usdc-circle", 1825]);
    expect(options.staleTime).toBe(24 * 60 * 60 * 1000);
    expect(options.refetchInterval).toBe(2 * 24 * 60 * 60 * 1000);
    expect(options.enabled).toBe(true);

    if (typeof options.queryFn !== "function") throw new Error("Expected a supply-history query function");
    await options.queryFn(queryContext(options.queryKey));
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/supply-history?stablecoin=usdc-circle&days=1825",
      expect.objectContaining({ safeParse: expect.any(Function) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      undefined,
    );
  });

  it("builds extended supply-history options when a chart requests long-range overlays", async () => {
    const options = supplyHistoryQueryOptions("usdc-circle", 5000);

    expect(options.queryKey).toEqual(["supply-history", "usdc-circle", 5000]);

    if (typeof options.queryFn !== "function") throw new Error("Expected a supply-history query function");
    await options.queryFn(queryContext(options.queryKey));
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/supply-history?stablecoin=usdc-circle&days=5000",
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
      3600,
      undefined,
    );
  });

  it("keeps dex history prefetch builders aligned with their consuming hooks", () => {
    const dexOptions = dexLiquidityHistoryQueryOptions("usdc-circle", 90);

    expect(dexOptions.queryKey).toEqual(["dex-liquidity-history", "usdc-circle", 90]);
    // Same producer as the `dexLiquidity` sibling: `sync-dex-liquidity`, 2h.
    expect(dexOptions.staleTime).toBe(2 * 60 * 60 * 1000);
    expect(dexOptions.refetchInterval).toBe(4 * 60 * 60 * 1000);
  });

  it("passes TanStack Query cancellation signals to API fetches", async () => {
    const options = supplyHistoryQueryOptions("usdc-circle");
    const controller = new AbortController();

    if (typeof options.queryFn !== "function") throw new Error("Expected a supply-history query function");
    await options.queryFn(queryContext(options.queryKey, controller.signal));

    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/supply-history?stablecoin=usdc-circle&days=1825",
      expect.objectContaining({ safeParse: expect.any(Function) }),
      { signal: controller.signal },
      undefined,
    );
  });

  it("passes TanStack Query cancellation signals to infinite API fetches", async () => {
    const options = depegEventsInfiniteQueryOptions("usdc-circle");
    const controller = new AbortController();

    if (typeof options.queryFn !== "function") throw new Error("Expected a depeg-events query function");
    await options.queryFn({
      ...queryContext(options.queryKey, controller.signal),
      pageParam: null,
      direction: "forward",
    });

    expect(apiFetchWithMetaMock).toHaveBeenLastCalledWith(
      "/api/depeg-events?stablecoin=usdc-circle&limit=100&includeTotal=false",
      expect.anything(),
      { signal: controller.signal },
    );
  });
});
