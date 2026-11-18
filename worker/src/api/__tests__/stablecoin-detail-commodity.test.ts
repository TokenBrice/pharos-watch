import * as perimeters from "@shared/lib/supply-perimeter-changes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { admitCommodityDetailCache, buildNativeSupplyBuckets, buildTokenRowsFromMarketCaps, createDetailResponseHelpers } from "../stablecoin-detail/shared";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { StablecoinDetailResponseSchema } from "@shared/types/supply";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { DETAIL_HISTORY_FALLBACK_REASON } from "@shared/lib/api-freshness";

const fetchWithRetryMock = vi.fn<(
  url: string,
  init?: RequestInit,
  retries?: number,
  options?: Record<string, unknown>
) => Promise<Response | null>>();

const fetchJsonWithRetryMock = vi.fn<(
  url: string,
  init?: RequestInit,
  retries?: number,
  options?: Record<string, unknown>
) => Promise<{ response: Response; body: Record<string, unknown> } | null>>();

vi.mock("../../lib/fetch-retry", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchWithRetry: fetchWithRetryMock,
    fetchJsonWithRetry: fetchJsonWithRetryMock,
    fetchJsonWithSchema: async (
      url: string,
      schema: {
        safeParse: (value: unknown) =>
          | { success: true; data: unknown }
          | { success: false; error: { message: string } };
      },
      init?: RequestInit,
      retries?: number,
      options?: Record<string, unknown>,
    ) => {
      const result = await fetchJsonWithRetryMock(url, init, retries, options);
      if (!result) return null;
      const parsed = schema.safeParse(result.body);
      return parsed.success
        ? { success: true, response: result.response, body: parsed.data }
        : {
            success: false,
            response: result.response,
            failure: { kind: "schema-validation", message: parsed.error.message },
          };
    },
  };
});

const { fetchCommodityTokens, handleCommodityDetail } = await import("../stablecoin-detail/commodity");
const { handleStablecoinDetail } = await import("../stablecoin-detail");
const { handleStablecoinLiveSummary } = await import("../stablecoin-live-summary");
const config = { stablecoinId: "xaut-tether", geckoId: "tether-gold", protocolSlug: "tether-gold", pegType: "peggedGOLD" };
const pending: Promise<unknown>[] = [];
const fixtures = createLatestSchemaFixtureTracker();
afterEach(async () => { await Promise.all(pending.splice(0)); fixtures.closeAll(); vi.restoreAllMocks(); });

describe("native supply conversion", () => {
  it.each([null, 0, Infinity, Number.MIN_VALUE])(
    "omits unavailable native units for price %s without dropping USD history",
    (price) => {
      const timestamp = Date.UTC(2026, 0, 1);
      const prices = typeof price === "number" ? new Map([["2026-01-01", price]]) : new Map<string, number>();
      expect(buildTokenRowsFromMarketCaps([[timestamp, 100]], "peggedUSD", prices)).toEqual([{
        date: timestamp / 1000, totalCirculatingUSD: { peggedUSD: 100 }, totalCirculating: {},
      }]);
    },
  );

  it("preserves measured zero and priced positive native units", () => {
    expect(buildNativeSupplyBuckets("peggedUSD", 0, 2)).toEqual({ peggedUSD: 0 });
    expect(buildNativeSupplyBuckets("peggedUSD", 100, 2)).toEqual({ peggedUSD: 50 });
  });

});

