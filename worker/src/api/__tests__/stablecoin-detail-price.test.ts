import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { enrichMissingDetailPrice } from "../stablecoin-detail/price";
import { handleStablecoinDetail, resetStablecoinDetailStateForTests } from "../stablecoin-detail";
import { routeStablecoinDetail } from "../stablecoin-detail/router";
import { publishDetailCacheGeneration } from "../../lib/detail-cache-generation";

vi.mock("../stablecoin-detail/router", () => ({ routeStablecoinDetail: vi.fn() }));
vi.mock("../../lib/detail-cache-generation", () => ({
  claimDetailCacheGeneration: vi.fn().mockResolvedValue({ generation: 1 }),
  publishDetailCacheGeneration: vi.fn().mockResolvedValue({ written: true }),
}));

const NOW = 1_800_000_000;
const tokens = [{
  date: NOW - 86_400,
  totalCirculatingUSD: { peggedUSD: 123.456 },
  totalCirculating: { peggedUSD: 121.001 },
  circulating: { peggedUSD: 120.5 },
}];
const detailBody = JSON.stringify({ tokens, providerField: "preserved" });

function canonicalCoin(overrides: Record<string, unknown> = {}) {
  return {
    id: "usdt-tether", name: "Tether", symbol: "USDT", pegType: "peggedUSD", pegMechanism: "fiat-backed",
    price: 0.997, priceSource: "coingecko+defillama-list", priceConfidence: "high",
    priceUpdatedAt: NOW - 70, priceObservedAt: NOW - 90, priceObservedAtMode: "upstream",
    priceSyncedAt: NOW - 60, consensusSources: ["coingecko", "defillama-list"], agreeSources: ["coingecko"],
    circulating: { peggedUSD: 999_999 }, chainCirculating: {}, chains: ["Ethereum"],
    ...overrides,
  };
}

function makeDb(overrides: Record<string, unknown> = {}, updatedAt = NOW - 60, detailAge?: number) {
  return mockD1([
    { match: "cache", matchBinds: ["stablecoins"], rows: [], first: {
      value: JSON.stringify({ peggedAssets: [canonicalCoin(overrides)] }), updated_at: updatedAt,
    } },
    { match: "cache", rows: [], first: detailAge == null ? null : { value: detailBody, updated_at: NOW - detailAge } },
  ]);
}

function makeResponse(body = detailBody) {
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, s-maxage=300, max-age=10" } });
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  resetStablecoinDetailStateForTests();
  vi.mocked(routeStablecoinDetail).mockReset();
  vi.mocked(publishDetailCacheGeneration).mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("missing detail price enrichment", () => {
  it.each([undefined, null, 0, -1, "1"])("fills absent/invalid price %s without changing history or supply", async (price) => {
    const response = makeResponse(JSON.stringify({ tokens, price }));
    const result = await enrichMissingDetailPrice(makeDb(), "usdt-tether", response);
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe(response.headers.get("Cache-Control"));
    expect(await result.json()).toEqual({
      tokens,
      price: 0.997,
      priceSource: "coingecko+defillama-list", priceConfidence: "high",
      priceUpdatedAt: NOW - 70, priceObservedAt: NOW - 90, priceObservedAtMode: "upstream",
      priceSyncedAt: NOW - 60, consensusSources: ["coingecko", "defillama-list"], agreeSources: ["coingecko"],
    });
  });

  it("preserves a valid provider price and skips the canonical read", async () => {
    const db = mockD1([]);
    const response = makeResponse(JSON.stringify({ tokens, price: 0.98 }));
    expect(await enrichMissingDetailPrice(db, "usdt-tether", response)).toBe(response);
    expect(db.getHistory()).toEqual([]);
    expect(response.bodyUsed).toBe(false);
  });

  it.each([
    { price: null }, { price: 0 }, { price: -1 }, { price: "1" },
    { priceConfidence: "low" }, { priceConfidence: "fallback" }, { priceConfidence: null },
    { priceSource: "cached" }, { priceSource: "" },
    { priceObservedAt: NOW + 1 },
    { priceObservedAt: null, priceUpdatedAt: null }, { frozen: true }, { id: "usdc-circle" },
  ])("leaves the original response unchanged for unusable canonical data %j", async (overrides) => {
    const response = makeResponse();
    expect(await enrichMissingDetailPrice(makeDb(overrides), "usdt-tether", response)).toBe(response);
    expect(await response.text()).toBe(detailBody);
  });

  it.each([NOW + 1, Number.NaN])("rejects future/invalid publication %s", async (updatedAt) => {
    const response = makeResponse();
    expect(await enrichMissingDetailPrice(makeDb({}, updatedAt), "usdt-tether", response)).toBe(response);
  });

  it("accepts a fresh single-source quote and preserves the legacy observation timestamp fallback", async () => {
    const result = await enrichMissingDetailPrice(makeDb({ priceConfidence: "single-source", priceObservedAt: null }), "usdt-tether", makeResponse());
    expect(await result.json()).toMatchObject({ price: 0.997, priceConfidence: "single-source", priceObservedAt: NOW - 70 });
  });

  it.each([null, "{bad-json", JSON.stringify({ peggedAssets: [] })])("fails closed for missing/corrupt/empty cache %s", async (value) => {
    const db = mockD1([{ match: "cache", rows: [], first: value == null ? null : { value, updated_at: NOW } }]);
    const response = makeResponse();
    expect(await enrichMissingDetailPrice(db, "usdt-tether", response)).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });

  it("keeps a successful historical response when the canonical read fails", async () => {
    const db = mockD1([{ match: "cache", rows: [], throwError: new Error("unavailable") }]);
    const response = makeResponse();
    expect(await enrichMissingDetailPrice(db, "usdt-tether", response)).toBe(response);
    expect(await response.text()).toBe(detailBody);
  });

  it("also bounds TTL by canonical publication freshness", async () => {
    const result = await enrichMissingDetailPrice(makeDb({}, NOW - API_FRESHNESS_MAX_AGE_SEC.stablecoins + 4), "usdt-tether", makeResponse());
    expect(result.headers.get("Cache-Control")).toBe("public, s-maxage=4, max-age=4");
  });

  it("keeps a stale published quote visible while warning and disabling reuse", async () => {
    const result = await enrichMissingDetailPrice(makeDb({}, NOW - 6000), "usdt-tether", makeResponse());
    expect(await result.json()).toMatchObject({ price: 0.997 });
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.get("Warning")).toContain("Response is stale");
    expect(result.headers.get("X-Data-Age")).toBe("6000");
  });

  it("preserves errors without querying or consuming them", async () => {
    const response = new Response("unavailable", { status: 503 });
    expect(await enrichMissingDetailPrice(mockD1([]), "usdt-tether", response)).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });
});

