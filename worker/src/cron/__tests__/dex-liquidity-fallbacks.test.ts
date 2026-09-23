import { describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../test-helpers/cron/mock-registry";

import { getFallbackTargets } from "../dex-liquidity/fetch-fallbacks";
import { initMetrics } from "../dex-liquidity/pool-helpers";
import type { LiquidityMetrics } from "../dex-liquidity/types";

/**
 * Builds a metric the way the pipeline does before scoring: only `topPools` is
 * populated. The first pool carries the measured-balance TVL; the remaining
 * pools split the rest evenly.
 */
function metricWithPools(
  stablecoinId: string,
  { poolCount, totalTvlUsd, balancedTvlUsd = 0 }: { poolCount: number; totalTvlUsd: number; balancedTvlUsd?: number },
): LiquidityMetrics {
  const metric = initMetrics(stablecoinId, "TEST");
  const unbalancedPoolCount = balancedTvlUsd > 0 ? poolCount - 1 : poolCount;
  for (let index = 0; index < poolCount; index++) {
    const balanced = balancedTvlUsd > 0 && index === 0;
    const tvlUsd = balanced ? balancedTvlUsd : (totalTvlUsd - balancedTvlUsd) / unbalancedPoolCount;
    metric.topPools.push({
      poolId: `ethereum:0x${index.toString(16).padStart(40, "0")}`,
      project: "curve",
      chain: "ethereum",
      tvlUsd,
      symbol: "TEST / USDC",
      volumeUsd1d: 0,
      poolType: "curve-stableswap-high-a",
      source: "dl",
      extra: balanced ? { balanceRatio: 0.9 } : {},
    });
  }
  return metric;
}

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [
    { id: "usdt-tether", symbol: "USDT", geckoId: "tether", contracts: [{ chain: "ethereum", address: "0x1", decimals: 6 }] },
    { id: "usdc-circle", symbol: "USDC", geckoId: "usd-coin", contracts: [{ chain: "ethereum", address: "0x2", decimals: 6 }] },
    { id: "dai-makerdao", symbol: "DAI", geckoId: "dai", contracts: [{ chain: "ethereum", address: "0x3", decimals: 18 }] },
    { id: "rwausdi-multipli", symbol: "rwaUSDi", contracts: [] },
  ],
}));

describe("getFallbackTargets", () => {
  it.each([
    { dimension: "pool count", weak: { poolCount: 2 }, healthy: { poolCount: 3 } },
    { dimension: "protocol diversity", weak: { protocols: ["curve", "curve"] }, healthy: { protocols: ["curve", "uniswap-v3"] } },
    { dimension: "TVL", weak: { totalTvlUsd: 249_999 }, healthy: { totalTvlUsd: 250_000 } },
    { dimension: "measured balance", weak: { totalTvlForBalance: 62_499 }, healthy: { totalTvlForBalance: 62_500 } },
  ])("isolates the $dimension weakness boundary", ({ weak, healthy }) => {
    const selected = (overrides: {
      poolCount?: number; totalTvlUsd?: number; totalTvlForBalance?: number; protocols?: string[];
    }) => {
      const {
        protocols = ["curve", "uniswap-v3"], poolCount = 3, totalTvlUsd = 250_000, totalTvlForBalance = 62_500,
      } = overrides;
      const metric = metricWithPools("dai-makerdao", { poolCount, totalTvlUsd, balancedTvlUsd: totalTvlForBalance });
      return getFallbackTargets(new Map([["dai-makerdao", metric]]), new Map([
        ["dai-makerdao", protocols.map((protocol) => ({ protocol, price: 1, tvl: 125_000, chain: "ethereum" }))],
      ])).some((coin) => coin.id === "dai-makerdao");
    };
    expect(selected(weak)).toBe(true);
    expect(selected(healthy)).toBe(false);
  });

  it("excludes contractless active coins only when tracked contracts are required", () => {
    const ids = (requireTrackedContracts: boolean) => getFallbackTargets(new Map(), new Map(), {
      requireTrackedContracts,
    }).map((coin) => coin.id);
    expect(ids(false)).toEqual(["usdt-tether", "usdc-circle", "dai-makerdao", "rwausdi-multipli"]);
    expect(ids(true)).toEqual(["usdt-tether", "usdc-circle", "dai-makerdao"]);
  });
  it("targets coins with zero pools, missing dex price observations, or weak partial coverage", () => {
    const metrics = new Map<string, LiquidityMetrics>();
    metrics.set("usdt-tether", metricWithPools("usdt-tether", { poolCount: 0, totalTvlUsd: 0 }));
    metrics.set("usdc-circle", metricWithPools("usdc-circle", { poolCount: 3, totalTvlUsd: 500_000, balancedTvlUsd: 200_000 }));
    metrics.set("dai-makerdao", metricWithPools("dai-makerdao", { poolCount: 4, totalTvlUsd: 500_000, balancedTvlUsd: 200_000 }));

    const priceObservations = new Map([
      ["usdt-tether", [{ price: 1, tvl: 100_000, chain: "ethereum", protocol: "curve" }]],
      [
        "dai-makerdao",
        [
          { price: 1, tvl: 150_000, chain: "ethereum", protocol: "curve" },
          { price: 1, tvl: 100_000, chain: "base", protocol: "uniswap-v3" },
        ],
      ],
    ]);

    const targetIds = new Set(
      getFallbackTargets(metrics, priceObservations, { requireTrackedContracts: true }).map((meta) => meta.id),
    );

    expect(targetIds.has("usdt-tether")).toBe(true);
    expect(targetIds.has("usdc-circle")).toBe(true);
    expect(targetIds.has("dai-makerdao")).toBe(false);
  });

  it("targets a coin whose only weakness is measured-balance coverage", () => {
    const metrics = new Map<string, LiquidityMetrics>();
    metrics.set("dai-makerdao", metricWithPools("dai-makerdao", { poolCount: 4, totalTvlUsd: 500_000 }));

    const priceObservations = new Map([
      [
        "dai-makerdao",
        [
          { price: 1, tvl: 150_000, chain: "ethereum", protocol: "curve" },
          { price: 1, tvl: 100_000, chain: "base", protocol: "uniswap-v3" },
        ],
      ],
    ]);

    const targetIds = new Set(
      getFallbackTargets(metrics, priceObservations, { requireTrackedContracts: true }).map((meta) => meta.id),
    );

    expect(targetIds.has("dai-makerdao")).toBe(true);
  });

  it("can restrict orderbook fallback targets to coins with a geckoId", () => {
    const metrics = new Map<string, LiquidityMetrics>();
    const noGecko = initMetrics("rwausdi-multipli", "rwaUSDi");
    metrics.set("rwausdi-multipli", noGecko);

    const targetIds = new Set(getFallbackTargets(metrics, new Map(), { requireGeckoId: true }).map((meta) => meta.id));

    expect(targetIds.has("rwausdi-multipli")).toBe(false);
  });
});