describe("fetchCommodityTokens", () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    fetchJsonWithRetryMock.mockReset().mockImplementation(async (url, init, retries, options) => {
      const response = await fetchWithRetryMock(url, init, retries, options);
      if (!response) return null;
      const cloned = response.clone();
      const body = (await cloned.json()) as Record<string, unknown>;
      return { response, body };
    });
  });

  it("preserves day-specific CoinGecko caps despite substantial current supply growth", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ coins: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tvl: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            market_caps: [[1_700_000_000_000, 100], [1_700_086_400_000, 300]],
            prices: [[1_700_000_000_000, 2], [1_700_086_400_000, 3]],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ market_data: { circulating_supply: 1_000 } }), { status: 200 }),
      );

    const tokens = await fetchCommodityTokens({
      stablecoinId: "xaut-tether",
      geckoId: "tether-gold",
      protocolSlug: "tether-gold",
      pegType: "peggedGOLD",
    });

    expect(tokens).toMatchObject([
      {
        date: 1_700_000_000,
        totalCirculatingUSD: { peggedGOLD: 100 },
        totalCirculating: { peggedGOLD: 50 },
      },
      {
        date: 1_700_086_400,
        totalCirculatingUSD: { peggedGOLD: 300 },
        totalCirculating: { peggedGOLD: 100 },
      },
    ]);
  });

  it("returns an empty array when CoinGecko market chart fails in fallback", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ coins: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tvl: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "bad gateway" }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ market_data: {} }), { status: 200 }));

    const tokens = await fetchCommodityTokens({
      stablecoinId: "xaut-tether",
      geckoId: "tether-gold",
      protocolSlug: "tether-gold",
      pegType: "peggedGOLD",
    });

    expect(tokens).toEqual([]);
  });

  it("merges primary TVL with unsorted as-of prices without CoinGecko fallback", async () => {
    const day = 86_400;
    fetchWithRetryMock
      .mockResolvedValueOnce(Response.json({ coins: { "coingecko:tether-gold": { prices: [
        { timestamp: day + 300, price: 5 }, { timestamp: day + 100, price: 2 }, { timestamp: day + 200, price: 4 },
      ] } } }))
      .mockResolvedValueOnce(Response.json({ tvl: [
        { date: 90, totalLiquidityUSD: 180 }, { date: day + 110, totalLiquidityUSD: 100 }, { date: day + 290, totalLiquidityUSD: 200 },
      ] }));
    expect(await fetchCommodityTokens(config)).toMatchObject([
      { date: 90, totalCirculatingUSD: { peggedGOLD: 180 }, totalCirculating: {} },
      { date: day + 110, totalCirculatingUSD: { peggedGOLD: 100 }, totalCirculating: { peggedGOLD: 50 } },
      { date: day + 290, totalCirculatingUSD: { peggedGOLD: 200 }, totalCirculating: { peggedGOLD: 50 } },
    ]);
    expect(fetchWithRetryMock.mock.calls.map(([url]) => new URL(url).hostname)).toEqual([
      "coins.llama.fi", "api.llama.fi",
    ]);
  });

  it("retains PAXG TVL when the only quotes are from the prior UTC day and later that day", async () => {
    const midnight = Date.UTC(2026, 10, 17) / 1000;
    const date = midnight + 60;
    fetchWithRetryMock
      .mockResolvedValueOnce(Response.json({ coins: { "coingecko:pax-gold": { prices: [
        { timestamp: midnight - 60, price: 2_000 }, { timestamp: midnight + 86_340, price: 3_000 },
      ] } } }))
      .mockResolvedValueOnce(Response.json({ tvl: [{ date, totalLiquidityUSD: 200_000_000 }] }));

    expect(await fetchCommodityTokens({
      ...config, stablecoinId: "paxg-paxos", geckoId: "pax-gold", protocolSlug: "paxos-gold",
    })).toEqual([{ date, totalCirculatingUSD: { peggedGOLD: 200_000_000 }, totalCirculating: {} }]);
  });

  it("uses VNXAU token cap history without calling the issuer-wide protocol", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(Response.json({ market_caps: [[100_000, 100]], prices: [[100_000, 2]] }))
      .mockResolvedValueOnce(Response.json({ market_data: {} }));
    expect(await fetchCommodityTokens({ ...config, stablecoinId: "vnxau-vnx", geckoId: "vnx-gold", protocolSlug: "vnx" }))
      .toMatchObject([{ date: 100, totalCirculatingUSD: { peggedGOLD: 100 } }]);
    expect(fetchWithRetryMock.mock.calls.every(([url]) => !url.includes("/protocol/"))).toBe(true);
  });

  it.each([0, -1, Infinity, null])("preserves TVL without native units for unusable as-of price %s", async (price) => {
    fetchWithRetryMock
      .mockResolvedValueOnce(Response.json({ coins: { "coingecko:tether-gold": { prices:
        price === null ? [] : [{ timestamp: 100, price }, { timestamp: 86_700, price: 5 }],
      } } }))
      .mockResolvedValueOnce(Response.json({ tvl: [{ date: 100, totalLiquidityUSD: 100 }] }));
    expect(await fetchCommodityTokens(config)).toMatchObject([
      { date: 100, totalCirculatingUSD: { peggedGOLD: 100 }, totalCirculating: {} },
    ]);
  });

  it.each([null, 0])("retains D1 USD history when price %s cannot supply native units", async (price) => {
    const detail = createDetailResponseHelpers({
      db: mockD1([
        { match: "FROM supply_history", rows: [{ snapshot_date: 100, circulating_usd: 100, price }] },
        { match: "", rows: [], allowUnused: true },
      ]),
      stablecoinId: config.stablecoinId, pegType: config.pegType, cached: null,
      execCtx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext,
    });
    const response = await detail.trySupplyHistoryFallback("commodity-history-empty");
    expect(await response!.json()).toMatchObject({ tokens: [
      { date: 100, totalCirculatingUSD: { peggedGOLD: 100 }, totalCirculating: {} },
    ] });
  });

  it.each(["supply", "stale", "error"] as const)("serves %s after thrown upstream work", async (mode) => {
    fetchWithRetryMock.mockRejectedValue(new Error("upstream unavailable"));
    const db = mockD1([
      { match: "FROM supply_history", rows: mode === "supply" ? [{ snapshot_date: 100, circulating_usd: 200, circulating_native: 50 }] : [] },
      { match: "", rows: [], allowUnused: true },
    ]);
    const detail = createDetailResponseHelpers({
      db, stablecoinId: config.stablecoinId, pegType: config.pegType,
      cached: mode === "stale" ? { value: JSON.stringify({ commodityHistoryVersion: 2, tokens: [{ date: 50 }] }), updatedAt: 50 } : null,
      execCtx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext,
    });
    const response = await handleCommodityDetail(config, detail);
    expect(response.status).toBe(mode === "error" ? 502 : 200);
    if (mode === "supply") {
      expect(await response.json()).toMatchObject({ tokens: [
        { date: 100, totalCirculatingUSD: { peggedGOLD: 200 }, totalCirculating: {} },
      ] });
    } else if (mode === "stale") {
      expect(await response.json()).toEqual({ commodityHistoryVersion: 2, tokens: [{ date: 50 }] });
      expect(response.headers.get("Warning")).toContain("stale");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    } else {
      expect(await response.json()).toEqual({ error: "Failed to fetch commodity token data" });
    }
  });
});

