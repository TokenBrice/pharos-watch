import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../abort", () => ({
  sleepWithSignal: vi.fn(async () => undefined),
}));

import { RATE_LIMITS } from "../rate-limit";
import { sleepWithSignal } from "../abort";
import { fetchWithRetry } from "../fetch-retry";
import {
  fetchCgTokenPoolsWithStatus,
  onchainRateLimit,
  parseCgPoolVolume,
} from "../coingecko-onchain";

const validPool = {
  id: "pool-1",
  type: "pool",
  attributes: {
    address: "0xpool",
    name: "USDC / USDT",
    pool_created_at: null,
    base_token_price_usd: "1",
    quote_token_price_usd: "1",
    reserve_in_usd: "100000",
    volume_usd: { h24: "10000" },
  },
  relationships: {
    base_token: { data: { id: "eth_0xbase", type: "token" } },
    quote_token: { data: { id: "eth_0xquote", type: "token" } },
    dex: { data: { id: "uniswap-v3", type: "dex" } },
  },
};

describe("coingecko-onchain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("rate-limits only after the first request", async () => {
    const signal = new AbortController().signal;
    await onchainRateLimit(0, signal);
    expect(sleepWithSignal).not.toHaveBeenCalled();

    await onchainRateLimit(2, signal);
    expect(sleepWithSignal).toHaveBeenCalledWith(RATE_LIMITS.COINGECKO_ONCHAIN_MS, signal);
  });

  it("keeps valid pool members when a sibling is missing attributes", async () => {
    const { attributes: _attributes, ...missingAttributes } = validPool;
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [validPool, missingAttributes] }), { status: 200 }),
    );
    await expect(fetchCgTokenPoolsWithStatus("eth", "0xdef")).resolves.toEqual({
      transportOk: true,
      schemaDegraded: true,
      complete: true,
      pools: [validPool],
    });
  });

  it("marks all-invalid and malformed relationship responses as schema-degraded", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "pool-1" }] }), { status: 200 }),
    );
    await expect(fetchCgTokenPoolsWithStatus("eth", "0xall-invalid")).resolves.toEqual({
      transportOk: true,
      schemaDegraded: true,
      complete: true,
      pools: [],
    });

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{
            ...validPool,
            relationships: {
              ...validPool.relationships,
              dex: { data: { id: "uniswap-v3", type: 1 } },
            },
          }],
        }),
        { status: 200 },
      ),
    );
    await expect(fetchCgTokenPoolsWithStatus("eth", "0xmalformed-relationship")).resolves.toEqual({
      transportOk: true,
      schemaDegraded: true,
      complete: true,
      pools: [],
    });
  });

  it("accepts production-shaped CoinGecko Pro pool payloads with omitted optional attributes", async () => {
    const capturedPool = {
      id: "eth_0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      type: "pool",
      attributes: {
        address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
        name: "USDC / WETH 0.05%",
        pool_created_at: "2021-12-29T12:35:31Z",
        base_token_price_usd: "0.9998",
        quote_token_price_usd: "3820.12",
        reserve_in_usd: "184250000.42",
        volume_usd: { h24: "35200000.13" },
      },
      relationships: {
        base_token: { data: { id: "eth_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", type: "token" } },
        quote_token: { data: { id: "eth_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", type: "token" } },
        dex: { data: { id: "uniswap-v3", type: "dex" } },
      },
    };
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [capturedPool] }), { status: 200 }),
    );

    await expect(fetchCgTokenPoolsWithStatus("eth", "0xa0b8")).resolves.toEqual({
      transportOk: true,
      schemaDegraded: false,
      complete: true,
      pools: [capturedPool],
    });
  });

  it("separates transport health from malformed payloads for circuit breaker accounting", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await expect(fetchCgTokenPoolsWithStatus("eth", "0xghi")).resolves.toEqual({
      transportOk: false,
      schemaDegraded: false,
      complete: false,
      pools: [],
    });

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await expect(fetchCgTokenPoolsWithStatus("eth", "0xempty")).resolves.toEqual({
      transportOk: true,
      schemaDegraded: false,
      complete: true,
      pools: [],
    });

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { bad: true } }), { status: 200 }),
    );
    await expect(fetchCgTokenPoolsWithStatus("eth", "0xnon-array")).resolves.toEqual({
      transportOk: true,
      schemaDegraded: true,
      complete: false,
      pools: [],
    });
  });

  it("treats CoinGecko onchain lookup misses as source-healthy empty results", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(fetchCgTokenPoolsWithStatus("eth", "0xmissing")).resolves.toEqual({
      transportOk: true,
      schemaDegraded: false,
      complete: true,
      pools: [],
    });

    expect(fetchWithRetry).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Object),
      1,
      expect.objectContaining({
        passthroughStatuses: [400, 404],
      }),
    );
  });

  it("never claims completeness for a scan that ran out of pages", async () => {
    const fullPage = { data: Array.from({ length: 20 }, () => validPool) };
    for (let page = 0; page < 3; page++) {
      vi.mocked(fetchWithRetry).mockResolvedValueOnce(
        new Response(JSON.stringify(fullPage), { status: 200 }),
      );
    }

    const result = await fetchCgTokenPoolsWithStatus("eth", "0xdeep");

    expect(result.complete).toBe(false);
    expect(result.transportOk).toBe(true);
    expect(result.pools).toHaveLength(60);
  });

  it("parses pool volume from flat, nested, and invalid payloads", () => {
    expect(
      parseCgPoolVolume({
        address: "0x1",
        name: "Pool",
        pool_created_at: null,
        base_token_price_usd: null,
        quote_token_price_usd: null,
        reserve_in_usd: null,
        h24_volume_usd: "123.45",
        pool_fee_percentage: null,
        locked_liquidity_percentage: null,
      }),
    ).toBe(123.45);

    expect(
      parseCgPoolVolume({
        address: "0x2",
        name: "Pool",
        pool_created_at: null,
        base_token_price_usd: null,
        quote_token_price_usd: null,
        reserve_in_usd: null,
        h24_volume_usd: null,
        pool_fee_percentage: null,
        locked_liquidity_percentage: null,
        volume_usd: { h24: "77" },
      }),
    ).toBe(77);

    expect(
      parseCgPoolVolume({
        address: "0x3",
        name: "Pool",
        pool_created_at: null,
        base_token_price_usd: null,
        quote_token_price_usd: null,
        reserve_in_usd: null,
        h24_volume_usd: "bad",
        pool_fee_percentage: null,
        locked_liquidity_percentage: null,
        volume_usd: { h24: "0" },
      }),
    ).toBe(0);
  });
});