describe("detail response paths", () => {
  it("serves the published USDT price when its observation predates the depeg detection window", async () => {
    // Captured production publication: observed 1788718239, synced 1788722142,
    // served at 1788722903. The homepage still publishes this high-confidence price.
    const db = makeDb({
      price: 0.99993,
      priceObservedAt: NOW - 4664,
      priceUpdatedAt: NOW - 4664,
      priceSyncedAt: NOW - 761,
    }, NOW - 761, 60);
    const result = await handleStablecoinDetail(db, "usdt-tether", { waitUntil: vi.fn() } as unknown as ExecutionContext);
    expect(await result.json()).toMatchObject({
      price: 0.99993,
      priceObservedAt: NOW - 4664,
      priceSyncedAt: NOW - 761,
      tokens,
    });
  });

  it.each([60, 600, undefined])("enriches fresh cache, stale cache and provider responses (age %s)", async (age) => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
    vi.mocked(routeStablecoinDetail).mockResolvedValue(makeResponse());
    const result = await handleStablecoinDetail(makeDb({}, NOW - 60, age), "usdt-tether", ctx);
    const payload = await result.json() as { price: number; tokens: unknown[] };
    expect(payload.price).toBe(0.997);
    expect(payload.tokens).toEqual(tokens);
    if (age === 600) {
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(result.headers.get("X-Data-Age")).toBe("600");
      expect(result.headers.get("Warning")).toContain("Stablecoin detail cache is stale");
    }
    await Promise.all(pending);
  });

  it("enriches token-built fallback responses without publishing the price into detail history cache", async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
    vi.mocked(routeStablecoinDetail).mockImplementation(async (_config, helper) => helper.createFreshResponseFromTokens(tokens));
    const result = await handleStablecoinDetail(makeDb(), "usdt-tether", ctx);
    expect(await result.json()).toMatchObject({ price: 0.997, tokens });
    await Promise.all(pending);
    expect(vi.mocked(publishDetailCacheGeneration).mock.calls[0]?.[2]).toBe(JSON.stringify({ tokens }));
  });

  it("does not enrich retained inactive records", async () => {
    const db = makeDb({ id: "bfusd-binance" }, NOW - 60, 600);
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const result = await handleStablecoinDetail(db, "bfusd-binance", ctx);
    expect(await result.json()).not.toHaveProperty("price");
    expect(db.getHistory().some(({ binds }) => binds[0] === "stablecoins")).toBe(false);
    expect(routeStablecoinDetail).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});
