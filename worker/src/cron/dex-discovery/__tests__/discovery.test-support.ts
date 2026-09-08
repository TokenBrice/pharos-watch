import { createCrawlStageContext } from "../staged-pool";
import type { StagedPool } from "../types";

export function discoveryContext(stablecoinId: string, overrides: Partial<Parameters<typeof createCrawlStageContext>[0]> = {}) {
  const value = createCrawlStageContext({
    stablecoinId, knownPoolIds: new Set(), nowSec: 1_800_000_000, pools: [], priceObs: [], ...overrides,
  });
  return { pools: value.pools, value };
}

export function stagedPool(overrides: Partial<StagedPool> = {}): StagedPool {
  return {
    poolId: "ethereum:0xpool", stablecoinId: "test", source: "dexscreener", chain: "ethereum",
    protocol: "test", dexId: "test", symbol: "TEST / USDC", tvlUsd: 10_000, volume24h: 1_000,
    qualityMultiplier: 1, poolType: "amm", feeTier: null, balanceRatio: null, isStable: null,
    baseToken: null, quoteToken: "0x0000000000000000000000000000000000000002", quoteSymbol: "USDC",
    priceUsd: 1, lockedLiqPct: null, rawJson: null, discoveredAt: 1, refreshedAt: 1, ...overrides,
  };
}

export function coinGeckoPool(options: {
  id?: string; address?: string; name?: string; network?: string; baseToken?: string; quoteToken?: string;
  dex?: string; basePrice?: string; quotePrice?: string; reserve?: string; volume?: string; createdAt?: string;
} = {}) {
  const network = options.network ?? "token";
  return {
    id: options.id ?? "cg-pool", type: "pool",
    attributes: {
      address: options.address ?? "0xPool", name: options.name ?? "USDC / USDT",
      pool_created_at: options.createdAt ?? "2025-01-01T00:00:00.000Z",
      base_token_price_usd: options.basePrice ?? "1.0002", quote_token_price_usd: options.quotePrice ?? "0.9999",
      reserve_in_usd: options.reserve ?? "220000", volume_usd: { h24: options.volume ?? "18000" },
    },
    relationships: {
      base_token: { data: { id: `${network}_${options.baseToken ?? "0xabc"}`, type: "token" } },
      quote_token: { data: { id: `${network}_${options.quoteToken ?? "0xquote"}`, type: "token" } },
      dex: { data: { id: options.dex ?? "uniswap-v3", type: "dex" } },
    },
  };
}
