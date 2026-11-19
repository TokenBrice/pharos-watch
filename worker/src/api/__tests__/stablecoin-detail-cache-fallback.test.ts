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
  serveWrapperHistory: async () => Response.json({ tokens: [] }),
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

  it.each([false, true])("retains a measured current zero with an earlier positive=%s", async (earlierPositive) => {
    const day = 1_728_000_000;
    loadStablecoinsCacheMock.mockResolvedValue({
      kind: "ok", updatedAt: day,
      payload: { peggedAssets: [{
        id: "probe", price: 2,
        circulating: { peggedUSD: 0 },
        circulatingPrevDay: earlierPositive ? { peggedUSD: 100 } : undefined,
        circulatingPrevWeek: { peggedUSD: NaN },
      }] },
    });
    const { db, sqlite } = fixtures.open();
    const waitUntil = vi.fn();
    const helpers = createDetailResponseHelpers({
      db, stablecoinId: "probe", pegType: "peggedUSD", cached: null,
      execCtx: { waitUntil } as unknown as ExecutionContext,
    });
    const response = await handleCacheBackedDetail({ db, stablecoinId: "probe", pegType: "peggedUSD" }, helpers);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(day));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ tokens: [
      ...(earlierPositive ? [{ date: day - 86400, totalCirculatingUSD: { peggedUSD: 100 }, totalCirculating: { peggedUSD: 50 } }] : []),
      { date: day, totalCirculatingUSD: { peggedUSD: 0 }, totalCirculating: { peggedUSD: 0 } },
    ], _meta: { updatedAt: day, status: "stale", reason: "detail-history-fallback" } });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'detail:probe'").get()).toBeUndefined();
  });

  it("preserves the weekly native count at its dated EUR valuation and skips rejected windows", async () => {
    const day = 1_728_000_000;
    loadStablecoinsCacheMock.mockResolvedValue({ kind: "ok", updatedAt: day, payload: { peggedAssets: [{
      id: "eurc-circle", price: 1.1, circulatingNative: 100, circulating: { peggedEUR: 110 },
      circulatingPrevDay: { peggedEUR: 110 }, circulatingPrevMonth: { peggedEUR: 110 },
      circulatingPrevWeek: { peggedEUR: 110 }, supplyChangeBaselines: { day: null, month: null, week: {
        observedAt: day - 7 * 86_400 + 100, circulatingUsd: 100, circulatingNative: 100,
      } },
    }] } });
    const response = await handleCacheBackedDetail(
      { db: fixtures.open().db, stablecoinId: "eurc-circle", pegType: "peggedEUR" }, detail,
    );
    expect(await response.json()).toEqual({ tokens: [
      { date: day - 7 * 86_400, totalCirculatingUSD: { peggedEUR: 100 }, totalCirculating: { peggedEUR: 100 } },
      { date: day, totalCirculatingUSD: { peggedEUR: 110 }, totalCirculating: { peggedEUR: 100 } },
    ] });
  });

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

  it("restores pre-0306 USD native history only from the checkpoint's own complete stock and price evidence", async () => {
    const { db, sqlite } = fixtures.open();
    const today = Math.floor(Date.now() / 86_400_000) * 86_400;
    const insert = sqlite.prepare(`INSERT INTO supply_history
      (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at, supply_provenance) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [index, skew] of [0, 1, null].entries()) {
      const day = today - (3 - index) * 86_400;
      const clock = day + 600;
      insert.run("usdc-circle", day, 980, 0.98, skew == null ? null : clock + skew,
        JSON.stringify({ supplySource: "coingecko-fallback", supplyObservedAt: clock, supplyChainGuard: null }));
    }
    const helpers = createDetailResponseHelpers({
      db, stablecoinId: "usdc-circle", pegType: "peggedUSD", cached: null,
      execCtx: { waitUntil: vi.fn() } as unknown as ExecutionContext,
    });
    const response = await helpers.trySupplyHistoryFallback("test");
    const { tokens } = await response!.json() as { tokens: { totalCirculating: Record<string, number> }[] };
    expect(tokens.map(token => token.totalCirculating)).toEqual([{ peggedUSD: 1000 }, {}, {}]);
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