describe("commodity detail missing upstream history", () => {
  it("serves the retained detail generation instead of an empty 200 when every provider read fails", async () => {
    // DefiLlama chart, DefiLlama protocol and CoinGecko resolve non-OK/empty without
    // throwing, and the coin has no admitted supply_history rows.
    fetchJsonWithRetryMock.mockReset();
    fetchJsonWithRetryMock.mockResolvedValue(null);
    const now = Math.floor(Date.now() / 1000);
    const cachedBody = JSON.stringify({
      commodityHistoryVersion: 2,
      price: 2_501.5,
      tokens: [{
        date: now - 86_400,
        totalCirculatingUSD: { peggedGOLD: 500_000_000 },
        totalCirculating: { peggedGOLD: 200_000 },
      }],
    });
    const db = mockD1([
      { match: "FROM supply_history", rows: [] },
      { match: "", rows: [], allowUnused: true },
    ]);
    const detail = createDetailResponseHelpers({
      db, stablecoinId: config.stablecoinId, pegType: config.pegType,
      cached: { value: cachedBody, updatedAt: now - 3_600 },
      execCtx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext,
    });

    const response = await handleCommodityDetail(config, detail);

    // Missing history must try D1 supply history and the retained detail cache
    // before an unavailable error; it must not publish an empty 200 history.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(cachedBody));
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(now - 3_600));
    expect(response.headers.get("Warning")).toContain("stale");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns an unavailable error instead of an empty 200 when no retained cache exists", async () => {
    fetchJsonWithRetryMock.mockReset();
    fetchJsonWithRetryMock.mockResolvedValue(null);
    const db = mockD1([
      { match: "FROM supply_history", rows: [] },
      { match: "", rows: [], allowUnused: true },
    ]);
    const detail = createDetailResponseHelpers({
      db, stablecoinId: config.stablecoinId, pegType: config.pegType, cached: null,
      execCtx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext,
    });

    const response = await handleCommodityDetail(config, detail);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "Historical detail data unavailable for stablecoin xaut-tether" });
  });
});

