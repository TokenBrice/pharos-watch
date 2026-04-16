import { afterEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe("fetchMeteoraPools", () => {
  afterEach(() => {
    mockFetch.mockReset();
    vi.resetModules();
  });

  it("normalizes Meteora pools into direct-api pools", async () => {
    const { fetchMeteoraPools } = await import("../fetch-meteora");
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          address: "Pool111",
          token_x: { address: "So111", symbol: "SOL", decimals: 9, price: 90 },
          token_y: { address: "USDC111", symbol: "USDC", decimals: 6, price: 1 },
          token_x_amount: 100,
          token_y_amount: 9000,
          current_price: 90,
          tvl: 18000,
          volume: { "24h": 25000 },
          pool_config: { base_fee_pct: 0.01 },
          dynamic_fee_pct: 0.002,
          is_blacklisted: false,
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await fetchMeteoraPools();

    expect(result.ok).toBe(true);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      source: "meteora",
      chain: "solana",
      poolType: "meteora-dlmm",
      tvlUsd: 18000,
      volume24hUsd: 25000,
      balances: [100, 9000],
    });
    expect(result.pools[0].feeRate).toBeCloseTo(0.00012);
  });

  it("returns a degraded result when Meteora returns invalid JSON", async () => {
    const { fetchMeteoraPools } = await import("../fetch-meteora");
    mockFetch.mockResolvedValueOnce(textResponse("{bad-json"));

    const result = await fetchMeteoraPools();

    expect(result.pools).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.errors[0]).toContain("invalid JSON");
  });

  it("returns a degraded result when Meteora returns a null root", async () => {
    const { fetchMeteoraPools } = await import("../fetch-meteora");
    mockFetch.mockResolvedValueOnce(textResponse("null"));

    const result = await fetchMeteoraPools();

    expect(result.pools).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.errors[0]).toContain("non-object JSON root");
  });

  it("skips malformed Meteora rows while preserving valid rows from the same page", async () => {
    const { fetchMeteoraPools } = await import("../fetch-meteora");
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [
        {
          address: "BrokenPool",
          token_y: { address: "USDC111", symbol: "USDC", decimals: 6, price: 1 },
          token_x_amount: 100,
          token_y_amount: 100,
          tvl: 20_000,
        },
        {
          address: "Pool111",
          token_x: { address: "So111", symbol: "SOL", decimals: 9, price: 90 },
          token_y: { address: "USDC111", symbol: "USDC", decimals: 6, price: 1 },
          token_x_amount: 100,
          token_y_amount: 9000,
          current_price: 90,
          tvl: 18_000,
          volume: { "24h": 25_000 },
          pool_config: { base_fee_pct: 0.01 },
          dynamic_fee_pct: 0.002,
          is_blacklisted: false,
        },
      ],
    }));

    const result = await fetchMeteoraPools();

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].poolAddress).toBe("Pool111");
    expect(result.errors).toContain("page 1 skipped 1 malformed pool rows");
  });

  it("uses current_price and ignores imbalanced reserve ratio on DLMM pools", async () => {
    const { fetchMeteoraPools } = await import("../fetch-meteora");
    // Real fixture: SOL/USDC pool with reserve ratio 13.02 vs current_price 84.93
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          address: "HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR",
          token_x: { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, price: 85 },
          token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, price: 1 },
          token_x_amount: 6885.094,
          token_y_amount: 89650.78,
          current_price: 84.93,
          tvl: 673863,
          volume: { "24h": 500_000 },
          pool_config: { base_fee_pct: 0.25 },
          dynamic_fee_pct: 0,
          is_blacklisted: false,
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await fetchMeteoraPools();

    expect(result.ok).toBe(true);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].price).toBeCloseTo(84.93, 2);
    // Regression guard: derived reserve ratio would be ~13.02
    expect(result.pools[0].price).not.toBeCloseTo(13.02, 0);
    // balances must still carry raw reserves for downstream consumers
    expect(result.pools[0].balances).toEqual([6885.094, 89650.78]);
  });
});
