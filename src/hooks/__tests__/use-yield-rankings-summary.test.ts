// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";
import { makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import { makeDeliveryOnlyYieldResponse } from "@/components/__tests__/yield-detail.test-support";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { useYieldRankings, useYieldRankingsSummary } from "../api-hooks";
import { useLiveYieldRankings } from "../use-yield-source-clock";

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
    vi.useRealTimers();
  });

  it("withdraws delivery-only scores from both cached live queries at the batch deadline", () => {
    vi.useFakeTimers({ now: 1_776_000_000_000 });
    const peer = makeYieldRanking({ id: "usdt-tether", liveRank: 2, rankChangeAttribution: {
      previousRank: 3, rankDelta: 1, previousPys: 48, pysDelta: 2, primaryDriver: "apy", driverContributions: {},
    } });
    const data = makeDeliveryOnlyYieldResponse([peer]);
    const queryClient = new QueryClient();
    const { yieldRankings, yieldRankingsSummary } = FRONTEND_API_QUERY_DESCRIPTORS;
    queryClient.setQueryData(yieldRankings.queryKey, { data, meta: null });
    queryClient.setQueryData(yieldRankingsSummary.queryKey, { data: projectYieldRankingsSummary(data), meta: null });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => [
      useLiveYieldRankings(useYieldRankings()), useLiveYieldRankings(useYieldRankingsSummary()),
    ] as const, { wrapper });

    act(() => vi.advanceTimersByTime(50));
    act(() => vi.advanceTimersByTime(1949));
    for (const query of result.current) expect(query.data?.rankings[0]?.pharosYieldScore).toBe(64);
    expect(result.current[0].data?.rankings[1]?.rankChangeAttribution?.rankDelta).toBe(1);
    expect(result.current[1].data?.rankings[1]?.rankDelta).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    for (const query of result.current) {
      expect(query.data?.rankings).toMatchObject([
        { id: peer.id, pharosYieldScore: 50 },
        { id: "usdc-circle", pharosYieldScore: null, pysNullReason: "source-stale" },
      ]);
    }
    expect(result.current[0].data?.rankings[0]).toMatchObject({ liveRank: 1, rankChangeAttribution: undefined });
    expect(result.current[0].data?.rankings[1]?.provenance).toMatchObject({
      sourceAgeSeconds: null, scoreQualification: "NR", scoreQualified: false,
    });
    expect(result.current[1].data?.rankings[0]?.rankDelta).toBeUndefined();
    expect(queryClient.getQueryData(yieldRankings.queryKey)).toMatchObject({ data });
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
    const { result } = renderHook(() => useLiveYieldRankings(useYieldRankingsSummary()), { wrapper });

    await waitFor(() => expect(result.current.data?.rankings[0]?.id).toBe("usdc-circle"));

    // A second fetch hangs; the served rankings must stay visible meanwhile.
    act(() => {
      void result.current.refetch();
    });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data?.rankings[0]?.id).toBe("usdc-circle");

    act(() => {
      releaseSecondFetch?.(summaryPayload("usdt-tether"));
    });
    await waitFor(() => expect(result.current.data?.rankings[0]?.id).toBe("usdt-tether"));
    expect(result.current.isFetching).toBe(false);
  });
});