it.each([true, false])("keeps XAUT USD history and admits only completed scoped checkpoints (%s)", async (completed) => {
  const { db, sqlite } = fixtures.open();
  const now = Math.floor(Date.now() / 1000);
  const day = 86_400;
  const dates = [now, now - 7 * day, now - 30 * day];
  fetchJsonWithRetryMock.mockImplementation(async (url) => ({ response: new Response(), body: url.includes("/chart/")
    ? { coins: { "coingecko:tether-gold": { prices: dates.map((timestamp) => ({ timestamp, price: 4 })) } } }
    : { tvl: dates.map((date) => ({ date, totalLiquidityUSD: 400 })) } }));
  if (completed) sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .run("snapshot-supply:last-write", JSON.stringify({ snapshotDate: bucketUnixSecondsToUtcDay(now) }), now);
  const insert = sqlite.prepare(`INSERT INTO supply_history
    (stablecoin_id, snapshot_date, circulating_usd, circulating_native, supply_provenance) VALUES (?, ?, ?, ?, ?)`);
  for (const [date, source] of [[dates[1]!, "onchain-circulating-supply"], [dates[2]!, "defillama"]] as const) {
    insert.run(config.stablecoinId, bucketUnixSecondsToUtcDay(date), 300, 75, JSON.stringify({
      supplySource: source, supplyObservedAt: date - 60, supplyChainGuard: null,
    }));
  }
  const detail = createDetailResponseHelpers({ db, stablecoinId: config.stablecoinId, pegType: config.pegType, cached: null,
    execCtx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext });
  const response = await handleCommodityDetail(config, detail);
  const history = await response.json() as Record<string, unknown>;
  const parsed = StablecoinDetailResponseSchema.parse({
    ...history, currentCirculatingUSD: { peggedGOLD: 400 }, currentCirculatingNative: 80, currentSupplyObservedAt: now,
  });
  const weekly = parsed.tokens?.find((token) => token.date === dates[1]);
  expect(weekly).toMatchObject({
    supplySource: "defillama", supplyObservedAt: dates[1], totalCirculatingUSD: { peggedGOLD: 400 },
    ...(completed ? {
      nativeSupplySource: "onchain-circulating-supply", nativeSupplyObservedAt: dates[1]! - 60, totalCirculating: { peggedGOLD: 75 },
    } : {}),
  });
  if (!completed) expect(weekly).not.toHaveProperty("nativeSupplyObservedAt");
  const summary = projectStablecoinLiveSummary(parsed, config.stablecoinId);
  expect(summary).toMatchObject({
    circulatingPrevWeek: { peggedGOLD: 400 }, circulatingPrevMonth: { peggedGOLD: 400 },
    nativeSupply: { current: 80, prevWeek: completed ? 75 : null, prevMonth: null },
  });
});

