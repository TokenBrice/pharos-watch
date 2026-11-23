import { describe, expect, it } from "vitest";
import {
  getMintBurnTrackedChains,
  sumMcapForTrackedChains,
  sumWindowStartSupplyForTrackedChains,
} from "../mint-burn-mcap-weighting";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";

describe("sumMcapForTrackedChains", () => {
  it("adds Tron supply only when its config is in the admitted publication scope", () => {
    const allUsdt = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "usdt-tether");
    const ethereumOnly = allUsdt.filter((config) => config.chain.chainId === "ethereum");
    const supply = { Ethereum: { current: 60e9 }, Tron: { current: 80e9 }, Solana: { current: 2e9 } };
    expect(sumMcapForTrackedChains("usdt-tether", supply, { peggedUSD: 142e9 }, ethereumOnly)).toBe(60e9);
    expect(sumMcapForTrackedChains("usdt-tether", supply, { peggedUSD: 142e9 }, allUsdt)).toBe(140e9);
    expect(sumMcapForTrackedChains("usdt-tether", undefined, { peggedUSD: 142e9 }, ethereumOnly)).toBeNull();
  });

  it("preserves unavailable and measured zero Tron supply after admission", () => {
    // A partially observed scope must not silently shrink to Ethereum alone.
    expect(sumMcapForTrackedChains("usdt-tether", {
      Ethereum: { current: 100 },
    }, { peggedUSD: 140e9 })).toBeNull();
    expect(sumMcapForTrackedChains("usdt-tether", {
      Ethereum: { current: 100 }, Tron: { current: null },
    }, { peggedUSD: 140e9 })).toBeNull();
    expect(sumMcapForTrackedChains("usdt-tether", {
      Ethereum: { current: 60e9 }, Tron: { current: null },
    }, { peggedUSD: 140e9 })).toBeNull();
    expect(sumMcapForTrackedChains("usdt-tether", {
      Ethereum: { current: 60e9 }, Tron: { current: 0 },
    }, { peggedUSD: 140e9 })).toBe(60e9);
  });

  it("withholds global fallback when a publication excludes one configured chain", () => {
    const source = MINT_BURN_CONFIGS.find((config) => getMintBurnTrackedChains(config.stablecoinId).length > 1)!;
    expect(source).toBeDefined();
    const scope = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === source.stablecoinId
      && config.chain.chainId === source.chain.chainId);
    expect(sumMcapForTrackedChains(source.stablecoinId, undefined, { peggedUSD: 1000 }, scope)).toBeNull();
    expect(sumMcapForTrackedChains(source.stablecoinId,
      { [source.chain.chainId]: { current: 100 } }, { peggedUSD: 1000 }, scope)).toBe(100);
  });
  // Real DefiLlama payloads key chainCirculating by display name ("Ethereum",
  // "Arbitrum", "Solana"). The canonicalizer resolves these to lowercase
  // canonical chain ids before lookup.
  const chainCirculatingDL: Record<string, { current: number }> = {
    Ethereum: { current: 32_000_000_000 },
    Solana:   { current: 4_000_000_000 },
    Base:     { current: 1_000_000_000 },
  };
  const peggedTotal: Record<string, number> = { peggedUSD: 37_000_000_000 };

  it("sums only tracked chains for USDC (canonicalizes capitalized DL keys)", () => {
    expect(sumMcapForTrackedChains("usdc-circle", chainCirculatingDL, peggedTotal)).toBe(32_000_000_000);
  });

  it("also works when chainCirculating uses lowercase canonical keys", () => {
    const lowercase: Record<string, { current: number }> = {
      ethereum: { current: 32_000_000_000 },
      solana:   { current: 4_000_000_000 },
    };
    expect(sumMcapForTrackedChains("usdc-circle", lowercase, peggedTotal)).toBe(32_000_000_000);
  });

  it("falls back to peg-bucket total when chainCirculating has no tracked-chain key", () => {
    expect(sumMcapForTrackedChains("usdc-circle", { Solana: { current: 4e9 } }, peggedTotal)).toBe(37_000_000_000);
  });

  it("falls back to peg-bucket total when chainCirculating is undefined", () => {
    expect(sumMcapForTrackedChains("usdc-circle", undefined, peggedTotal)).toBe(37_000_000_000);
  });

  it("returns the circulating bucket total for an untracked coin id", () => {
    expect(sumMcapForTrackedChains("nonexistent", chainCirculatingDL, peggedTotal)).toBe(37_000_000_000);
  });

  it("returns null, not 0, when the fallback supply is absent, empty or wholly invalid", () => {
    expect(sumMcapForTrackedChains("usdc-circle", undefined, undefined)).toBeNull();
    expect(sumMcapForTrackedChains("usdc-circle", {}, {})).toBeNull();
    expect(sumMcapForTrackedChains("nonexistent", undefined, { peggedUSD: Number.NaN })).toBeNull();
  });

  it("keeps an explicit zero fallback bucket as a measured zero", () => {
    expect(sumMcapForTrackedChains("usdc-circle", undefined, { peggedUSD: 0 })).toBe(0);
  });

  it("treats current=0 as real data (contributes 0, does NOT trigger fallback)", () => {
    // If a tracked chain reports 0 supply (bootstrapping or burn-to-zero), weight is 0.
    // The canonicalizer retains the observed entry, so the result is 0.
    expect(sumMcapForTrackedChains("usdc-circle", { Ethereum: { current: 0 } }, peggedTotal)).toBe(0);
  });
});

