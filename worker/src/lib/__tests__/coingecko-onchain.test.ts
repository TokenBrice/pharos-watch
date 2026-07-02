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
  fetchCgTokenPools,
  fetchCgTokenPoolsWithStatus,
  isOnchainAvailable,
  onchainRateLimit,
  parseCgPoolVolume,
} from "../coingecko-onchain";

describe("coingecko-onchain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("tracks API-key availability and rate-limit only after the first request", async () => {
    expect(isOnchainAvailable("cg-key")).toBe(true);
    expect(isOnchainAvailable(null)).toBe(false);

    const signal = new AbortController().signal;
    await onchainRateLimit(0, signal);
    expect(sleepWithSignal).not.toHaveBeenCalled();

    await onchainRateLimit(2, signal);
    expect(sleepWithSignal).toHaveBeenCalledWith(RATE_LIMITS.COINGECKO_ONCHAIN_MS, signal);
  });

  it("fetches token pools and handles non-array or non-ok responses", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "pool-1" }] }), { status: 200 }),
    );

    const pools = await fetchCgTokenPools("eth", "0xabc");
    expect(pools).toEqual([{ id: "pool-1" }]);
    expect(fetchWithRetry).toHaveBeenCalledWith(
      expect.stringContaining("/onchain/networks/eth/tokens/0xabc/pools?include=base_token,quote_token&page=1"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/json",
          "User-Agent": "Pharos/1.0 (stablecoin analytics)",
        }),
      }),
      1,
      expect.objectContaining({ timeoutMs: undefined }),
    );

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { bad: true } }), { status: 200 }),
    );
    expect(await fetchCgTokenPools("eth", "0xdef")).toEqual([]);

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect(await fetchCgTokenPools("eth", "0xghi")).toEqual([]);
  });

  it("exposes token-pool fetch status for circuit breaker accounting", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await expect(fetchCgTokenPoolsWithStatus("eth", "0xghi")).resolves.toEqual({
      ok: false,
      pools: [],
    });

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await expect(fetchCgTokenPoolsWithStatus("eth", "0xempty")).resolves.toEqual({
      ok: true,
      pools: [],
    });
  });

  it("treats CoinGecko onchain lookup misses as source-healthy empty results", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(fetchCgTokenPoolsWithStatus("eth", "0xmissing")).resolves.toEqual({
      ok: true,
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