it.each(["history", "current-only", "empty", "read-failure", "expired"] as const)(
  "serves the public wrapper detail and live summary with %s evidence", async (scenario) => {
    vi.spyOn(perimeters, "isKinesisWrapperSupplyCutoverActive").mockImplementation((id) => id === "kau-kinesis");
    const id = "kau-kinesis";
    const now = Math.floor(Date.now() / 1000);
    const observedAt = now - (scenario === "expired" ? 4 * 86_400 : 12 * 3600);
    const date = bucketUnixSecondsToUtcDay(observedAt);
    const { db, sqlite } = fixtures.open();
    const key = `detail:${id}`;
    const cached = { value: JSON.stringify({ tokens: [{ date, totalCirculatingUSD: { peggedGOLD: 500 } }] }), updatedAt: now };
    const put = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    put.run(key, cached.value, now);
    put.run("snapshot-supply:last-write", JSON.stringify({ snapshotDate: date }), now);
    const insert = sqlite.prepare(`INSERT INTO supply_history
      (stablecoin_id, snapshot_date, circulating_usd, circulating_native, supply_provenance) VALUES (?, ?, ?, ?, ?)`);
    insert.run(id, date - 1, 500, null, null);
    if (scenario === "history" || scenario === "expired") insert.run(id, date, 200, 1, JSON.stringify({
      supplySource: "onchain-total-supply", supplyObservedAt: observedAt, supplyChainGuard: null,
    }));
    if (scenario === "history" || scenario === "current-only") {
      put.run("stablecoins", JSON.stringify({ peggedAssets: [{
        id, name: "Kinesis Gold", symbol: "KAU", pegType: "peggedGOLD", pegMechanism: "commodity-backed",
        price: 220, priceSource: "coingecko", priceObservedAt: now - 60, priceObservedAtMode: "upstream",
        supplySource: "onchain-total-supply", supplyObservedAt: now - 45, circulatingNative: 2,
        circulating: { peggedGOLD: 440 }, chainCirculating: {}, chains: ["Ethereum"],
      }] }), now - 30);
    }
    if (scenario === "read-failure") sqlite.exec("DROP TABLE supply_history");
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
    const response = await handleStablecoinDetail(db, id, ctx);
    const body = await response.json();
    await Promise.all(pending.splice(0));
    const retained = sqlite.prepare("SELECT value, updated_at AS updatedAt FROM cache WHERE key = ?").get(key) as typeof cached;
    expect(admitCommodityDetailCache(id, retained) != null).toBe(scenario === "history");
    const compact = await handleStablecoinLiveSummary(db, id, ctx);
    const compactBody = await compact.json();

    if (scenario === "history") {
      expect(body).toMatchObject({
        tokens: [{ date, totalCirculatingUSD: { peggedGOLD: 200 }, totalCirculating: { peggedGOLD: 1 } }],
        currentSupplyObservedAt: now - 45,
      });
      expect(compactBody).toMatchObject({ supplyObservedAt: now - 45, circulating: { peggedGOLD: 440 } });
      for (const [served, payload] of [[response, body], [compact, compactBody]] as const) {
        expect(served.status).toBe(200);
        expect(served.headers.get("X-Data-Updated-At")).toBe(String(observedAt));
        expect(served.headers.get("X-Data-Freshness-Reason")).toBe(DETAIL_HISTORY_FALLBACK_REASON);
        expect(payload).toMatchObject({ _meta: {
          updatedAt: observedAt, freshBudgetSec: 3 * 86_400, degradedBudgetSec: 3 * 86_400,
        } });
      }
    } else if (scenario === "current-only") {
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ tokens: [], currentCirculatingNative: 2 });
      expect(compact.status).toBe(200);
      expect(compactBody).toMatchObject({ circulating: { peggedGOLD: 440 }, nativeSupply: { current: 2 } });
    } else {
      for (const [served, payload] of [[response, body], [compact, compactBody]] as const) {
        expect(served.status).toBe(503);
        expect(served.headers.get("Cache-Control")).toBe("no-store");
        expect(payload).toMatchObject({ reason: "wrapper-detail-unavailable" });
      }
    }
  },
);

it("serves pre-cutover Kinesis program history when the provider is unavailable", async () => {
  const { db, sqlite } = fixtures.open();
  const now = Math.floor(Date.now() / 1000);
  fetchJsonWithRetryMock.mockResolvedValue(null);
  fetchWithRetryMock.mockResolvedValue(null);
  sqlite.prepare("INSERT INTO supply_history(stablecoin_id,snapshot_date,circulating_usd) VALUES ('kau-kinesis',?,500000000)").run(now);
  const response = await handleStablecoinDetail(db, "kau-kinesis", {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
  } as ExecutionContext);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ tokens: [{ totalCirculatingUSD: { peggedGOLD: 500000000 } }] });
});
