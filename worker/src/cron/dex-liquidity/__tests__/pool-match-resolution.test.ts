import { describe, expect, it } from "vitest";
import { resolveLlamaPoolStablecoinMatches } from "../pool-match-resolution";
import type { LlamaPool, SymbolLookups } from "../types";

function makePool(overrides: Partial<LlamaPool>): LlamaPool {
  return {
    pool: "0xpool",
    chain: "Ethereum",
    project: "curve",
    symbol: "USDC-USDT",
    tvlUsd: 1_000_000,
    volumeUsd1d: 100_000,
    volumeUsd7d: 700_000,
    stablecoin: true,
    underlyingTokens: null,
    apyBase: null,
    apyReward: null,
    apy: 0,
    sigma: 0,
    exposure: "multi",
    count: 365,
    ...overrides,
  };
}

function makeLookups(): Pick<SymbolLookups, "chainAddressToId" | "symbolToChainScopedIds"> {
  return {
    chainAddressToId: new Map([
      ["ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usd-coin"],
      ["ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7", "tether"],
      ["base:0xbaseusdc", "usd-coin"],
    ]),
    symbolToChainScopedIds: new Map([
      ["USDC", new Map([["ethereum", ["usd-coin"]], ["base", ["usd-coin"]]])],
      ["USDT", new Map([["ethereum", ["tether"]]])],
      ["USD", new Map([["ethereum", ["usd-coin", "tether"]]])],
    ]),
  };
}

describe("resolveLlamaPoolStablecoinMatches", () => {
  it("matches stablecoins by chain-scoped underlying token address", () => {
    const result = resolveLlamaPoolStablecoinMatches(
      makePool({
        underlyingTokens: [
          "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        ],
      }),
      makeLookups(),
    );

    expect(result.hasUnderlyingTokenAddresses).toBe(true);
    expect([...result.matchedIds].sort()).toEqual(["tether", "usd-coin"]);
    expect(result.poolSymbols).toEqual(["USDC", "USDT"]);
  });

  it("does not fall back to symbols when upstream supplied usable addresses", () => {
    const result = resolveLlamaPoolStablecoinMatches(
      makePool({
        symbol: "USDC",
        underlyingTokens: ["0x0000000000000000000000000000000000000000"],
      }),
      makeLookups(),
    );

    expect(result.hasUnderlyingTokenAddresses).toBe(true);
    expect([...result.matchedIds]).toEqual([]);
  });

  it("falls back to a unique chain-scoped symbol when no usable addresses are present", () => {
    const result = resolveLlamaPoolStablecoinMatches(
      makePool({
        symbol: "USDC",
        underlyingTokens: null,
      }),
      makeLookups(),
    );

    expect(result.hasUnderlyingTokenAddresses).toBe(false);
    expect([...result.matchedIds]).toEqual(["usd-coin"]);
  });

  it("treats blank underlying token values as absent and allows symbol fallback", () => {
    const result = resolveLlamaPoolStablecoinMatches(
      makePool({
        symbol: "USDT",
        underlyingTokens: ["", "   "],
      }),
      makeLookups(),
    );

    expect(result.hasUnderlyingTokenAddresses).toBe(false);
    expect([...result.matchedIds]).toEqual(["tether"]);
  });

  it("skips ambiguous chain-scoped symbols", () => {
    const result = resolveLlamaPoolStablecoinMatches(
      makePool({
        symbol: "USD",
        underlyingTokens: null,
      }),
      makeLookups(),
    );

    expect(result.hasUnderlyingTokenAddresses).toBe(false);
    expect([...result.matchedIds]).toEqual([]);
  });
});
