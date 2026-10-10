import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createDetailResponseHelpers, getLatestDetailTokenDate, type DetailResponseHelpers } from "../stablecoin-detail/shared";

const { loadStablecoinsCacheMock } = vi.hoisted(() => ({ loadStablecoinsCacheMock: vi.fn() }));
vi.mock("../../lib/stablecoins-cache", () => ({ loadStablecoinsCache: loadStablecoinsCacheMock }));

import { handleCacheBackedDetail } from "../stablecoin-detail/cache-fallback";

const detail: DetailResponseHelpers = {
  cached: null,
  createFreshResponseFromBody: (body) => new Response(body),
  createFreshResponseFromTokens: (tokens) => Response.json({ tokens }),
  createFallbackResponseFromTokens: (tokens) => Response.json({ tokens }),
  createResponseFromResolvedTokens: (history) => Response.json({ tokens: history.tokens }),
  resolveTokensWithSupplyHistoryFallback: async (tokens) => ({ tokens, observedAt: getLatestDetailTokenDate(tokens), fallback: false }),
  staleCacheOrError: (status, message) => new Response(message, { status }),
  trySupplyHistoryFallback: async () => null,
};

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });
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

  it.each([1, 40])("preserves the %s-day-old fallback source clock without renewing detail cache", async (days) => {
    const now = 1_800_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    const { db, sqlite } = fixtures.open();
    const observedAt = now - days * 86400;
    sqlite.prepare("INSERT INTO supply_history(stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)")
      .run("probe", observedAt, 100, 1);
    sqlite.prepare("INSERT INTO cache(key, value, updated_at) VALUES (?, ?, ?)")
      .run("detail:probe", '{"tokens":[]}', observedAt - 10);
    const waitUntil = vi.fn();
    const helpers = createDetailResponseHelpers({
      db, stablecoinId: "probe", pegType: "peggedUSD", cached: null,
      execCtx: { waitUntil } as unknown as ExecutionContext,
    });
    const response = await handleCacheBackedDetail({ db, stablecoinId: "probe", pegType: "peggedUSD" }, helpers);
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(observedAt));
    expect(response.headers.get("X-Data-Age")).toBe(String(days * 86400));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Warning")).toMatch(/^110 /);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = 'detail:probe'").get()).toEqual({ updated_at: observedAt - 10 });
    expect(await response.json()).toMatchObject({ _meta: { updatedAt: observedAt, status: "stale", reason: "detail-history-fallback" } });
  });

  it("keeps stale external history stale when no supply-history rescue exists", async () => {
    const now = 1_800_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    const { db } = fixtures.open();
    const waitUntil = vi.fn();
    const helpers = createDetailResponseHelpers({
      db, stablecoinId: "probe", pegType: "peggedUSD", cached: null,
      execCtx: { waitUntil } as unknown as ExecutionContext,
    });
    const observedAt = now - 40 * 86400;
    const resolved = await helpers.resolveTokensWithSupplyHistoryFallback([{ date: observedAt }], { emptyReason: "empty", staleReason: "stale" });
    expect(resolved).toMatchObject({ observedAt, fallback: true });
    const response = helpers.createResponseFromResolvedTokens(resolved);
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(observedAt));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
