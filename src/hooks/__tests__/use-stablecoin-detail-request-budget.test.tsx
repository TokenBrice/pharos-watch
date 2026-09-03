// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { useStablecoinDetailViewModel } from "../use-stablecoin-detail-view-model";

describe("stablecoin detail request budget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts at three eager requests and arms a below-fold lane on viewport entry", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      requests.push(String(input));
      return new Promise<Response>(() => {});
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const { rerender } = renderHook(
      ({ yieldNear }) => useStablecoinDetailViewModel({
        id: coin.id,
        coin,
        summary: null,
        supplementalQueryControls: {
          liquidity: false,
          reportCards: false,
          redemption: false,
          yield: yieldNear,
          stress: false,
          flows: false,
          blacklist: false,
          reserves: false,
        },
      }),
      { initialProps: { yieldNear: false }, wrapper },
    );

    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests).toEqual(expect.arrayContaining([
      expect.stringContaining("/api/stablecoins"),
      expect.stringContaining("/api/peg-summary"),
      expect.stringContaining("/api/supply-history?stablecoin=usdt-tether"),
    ]));

    rerender({ yieldNear: true });

    await waitFor(() => expect(requests).toHaveLength(4));
    expect(requests[3]).toContain("/api/yield-rankings");
    queryClient.clear();
  });
});
