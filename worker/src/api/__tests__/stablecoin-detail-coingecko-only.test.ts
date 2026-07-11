import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetailResponseHelpers } from "../stablecoin-detail/shared";

const {
  fetchWithRetryMock,
  recordOutcomeSafeMock,
  shouldAttemptFetchMock,
} = vi.hoisted(() => ({
  fetchWithRetryMock: vi.fn(),
  recordOutcomeSafeMock: vi.fn(),
  shouldAttemptFetchMock: vi.fn(),
}));

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: fetchWithRetryMock,
  fetchJsonWithRetry: async (...args: unknown[]) => {
    const response = await fetchWithRetryMock(...args) as Response | null;
    return response
      ? { response, body: response.ok ? await response.json() : {} }
      : null;
  },
}));

vi.mock("../../lib/circuit-breaker", () => ({
  recordOutcomeSafe: recordOutcomeSafeMock,
  shouldAttemptFetch: shouldAttemptFetchMock,
}));

import { CIRCUIT_SOURCE } from "../../lib/constants";
import { handleCoinGeckoOnlyDetail } from "../stablecoin-detail/coingecko-only";

function makeDetailHelpers(
  resolveTokensWithSupplyHistoryFallback: DetailResponseHelpers["resolveTokensWithSupplyHistoryFallback"],
): DetailResponseHelpers {
  return {
    cached: null,
    createFreshResponseFromBody: (body) => new Response(body),
    createFreshResponseFromTokens: (tokens) => Response.json({ tokens }),
    resolveTokensWithSupplyHistoryFallback,
    staleCacheOrError: (status, message) => new Response(message, { status }),
    trySupplyHistoryFallback: vi.fn(async () => null),
  };
}

describe("handleCoinGeckoOnlyDetail", () => {
  const db = {} as D1Database;

  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    recordOutcomeSafeMock.mockReset();
    shouldAttemptFetchMock.mockReset();
    shouldAttemptFetchMock.mockResolvedValue(true);
  });

  it("keeps the source breaker healthy when CoinGecko responds with stale per-asset history", async () => {
    const oldTimestampMs = Date.UTC(2024, 0, 1);
    fetchWithRetryMock.mockResolvedValue(Response.json({
      market_caps: [[oldTimestampMs, 100]],
      prices: [[oldTimestampMs, 1]],
    }));
    const detail = makeDetailHelpers(async (tokens) => tokens);

    const response = await handleCoinGeckoOnlyDetail(
      {
        db,
        stablecoinId: "susds-sky",
        geckoId: "susds",
        pegType: "peggedUSD",
        coingeckoApiKey: "cg-key",
      },
      detail,
    );

    expect(response.status).toBe(200);
    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS, true);
  });

  it("records a breaker failure for non-OK CoinGecko transport responses", async () => {
    fetchWithRetryMock.mockResolvedValue(new Response("upstream failed", { status: 503 }));
    const detail = makeDetailHelpers(async () => [{
      date: 1_778_600_000,
      totalCirculatingUSD: { peggedUSD: 100 },
      totalCirculating: { peggedUSD: 100 },
    }]);

    const response = await handleCoinGeckoOnlyDetail(
      {
        db,
        stablecoinId: "susds-sky",
        geckoId: "susds",
        pegType: "peggedUSD",
        coingeckoApiKey: "cg-key",
      },
      detail,
    );

    expect(response.status).toBe(200);
    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.CG_DETAIL_PLATFORMS, false);
  });
});