describe("sumWindowStartSupplyForTrackedChains", () => {
  it("sums circulatingPrevDay/Week/Month strictly over admitted tracked chains and leaves 90d null", () => {
    const allUsdt = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "usdt-tether");
    const ethereumOnly = allUsdt.filter((config) => config.chain.chainId === "ethereum");
    const supply = {
      Ethereum: {
        current: 66e9,
        circulatingPrevDay: 66.1e9,
        circulatingPrevWeek: 66.7e9,
        circulatingPrevMonth: 72.7e9,
      },
      Tron: {
        current: 91.5e9,
        circulatingPrevDay: 91.5e9,
        circulatingPrevWeek: 91.9e9,
        circulatingPrevMonth: 92.5e9,
      },
      Solana: {
        current: 2e9,
        circulatingPrevDay: 2e9,
        circulatingPrevWeek: 2e9,
        circulatingPrevMonth: 2e9,
      },
    };
    expect(sumWindowStartSupplyForTrackedChains("usdt-tether", supply, ethereumOnly)).toEqual({
      window24h: 66.1e9,
      window7d: 66.7e9,
      window30d: 72.7e9,
      window90d: null,
    });
    expect(sumWindowStartSupplyForTrackedChains("usdt-tether", supply, allUsdt)).toEqual({
      window24h: 157.6e9,
      window7d: 158.6e9,
      window30d: 165.2e9,
      window90d: null,
    });
  });

  it("fails closed when any admitted chain lacks a historical bucket and preserves observed zero", () => {
    const allUsdt = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "usdt-tether");
    expect(sumWindowStartSupplyForTrackedChains("usdt-tether", {
      Ethereum: {
        current: 66e9,
        circulatingPrevDay: 66e9,
        circulatingPrevWeek: 67e9,
        circulatingPrevMonth: 70e9,
      },
      Tron: {
        current: 91e9,
        circulatingPrevDay: 0,
        circulatingPrevWeek: null,
        // circulatingPrevMonth omitted
      },
    }, allUsdt)).toEqual({
      window24h: 66e9,
      window7d: null,
      window30d: null,
      window90d: null,
    });
    expect(sumWindowStartSupplyForTrackedChains("usds-sky", {
      Ethereum: { current: 3.2e9, circulatingPrevDay: 0 },
    })).toEqual({
      window24h: 0,
      window7d: null,
      window30d: null,
      window90d: null,
    });
    expect(sumWindowStartSupplyForTrackedChains("usds-sky", undefined)).toEqual({
      window24h: null,
      window7d: null,
      window30d: null,
      window90d: null,
    });
  });
});
