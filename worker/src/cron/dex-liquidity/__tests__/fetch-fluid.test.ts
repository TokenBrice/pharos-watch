import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFluidPools } from "../fetch-fluid";
import { initLiquidityFallbackCounters } from "../pool-helpers";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { fetchEvmCallHexAtBlock } from "../../../lib/evm-rpc";
import type * as EvmRpcModule from "../../../lib/evm-rpc";

vi.mock("../../../lib/evm-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof EvmRpcModule>();
  return { ...actual, fetchEvmCallHexAtBlock: vi.fn() };
});

describe("fetchFluidPools", () => {
  beforeEach(() => {
    vi.mocked(fetchEvmCallHexAtBlock).mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["liquidity_in_usd", "100000usd", 0, null, null],
    ["last_price", "1.01usd", 1, null, [0, 20.5]],
    ["base_volume", "10tokens", 1, 1.01, null],
    ["target_volume", "20tokens", 1, 1.01, null],
    ["last_price", " +1.01e0 ", 1, 1.01, [0, 20.5]],
  ] as const)("requires a complete decimal value for %s=%s", async (field, value, poolCount, price, volumes) => {
    const tickerRow = {
      pool_id: "0xabc0000000000000000000000000000000000000",
      base_currency: "0xbase", target_currency: "0xquote",
      liquidity_in_usd: "100000.25", last_price: "1.01",
      base_volume: "0", target_volume: "20.5", [field]: value,
    };
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", body: [tickerRow] },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });
    const result = await fetchFluidPools(undefined, new Map());
    expect(result.pools).toHaveLength(poolCount);
    if (poolCount === 1) {
      expect(result.pools[0]).toMatchObject({ tvlUsd: 100000.25, price, tokenVolumes24h: volumes });
    }
  });
  it.each([
    ["collateral-only", [10, 20, 0, 0], null, null, "debt"],
    ["debt-only", null, [0, 0, 30, 40, 0, 0], null, "collateral"],
    ["neither", null, null, null, "collateral and debt"],
    ["complete", [10, 20, 0, 0], [0, 0, 30, 40, 0, 0], [40, 60], null],
    ["zero collateral", [0, 0, 0, 0], [0, 0, 30, 40, 0, 0], [30, 40], null],
    ["zero debt", [10, 20, 0, 0], [0, 0, 0, 0, 0, 0], [10, 20], null],
    ["all zero", [0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0], null],
  ] as const)("admits only complete reserve captures (%s)", async (_label, collateral, debt, balances, missing) => {
    const encode = (words: readonly number[] | null): `0x${string}` | null =>
      words == null ? null : `0x${words.map((word) => BigInt(word).toString(16).padStart(64, "0")).join("")}`;
    vi.mocked(fetchEvmCallHexAtBlock).mockImplementation(async (_chain, _to, data) =>
      data.startsWith("0x957755e6") ? encode(collateral)
        : data.startsWith("0x55181f11") ? encode(debt) : encode([100]),
    );
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", body: [{
        pool_id: "0xabc0000000000000000000000000000000000000",
        base_currency: "0xbase", target_currency: "0xquote",
        liquidity_in_usd: "100000", last_price: "1", base_volume: "100", target_volume: "200",
      }] },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });
    const counters = initLiquidityFallbackCounters();
    const result = await fetchFluidPools(undefined, new Map(), counters);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      balances, tvlUsd: 100_000, tokenVolumes24h: [100, 200], volume24hUsd: null, feeRate: 0.0001,
    });
    expect(counters.fluidBalancesUnmeasured).toBe(missing == null ? 0 : 1);
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.errors).toEqual([]);
    if (missing != null) {
      expect(result.warnings).toEqual([expect.stringContaining(`${missing} reserves unavailable`)]);
      expect(result.pools[0]?.balancesNormalized).toBeUndefined();
    } else {
      expect(result.warnings).toEqual([]);
      expect(result.pools[0]?.balancesNormalized).toBe(false);
    }
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
    expect(ethPool!.volume24hUsd).toBeNull();
    expect(ethPool!.tokenVolumes24h).toEqual([100, 200]);
  });

  it("skips resolver enrichment for a large pool with unmeasured side volumes", async () => {
    const tickerRow = {
      pool_id: "0xabc0000000000000000000000000000000000000",
      base_currency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      target_currency: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      base_volume: "not-a-number",
      target_volume: "200",
      liquidity_in_usd: "150000000",
      last_price: "1.0001",
    };
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", body: [tickerRow] },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });

    const counters = initLiquidityFallbackCounters();
    const result = await fetchFluidPools(undefined, new Map(), counters);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]!.tokenVolumes24h).toBeNull();
    // An absent side-volume reading is unmeasured, not a zero: it cannot clear
    // the large-pool guard, so no resolver enrichment is attempted.
    expect(counters.fluidVolumeUnmeasured).toBe(1);
    expect(counters.fluidFeeRateUnmeasured).toBe(0);
    expect(counters.fluidBalancesUnmeasured).toBe(0);
  });

  it("enriches a large pool whose measured side volumes clear the guard", async () => {
    const tickerRow = {
      pool_id: "0xabc0000000000000000000000000000000000000",
      base_currency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      target_currency: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      base_volume: "90000000",
      target_volume: "80000000",
      liquidity_in_usd: "150000000",
      last_price: "1.0001",
    };
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", body: [tickerRow] },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });

    const counters = initLiquidityFallbackCounters();
    const result = await fetchFluidPools(undefined, new Map(), counters);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]!.tokenVolumes24h).toEqual([90000000, 80000000]);
    // Enrichment was attempted (no RPC configured, so neutral defaults survive).
    expect(counters.fluidVolumeUnmeasured).toBe(0);
    expect(counters.fluidFeeRateUnmeasured).toBe(1);
    expect(counters.fluidBalancesUnmeasured).toBe(1);
  });

  it("skips resolver enrichment for a large pool whose measured side volumes are below the guard", async () => {
    const tickerRow = {
      pool_id: "0xabc0000000000000000000000000000000000000",
      base_currency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      target_currency: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      base_volume: "100",
      target_volume: "200",
      liquidity_in_usd: "150000000",
      last_price: "1.0001",
    };
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", body: [tickerRow] },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });

    const counters = initLiquidityFallbackCounters();
    const result = await fetchFluidPools(undefined, new Map(), counters);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]!.tokenVolumes24h).toEqual([100, 200]);
    expect(counters.fluidVolumeUnmeasured).toBe(0);
    expect(counters.fluidFeeRateUnmeasured).toBe(0);
    expect(counters.fluidBalancesUnmeasured).toBe(0);
  });

  it("fails an over-cap chain as that chain's error instead of parsing a truncated ticker list", async () => {
    const tickerRow = {
      pool_id: "0xabc0000000000000000000000000000000000000",
      base_currency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      target_currency: "0xdac17f958d2fe523a2206206994597c13d831ec7",
      base_volume: "100",
      target_volume: "200",
      liquidity_in_usd: "50000000",
      last_price: "1.0001",
    };
    const encoder = new TextEncoder();
    const oversizedTickerPage = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // The valid head would be admitted as a pool if the cap were not enforced.
        controller.enqueue(encoder.encode(`[${JSON.stringify(tickerRow)},`));
        controller.enqueue(encoder.encode(" ".repeat(300 * 1024)));
        controller.enqueue(encoder.encode("]"));
        controller.close();
      },
    }), { status: 200 });
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", respond: oversizedTickerPage },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });

    const result = await fetchFluidPools(undefined, new Map());

    // The over-cap chain contributes no pools and names its own error; the other
    // five chains still publish their (empty) results.
    expect(result.pools).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.errors).toContain(`fluid ethereum response body exceeded ${256 * 1024} bytes`);
    expect(result.ok).toBe(true);
  });
});
