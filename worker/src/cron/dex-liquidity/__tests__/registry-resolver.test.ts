import { describe, expect, it } from "vitest";
import type { StagedPool } from "../../dex-discovery/types";
import { resolveRegistryPools } from "../registry-resolver";

const NOW = 1_710_000_000;
function row(overrides: Partial<StagedPool> = {}): StagedPool {
  return {
    stablecoinId: "usdt-tether", poolId: "solana:MixedCasePool", source: "dl",
    chain: "solana", protocol: "orca", dexId: "orca", symbol: "USDT/USDC",
    tvlUsd: 100_000, volume24h: 500, qualityMultiplier: null, poolType: null,
    feeTier: null, balanceRatio: null, isStable: null, baseToken: null,
    quoteToken: null, quoteSymbol: null, priceUsd: null, lockedLiqPct: null,
    rawJson: null, discoveredAt: NOW - 86400, refreshedAt: NOW, ...overrides,
  };
}

describe("resolveRegistryPools", () => {
  it("prefers trust through the inclusive 24h boundary, then the fresh source", () => {
    const trusted = row({ refreshedAt: NOW - 86400 });
    const secondary = row({ source: "cg_onchain", tvlUsd: 200_000 });
    expect(resolveRegistryPools([secondary, trusted], NOW)[0].value).toBe(trusted);
    expect(resolveRegistryPools([secondary, trusted], NOW + 1)[0].value).toBe(secondary);
  });

  it("falls back to freshness rather than trust when all values are aged", () => {
    const old = row({ refreshedAt: NOW - 100_000 });
    const newer = row({ source: "dexscreener", refreshedAt: NOW - 90_000 });
    expect(resolveRegistryPools([old, newer], NOW)[0].value).toBe(newer);
  });

  it("does not let a trusted NULL suppress a fresh value, and leaves NULL-only pools unvalued", () => {
    const nullValue = row({ tvlUsd: null });
    const measured = row({ source: "cg_onchain", refreshedAt: NOW - 60 });
    expect(resolveRegistryPools([nullValue, measured], NOW)[0].value).toBe(measured);
    const freshestNull = row({ source: "dexscreener", tvlUsd: null, refreshedAt: NOW + 1 });
    expect(resolveRegistryPools([nullValue, freshestNull], NOW)[0].value).toBe(freshestNull);
  });

  it("selects price independently with its original source and its own day-fresh fence", () => {
    const value = row();
    const price = row({ source: "cg_onchain", priceUsd: 0.999, refreshedAt: NOW - 86400 });
    const view = resolveRegistryPools([price, value], NOW)[0];
    expect(view.value).toBe(value);
    expect(view.price).toBe(price);
    expect(view.price?.source).toBe("cg_onchain");
    expect(resolveRegistryPools([price, value], NOW + 1)[0].price).toBeNull();
  });

  it("borrows the token tuple from one complete witness, not opposite partial orientations", () => {
    const view = resolveRegistryPools([
      row({ baseToken: "A", quoteSymbol: "WRONG" }),
      row({ source: "cg_onchain", baseToken: "B", quoteToken: "A", quoteSymbol: "TOKEN_A" }),
      row({ source: "dexscreener", baseToken: "A", quoteToken: "B", quoteSymbol: "TOKEN_B" }),
    ], NOW)[0];
    expect(view.metadata).toMatchObject({ baseToken: "B", quoteToken: "A", quoteSymbol: "TOKEN_A" });
  });

  it("resolves ties and output order independently of input order without lowercasing native ids", () => {
    const rows = [
      row({ source: "gecko_terminal", priceUsd: 1 }),
      row({ source: "cg_onchain", priceUsd: 0.999 }),
      row({ poolId: "solana:mixedcasepool" }),
      row({ stablecoinId: "aaa", poolId: "solana:Other" }),
    ];
    const resolved = resolveRegistryPools(rows, NOW);
    expect(resolveRegistryPools([...rows].reverse(), NOW)).toEqual(resolved);
    expect(resolved.map((view) => [view.stablecoinId, view.poolId])).toEqual([
      ["aaa", "solana:Other"], ["usdt-tether", "solana:MixedCasePool"], ["usdt-tether", "solana:mixedcasepool"],
    ]);
    expect(resolved[1].value.source).toBe("cg_onchain");
    expect(resolved[1].price?.source).toBe("cg_onchain");
    expect(resolveRegistryPools([rows[0], { ...rows[1], refreshedAt: NOW - 1 }], NOW)[0].value.source).toBe("gecko_terminal");
  });
});
