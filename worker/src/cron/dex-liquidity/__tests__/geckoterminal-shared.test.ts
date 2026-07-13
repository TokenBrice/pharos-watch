import { describe, expect, it } from "vitest";
import { getGtPoolType, parseGtPool } from "../geckoterminal-shared";
import type { GtPool } from "../types";

const GT_POOL_FIXTURE: GtPool = {
  id: "ethereum_0xpool",
  type: "pool",
  attributes: {
    address: "0xPool",
    name: "USDC / USDT",
    pool_created_at: "2024-01-01T00:00:00.000Z",
    base_token_price_usd: "1.0",
    quote_token_price_usd: "0.9998",
    reserve_in_usd: "12345.67",
    volume_usd: { h24: "54321.1" },
  },
  relationships: {
    base_token: { data: { id: "ethereum_0xbase", type: "token" } },
    quote_token: { data: { id: "ethereum_0xquote", type: "token" } },
    dex: { data: { id: "uniswap-v3", type: "dex" } },
  },
};

describe("geckoterminal shared helpers", () => {
  it("normalizes raw GT pools into crawl-helper shape", () => {
    expect(parseGtPool(GT_POOL_FIXTURE, "ethereum")).toEqual({
      dexId: "uniswap-v3",
      poolAddress: "0xpool",
      tvlUsd: 12345.67,
      volume24hUsd: 54321.1,
      baseTokenAddress: "0xbase",
      quoteTokenAddress: "0xquote",
      baseTokenPriceUsd: 1,
      quoteTokenPriceUsd: 0.9998,
      createdAt: "2024-01-01T00:00:00.000Z",
      poolName: "USDC / USDT",
    });
  });

  it("drops pools with missing relationship data instead of throwing", () => {
    const malformed = {
      ...GT_POOL_FIXTURE,
      relationships: {
        ...GT_POOL_FIXTURE.relationships,
        dex: { data: null },
      },
    } as unknown as GtPool;

    expect(parseGtPool(malformed, "ethereum")).toBeNull();
  });

  it("preserves case for non-EVM pool and token identities", () => {
    const solanaPool = {
      ...GT_POOL_FIXTURE,
      attributes: { ...GT_POOL_FIXTURE.attributes, address: "PoolCase" },
      relationships: {
        ...GT_POOL_FIXTURE.relationships,
        base_token: { data: { id: "solana_MintCase", type: "token" } },
        quote_token: { data: { id: "solana_QuoteCase", type: "token" } },
      },
    } as GtPool;

    expect(parseGtPool(solanaPool, "solana")).toMatchObject({
      poolAddress: "PoolCase",
      baseTokenAddress: "MintCase",
      quoteTokenAddress: "QuoteCase",
    });
  });

  it("derives the correct GT pool type labels", () => {
    expect(getGtPoolType("uniswap-v3")).toBe("gt-concentrated");
    expect(getGtPoolType("uniswap-v4")).toBe("gt-concentrated");
    expect(getGtPoolType("pancakeswap-v3")).toBe("gt-concentrated");
    expect(getGtPoolType("curve-stable")).toBe("gt-stable-amm");
    expect(getGtPoolType("camelot")).toBe("gt-amm");
  });

  it("does not misclassify DEX IDs that merely contain v3/v4 substrings", () => {
    expect(getGtPoolType("traderv3-stable")).toBe("gt-stable-amm");
    expect(getGtPoolType("solidv4")).toBe("gt-amm");
  });
});
