import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMeteoraPools } from "../fetch-meteora";
import { mockFetch } from "../../../test-helpers/__shared/mock-fetch";

function validMeteoraPool(index: number) {
  return {
    address: `Pool${index}`,
    token_x: { address: `TokenX${index}`, symbol: "SOL", decimals: 9, price: 90 },
    token_y: { address: `TokenY${index}`, symbol: "USDC", decimals: 6, price: 1 },
    token_x_amount: 100,
    token_y_amount: 9000,
    current_price: 90,
    tvl: 18_000,
    volume: { "24h": 25_000 },
    pool_config: { base_fee_pct: 0.01 },
    dynamic_fee_pct: 0.002,
    is_blacklisted: false,
  };
}

describe("fetchMeteoraPools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes Meteora pools into direct-api pools", async () => {
    mockFetch([{
      match: "api.meteora.ag",
      outcomes: [
        {
          body: {
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
          },
        },
        { body: { data: [] } },
      ],
    }], { requireMatch: true });

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
    mockFetch([{
      match: "api.meteora.ag",
      outcomes: [{ body: "{bad-json" }],
    }], { requireMatch: true });

    const result = await fetchMeteoraPools();

    expect(result.pools).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.errors[0]).toContain("invalid JSON");
  });

  it("returns a degraded result when Meteora returns a null root", async () => {
    mockFetch([{
      match: "api.meteora.ag",
      outcomes: [{ body: "null" }],
    }], { requireMatch: true });

    const result = await fetchMeteoraPools();

    expect(result.pools).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.errors[0]).toContain("non-object JSON root");
  });

  it("skips malformed Meteora rows while preserving valid rows from the same page", async () => {
    mockFetch([{
      match: "api.meteora.ag",
      body: {
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
      },
    }], { requireMatch: true });

    const result = await fetchMeteoraPools();

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].poolAddress).toBe("Pool111");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain("page 1 skipped 1 malformed pool rows");
  });

  it("keeps malformed-row notes as warnings but degrades when a later page fails", async () => {
    mockFetch([{
      match: "api.meteora.ag",
      outcomes: [{ body: {
        data: [
          {
            address: "BrokenPool",
            token_y: { address: "USDC111", symbol: "USDC", decimals: 6, price: 1 },
            token_x_amount: 100,
            token_y_amount: 100,
            tvl: 20_000,
          },
          ...Array.from({ length: 499 }, (_, index) => validMeteoraPool(index)),
        ],
      } }, { body: "upstream down", status: 503 }],
    }], { requireMatch: true });

    const result = await fetchMeteoraPools();

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.pools).toHaveLength(499);
    expect(result.warnings).toContain("page 1 skipped 1 malformed pool rows");
    expect(result.errors[0]).toContain("returned 503");
  });

  it("uses current_price and ignores imbalanced reserve ratio on DLMM pools", async () => {
    // Real fixture: SOL/USDC pool with reserve ratio 13.02 vs current_price 84.93
    mockFetch([{
      match: "api.meteora.ag",
      outcomes: [{ body: {
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
      } }, { body: { data: [] } }],
    }], { requireMatch: true });

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
