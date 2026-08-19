import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFluidPools } from "../fetch-fluid";
import { initLiquidityFallbackCounters } from "../pool-helpers";
import { mockFetch } from "../../../test-helpers/__shared/mock-fetch";

describe("fetchFluidPools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not sum raw token volumes into volume24hUsd (downstream derives USD from tokenVolumes24h)", async () => {
    // One ticker row matching the real Fluid tickers v3 shape. base_volume and
    // target_volume are string-encoded token amounts in base/target token units,
    // NOT USD. The raw sum (100 + 200 = 300) was previously stamped as volume24hUsd.
    const tickerRow = {
      pool_id: "0xabc0000000000000000000000000000000000000",
      base_currency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      target_currency: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      base_volume: "100",
      target_volume: "200",
      liquidity_in_usd: "50000000",
      last_price: "1.0001",
    };
    // fetchFluidPools iterates FLUID_CHAINS; stub responses per chain.
    // The first chain to see the row is Ethereum (chainId=1). Return the ticker row for
    // that URL and an empty array for every other chain so the loop completes quickly.
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", body: [tickerRow] },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });

    const result = await fetchFluidPools(undefined, new Map());
    const ethPool = result.pools.find(
      (p) => p.poolAddress.toLowerCase() === "0xabc0000000000000000000000000000000000000",
    );
    expect(ethPool).toBeDefined();
    expect(ethPool!.volume24hUsd).toBe(0);
    expect(ethPool!.tokenVolumes24h).toEqual([100, 200]);
  });

  it("counts neutral defaults that survive fetch and enrichment", async () => {
    const tickerRow = {
      pool_id: "0xabc0000000000000000000000000000000000000",
      base_currency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      target_currency: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      base_volume: "not-a-number",
      target_volume: "200",
      liquidity_in_usd: "50000000",
      last_price: "1.0001",
    };
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", body: [tickerRow] },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });

    const counters = initLiquidityFallbackCounters();
    const result = await fetchFluidPools(undefined, new Map(), counters);
    expect(result.pools).toHaveLength(1);
    // base_volume is non-finite → coerced to 0 in tokenVolumes24h.
    expect(counters.fluidVolumeCoercedToZero).toBe(1);
    // No RPC enrichment succeeded, so feeRate/balances retain their neutral null defaults.
    expect(counters.fluidFeeRateUnmeasured).toBe(1);
    expect(counters.fluidBalancesUnmeasured).toBe(1);
  });

  it("keeps fluid counters at zero when parsing yields finite volumes and no pools are retained", async () => {
    mockFetch([
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });

    const counters = initLiquidityFallbackCounters();
    await fetchFluidPools(undefined, new Map(), counters);
    expect(counters.fluidVolumeCoercedToZero).toBe(0);
    expect(counters.fluidFeeRateUnmeasured).toBe(0);
    expect(counters.fluidBalancesUnmeasured).toBe(0);
  });
});
