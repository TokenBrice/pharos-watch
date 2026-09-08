// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";
import { makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import { useYieldRankingsSummary } from "../api-hooks";

function summaryPayload(topId: string): YieldRankingsSummaryResponse {
  return projectYieldRankingsSummary({
    rankings: [
      makeYieldRanking({
        id: topId,
        symbol: topId === "usdc-circle" ? "USDC" : "USDT",
        name: topId === "usdc-circle" ? "USD Coin" : "Tether USD",
      }),
    ],
    riskFreeRate: 4.25,
    scalingFactor: 1,
    medianApy: 5,
    updatedAt: 1_776_000_000,
    warnings: [],
  });
}

describe("useYieldRankingsSummary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the previous rankings visible until a pending refetch replaces them", async () => {
    let fetchCount = 0;
    let releaseSecondFetch: ((payload: YieldRankingsSummaryResponse) => void) | null = null;
    mockFetch([
      {
        match: "/api/yield-rankings?projection=summary",
        respond: () => {
          fetchCount += 1;
          if (fetchCount === 1) return { body: summaryPayload("usdc-circle") };
          return new Promise<{ body: YieldRankingsSummaryResponse }>((resolve) => {
            releaseSecondFetch = (payload) => resolve({ body: payload });
          });
        },
      },
    ], { requireMatch: true });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useYieldRankingsSummary(), { wrapper });

    await waitFor(() => expect(result.current.data?.rankings[0]?.id).toBe("usdc-circle"));

    // A second fetch hangs; the served rankings must stay visible meanwhile.
    act(() => {
      void result.current.refetch();
    });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data?.rankings[0]?.id).toBe("usdc-circle");

    // Completing the fetch replaces the retained rankings.
    act(() => {
      releaseSecondFetch?.(summaryPayload("usdt-tether"));
    });
    await waitFor(() => expect(result.current.data?.rankings[0]?.id).toBe("usdt-tether"));
    expect(result.current.isFetching).toBe(false);
  });
});
