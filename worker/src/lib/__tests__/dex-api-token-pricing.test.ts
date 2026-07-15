import { describe, expect, it } from "vitest";
import { derivePoolVolume24hUsd, getTokenReferenceUsdPrice } from "../dex-api-token-pricing";
import type { DexApiPool, DexApiPoolToken } from "../dex-api-types";

// Empty address + USD reference symbol resolves to a $1 reference price via the
// symbol fallback in getTokenReferenceUsdPrice, so each side's USD estimate is
// just its raw token volume — letting us assert the merge math directly.
function usdToken(symbol: string): DexApiPoolToken {
  return { address: "", symbol, decimals: 6 };
}

function pool(symbols: string[], tokenVolumes24h: number[], volume24hUsd: number): DexApiPool {
  return {
    source: "balancer",
    chain: "ethereum",
    poolAddress: "0xpool",
    poolType: "weighted",
    tokens: symbols.map(usdToken),
    price: 1,
    tvlUsd: 0,
    volume24hUsd,
    feeRate: null,
    balances: null,
    tokenVolumes24h,
  };
}

const NO_REFS = new Map<string, string>();
const NO_SYMBOL_REFS = new Map<string, Map<string, string[]>>();

describe("derivePoolVolume24hUsd", () => {
  it("averages the two per-side USD estimates for a 2-token pool", () => {
    const result = derivePoolVolume24hUsd(
      pool(["USDC", "USDT"], [75000, 25000], 999),
      NO_REFS,
      NO_SYMBOL_REFS,
    );
    expect(result).toBe(50000); // (75000 + 25000) / 2
  });

  it("returns the raw source volume for a 3+ token pool instead of averaging", () => {
    const result = derivePoolVolume24hUsd(
      pool(["USDC", "USDT", "DAI"], [75000, 25000, 50000], 120000),
      NO_REFS,
      NO_SYMBOL_REFS,
    );
    // Averaging 3 independent estimates of the same economic flow is wrong;
    // the raw source value is kept instead.
    expect(result).toBe(120000);
  });
});

describe("getTokenReferenceUsdPrice", () => {
  const asUsdf = {
    address: "0x917af46b3c3c6e1bb7286b9f59637fb7c65851fb",
    symbol: "asUSDF",
    decimals: 18,
  };
  const addressRefs = new Map([[`bsc:${asUsdf.address}`, "asusdf-astherus"]]);

  it("fails a tracked NAV token closed when no trusted live price is available", () => {
    expect(getTokenReferenceUsdPrice(asUsdf, "bsc", addressRefs, NO_SYMBOL_REFS)).toBeNull();
  });

  it("uses a trusted live NAV price when one is available", () => {
    expect(
      getTokenReferenceUsdPrice(
        asUsdf,
        "bsc",
        addressRefs,
        NO_SYMBOL_REFS,
        undefined,
        new Map([["asusdf-astherus", 1.061756]]),
      ),
    ).toBe(1.061756);
  });
});
