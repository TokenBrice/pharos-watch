import { afterEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
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
});
