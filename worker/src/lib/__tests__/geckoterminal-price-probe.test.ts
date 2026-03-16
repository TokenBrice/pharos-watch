import { describe, it, expect } from "vitest";
import { extractPoolPrice } from "../geckoterminal-price-probe";
import type { GtPool } from "../../cron/dex-liquidity/types";

describe("extractPoolPrice", () => {
  const baseAddress = "0xabcdef1234567890abcdef1234567890abcdef12";

  it("returns price from highest-TVL pool where token is base", () => {
    const pools = [
      makePool({
        reserveUsd: "500000",
        basePriceUsd: "0.80",
        quotePriceUsd: "1.19",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.80);
    expect(result!.tvlUsd).toBe(500000);
    expect(result!.side).toBe("base");
  });

  it("returns price from highest-TVL pool where token is quote", () => {
    const pools = [
      makePool({
        reserveUsd: "200000",
        basePriceUsd: "1.19",
        quotePriceUsd: "0.95",
        baseTokenId: "eth_0xother",
        quoteTokenId: `eth_${baseAddress}`,
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.95);
    expect(result!.side).toBe("quote");
  });

  it("returns null when token address matches neither base nor quote", () => {
    const pools = [
      makePool({
        reserveUsd: "100000",
        basePriceUsd: "1.00",
        quotePriceUsd: "1.00",
        baseTokenId: "eth_0xother1",
        quoteTokenId: "eth_0xother2",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).toBeNull();
  });

  it("returns null when TVL is below threshold", () => {
    const pools = [
      makePool({
        reserveUsd: "5000",
        basePriceUsd: "0.80",
        quotePriceUsd: "1.19",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress, 10_000);
    expect(result).toBeNull();
  });

  it("picks highest-TVL pool among multiple", () => {
    const pools = [
      makePool({
        reserveUsd: "50000",
        basePriceUsd: "0.99",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
      makePool({
        reserveUsd: "800000",
        basePriceUsd: "0.80",
        quotePriceUsd: "1.19",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote2",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.80);
    expect(result!.tvlUsd).toBe(800000);
  });

  it("returns null for empty pool list", () => {
    expect(extractPoolPrice([], baseAddress)).toBeNull();
  });

  it("returns null when price is zero or NaN", () => {
    const pools = [
      makePool({
        reserveUsd: "100000",
        basePriceUsd: "0",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
    ];
    expect(extractPoolPrice(pools, baseAddress)).toBeNull();
  });

  it("handles case-insensitive address matching", () => {
    const pools = [
      makePool({
        reserveUsd: "200000",
        basePriceUsd: "0.99",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress.toUpperCase()}`,
        quoteTokenId: "eth_0xquote",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.99);
  });
});

function makePool(opts: {
  reserveUsd: string;
  basePriceUsd: string;
  quotePriceUsd: string;
  baseTokenId: string;
  quoteTokenId: string;
}): GtPool {
  return {
    id: "pool_1",
    type: "pool",
    attributes: {
      address: "0xpool",
      name: "TEST/USDC",
      pool_created_at: null,
      base_token_price_usd: opts.basePriceUsd,
      quote_token_price_usd: opts.quotePriceUsd,
      reserve_in_usd: opts.reserveUsd,
      volume_usd: { h24: "0" },
    },
    relationships: {
      base_token: { data: { id: opts.baseTokenId, type: "token" } },
      quote_token: { data: { id: opts.quoteTokenId, type: "token" } },
      dex: { data: { id: "curve", type: "dex" } },
    },
  };
}
