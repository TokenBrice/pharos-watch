import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetailResponseHelpers } from "../stablecoin-detail/shared";

const { loadStablecoinsCacheMock } = vi.hoisted(() => ({ loadStablecoinsCacheMock: vi.fn() }));
vi.mock("../../lib/stablecoins-cache", () => ({ loadStablecoinsCache: loadStablecoinsCacheMock }));

import { handleCacheBackedDetail } from "../stablecoin-detail/cache-fallback";

const detail: DetailResponseHelpers = {
  cached: null,
  createFreshResponseFromBody: (body) => new Response(body),
  createFreshResponseFromTokens: (tokens) => Response.json({ tokens }),
  resolveTokensWithSupplyHistoryFallback: async (tokens) => tokens,
  staleCacheOrError: (status, message) => new Response(message, { status }),
  trySupplyHistoryFallback: async () => null,
};

describe("cache-backed native supply", () => {
  beforeEach(() => loadStablecoinsCacheMock.mockReset());

  it.each([null, 0, -1, Infinity, Number.MIN_VALUE, 2])(
    "preserves every USD checkpoint and converts only usable price %s",
    async (price) => {
      const day = 1_728_000_000;
      loadStablecoinsCacheMock.mockResolvedValue({
        kind: "ok", updatedAt: day,
        payload: { peggedAssets: [{
          id: "probe", price,
          circulating: { peggedUSD: 100 },
          circulatingPrevDay: { peggedUSD: 80 },
          circulatingPrevWeek: { peggedUSD: 60 },
          circulatingPrevMonth: { peggedUSD: 40 },
        }] },
      });
      const response = await handleCacheBackedDetail(
        { db: {} as D1Database, stablecoinId: "probe", pegType: "peggedUSD" }, detail,
      );
      expect(await response.json()).toEqual({ tokens: [
        [30, 40], [7, 60], [1, 80], [0, 100],
      ].map(([days, usd]) => ({
        date: day - days * 86400,
        totalCirculatingUSD: { peggedUSD: usd },
        totalCirculating: price === 2 ? { peggedUSD: usd / 2 } : {},
      })) });
    },
  );
});
