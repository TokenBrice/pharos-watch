import { describe, expect, it, vi } from "vitest";

const { apiFetchMock, apiFetchWithMetaMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(async () => []),
  apiFetchWithMetaMock: vi.fn(async () => ({ data: {}, meta: null })),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: apiFetchMock,
  apiFetchWithMeta: apiFetchWithMetaMock,
}));

import { dexLiquidityHistoryQueryOptions, safetyScoreHistoryQueryOptions } from "../api-hooks";
import { depegEventsInfiniteQueryOptions } from "../use-depeg-events";
import { supplyHistoryQueryOptions } from "../use-stablecoins";
import { mintBurnFlowsCoinQueryOptions } from "../use-mint-burn-flows";

describe("query option builders", () => {
  it("builds canonical supply-history options", async () => {
    const options = supplyHistoryQueryOptions("usdc-circle");

    expect(options.queryKey).toEqual(["supply-history", "usdc-circle", 1825]);
    expect(options.staleTime).toBe(60 * 60 * 1000);
    expect(options.refetchInterval).toBe(2 * 60 * 60 * 1000);
    expect(options.enabled).toBe(true);

    await options.queryFn?.();
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/supply-history?stablecoin=usdc-circle&days=1825",
      expect.anything(),
      undefined,
      undefined,
    );
  });

  it("builds canonical mint/burn per-coin options", async () => {
    const options = mintBurnFlowsCoinQueryOptions("usdc-circle", 168);

    expect(options.queryKey).toEqual(["mint-burn-flows", "usdc-circle", 168]);
    expect(options.staleTime).toBe(30 * 60 * 1000);
    expect(options.refetchInterval).toBe(60 * 60 * 1000);
    expect(options.enabled).toBe(true);

    await options.queryFn?.();
    expect(apiFetchWithMetaMock).toHaveBeenCalledWith(
      "/api/mint-burn-flows?stablecoin=usdc-circle&hours=168",
      expect.anything(),
      undefined,
      3600,
      undefined,
    );
  });

  it("keeps history prefetch builders aligned with their consuming hooks", async () => {
    const dexOptions = dexLiquidityHistoryQueryOptions("usdc-circle", 90);
    const safetyOptions = safetyScoreHistoryQueryOptions("usdc-circle", 3650);

    expect(dexOptions.queryKey).toEqual(["dex-liquidity-history", "usdc-circle", 90]);
    expect(dexOptions.staleTime).toBe(60 * 60 * 1000);
    expect(dexOptions.refetchInterval).toBe(2 * 60 * 60 * 1000);

    expect(safetyOptions.queryKey).toEqual(["safety-score-history", "usdc-circle", 3650]);
    expect(safetyOptions.staleTime).toBe(24 * 60 * 60 * 1000);
    expect(safetyOptions.refetchInterval).toBe(2 * 24 * 60 * 60 * 1000);
    expect(safetyOptions.enabled).toBe(true);
  });

  it("passes TanStack Query cancellation signals to API fetches", async () => {
    const options = supplyHistoryQueryOptions("usdc-circle");
    const controller = new AbortController();

    await options.queryFn?.({
      signal: controller.signal,
      queryKey: options.queryKey,
      meta: undefined,
    } as never);

    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/supply-history?stablecoin=usdc-circle&days=1825",
      expect.anything(),
      { signal: controller.signal },
      undefined,
    );
  });

  it("passes TanStack Query cancellation signals to infinite API fetches", async () => {
    const options = depegEventsInfiniteQueryOptions("usdc-circle");
    const controller = new AbortController();

    await options.queryFn?.({
      signal: controller.signal,
      queryKey: options.queryKey,
      meta: undefined,
      pageParam: 0,
      direction: "forward",
      client: null,
    } as never);

    expect(apiFetchWithMetaMock).toHaveBeenLastCalledWith(
      "/api/depeg-events?stablecoin=usdc-circle&limit=100&offset=0",
      expect.anything(),
      { signal: controller.signal },
    );
  });
});
