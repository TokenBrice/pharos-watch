import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/abort", async () => {
  const actual = await vi.importActual<typeof import("../../lib/abort")>("../../lib/abort");
  return {
    ...actual,
    sleepWithSignal: vi.fn(async () => {}),
  };
});

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockJsonFetch(body: unknown, status = 200): void {
  mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
}

function mockTextFetch(body: string, status: number): void {
  mockFetch.mockImplementation(() => Promise.resolve(new Response(body, { status })));
}

// ---------------------------------------------------------------------------
// Fluid
// ---------------------------------------------------------------------------
describe("fetchFluidPools", () => {
  afterEach(() => { mockFetch.mockReset(); vi.resetModules(); });

  it("fetches all chains and normalizes to DexApiPool[]", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockJsonFetch([
      {
        ticker_id: "0xbase_0xquote",
        base_currency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        target_currency: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        last_price: "0.9999",
        base_volume: "100000",
        target_volume: "100000",
        pool_id: "0xPoolAddr",
        liquidity_in_usd: "500000",
      },
    ]);

    const pools = await fetchFluidPools();
    expect(pools.length).toBeGreaterThan(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
    const pool = pools[0];
    expect(pool.source).toBe("fluid");
    expect(pool.poolType).toBe("fluid-dex");
    expect(pool.tvlUsd).toBe(500000);
    expect(pool.price).toBeCloseTo(0.9999);
    expect(pool.tokens).toHaveLength(2);
  });

  it("sets empty symbols and decimals=0 for tokens", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockJsonFetch([
      {
        ticker_id: "0xbase_0xquote",
        base_currency: "0xtoken1",
        target_currency: "0xtoken2",
        last_price: "1.0",
        base_volume: "50000",
        target_volume: "50000",
        pool_id: "0xpool",
        liquidity_in_usd: "200000",
      },
    ]);

    const pools = await fetchFluidPools();
    expect(pools[0].tokens[0].symbol).toBe("");
    expect(pools[0].tokens[0].decimals).toBe(0);
    expect(pools[0].tokens[1].symbol).toBe("");
    expect(pools[0].tokens[1].decimals).toBe(0);
  });

  it("approximates volume as sum of base and target volumes", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockJsonFetch([
      {
        ticker_id: "tid",
        base_currency: "0xa",
        target_currency: "0xb",
        last_price: "1.0",
        base_volume: "75000",
        target_volume: "25000",
        pool_id: "0xp",
        liquidity_in_usd: "100000",
      },
    ]);

    const pools = await fetchFluidPools();
    expect(pools[0].volume24hUsd).toBe(100000);
  });

  it("handles chain failure gracefully with Promise.allSettled", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockFetch
      .mockRejectedValueOnce(new Error("network error"))
      .mockImplementation(() => Promise.resolve(jsonResponse([])));

    const pools = await fetchFluidPools();
    // Should not throw — partial failure is OK
    expect(Array.isArray(pools)).toBe(true);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(true);
  });

  it("returns empty array on complete failure", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockFetch.mockRejectedValue(new Error("all chains down"));
    const pools = await fetchFluidPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("skips tickers with zero or invalid TVL", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockJsonFetch([
      {
        ticker_id: "tid",
        base_currency: "0xa",
        target_currency: "0xb",
        last_price: "1.0",
        base_volume: "100",
        target_volume: "100",
        pool_id: "0xp",
        liquidity_in_usd: "0",
      },
      {
        ticker_id: "tid2",
        base_currency: "0xc",
        target_currency: "0xd",
        last_price: "1.0",
        base_volume: "100",
        target_volume: "100",
        pool_id: "0xp2",
        liquidity_in_usd: "NaN",
      },
    ]);

    const pools = await fetchFluidPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
  });

  it("sets price to null for invalid prices", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockJsonFetch([
      {
        ticker_id: "tid",
        base_currency: "0xa",
        target_currency: "0xb",
        last_price: "not-a-number",
        base_volume: "100",
        target_volume: "100",
        pool_id: "0xp",
        liquidity_in_usd: "100000",
      },
    ]);

    const pools = await fetchFluidPools();
    expect(pools[0].price).toBeNull();
  });

  it("sets feeRate to null (Fluid API does not provide fee data)", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockJsonFetch([
      {
        ticker_id: "tid",
        base_currency: "0xa",
        target_currency: "0xb",
        last_price: "1.0",
        base_volume: "100",
        target_volume: "100",
        pool_id: "0xp",
        liquidity_in_usd: "100000",
      },
    ]);

    const pools = await fetchFluidPools();
    expect(pools[0].feeRate).toBeNull();
    expect(pools[0].balances).toBeNull();
  });

  it("handles non-array response body", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockJsonFetch({ error: "bad request" });

    const pools = await fetchFluidPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("handles HTTP error status gracefully", async () => {
    const { fetchFluidPools } = await import("../dex-liquidity/fetch-fluid");
    mockTextFetch("Server Error", 500);

    const pools = await fetchFluidPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Balancer
// ---------------------------------------------------------------------------
describe("fetchBalancerPools", () => {
  afterEach(() => { mockFetch.mockReset(); vi.resetModules(); });

  it("fetches stable pools and classifies pool type", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    mockJsonFetch({
      data: { poolGetPools: [{
        id: "0xpool",
        type: "STABLE",
        chain: "MAINNET",
        dynamicData: { totalLiquidity: "1000000", volume24h: "50000", swapFee: "0.0001" },
        poolTokens: [
          { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, balance: "500000", balanceUSD: "500000" },
          { address: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f", symbol: "GHO", decimals: 18, balance: "500000", balanceUSD: "500000" },
        ],
      }]},
    });

    const pools = await fetchBalancerPools();
    expect(pools.length).toBe(1);
    expect(pools[0].source).toBe("balancer");
    expect(pools[0].poolType).toBe("balancer-stable");
    expect(pools[0].tvlUsd).toBe(1000000);
    expect(pools[0].feeRate).toBeCloseTo(0.0001);
    expect(pools[0].balances).toEqual([500000, 500000]);
  });

  it("classifies WEIGHTED pools correctly", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    mockJsonFetch({
      data: { poolGetPools: [{
        id: "0xweighted",
        type: "WEIGHTED",
        chain: "ARBITRUM",
        dynamicData: { totalLiquidity: "200000", volume24h: "10000", swapFee: "0.003" },
        poolTokens: [
          { address: "0xtoken1", symbol: "USDC", decimals: 6, balance: "100000", balanceUSD: "100000" },
          { address: "0xtoken2", symbol: "WETH", decimals: 18, balance: "50", balanceUSD: "100000" },
        ],
      }]},
    });

    const pools = await fetchBalancerPools();
    expect(pools[0].poolType).toBe("balancer-weighted");
  });

  it("classifies all stable pool variants as balancer-stable", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    const stableTypes = ["STABLE", "COMPOSABLE_STABLE", "META_STABLE", "PHANTOM_STABLE", "GYRO", "GYROE"];
    const poolData = stableTypes.map((type, i) => ({
      id: `0xpool${i}`,
      type,
      chain: "MAINNET",
      dynamicData: { totalLiquidity: "100000", volume24h: "1000", swapFee: "0.0001" },
      poolTokens: [
        { address: `0xtoken${i}a`, symbol: "USDC", decimals: 6, balance: "50000", balanceUSD: "50000" },
        { address: `0xtoken${i}b`, symbol: "USDT", decimals: 6, balance: "50000", balanceUSD: "50000" },
      ],
    }));

    mockJsonFetch({ data: { poolGetPools: poolData } });

    const pools = await fetchBalancerPools();
    expect(pools).toHaveLength(stableTypes.length);
    for (const pool of pools) {
      expect(pool.poolType).toBe("balancer-stable");
    }
  });

  it("derives per-token priceUsd from balanceUSD / balance", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    mockJsonFetch({
      data: { poolGetPools: [{
        id: "0xpool",
        type: "STABLE",
        chain: "MAINNET",
        dynamicData: { totalLiquidity: "200000", volume24h: "5000", swapFee: "0.0001" },
        poolTokens: [
          { address: "0xa", symbol: "USDC", decimals: 6, balance: "100000", balanceUSD: "100050" },
          { address: "0xb", symbol: "DAI", decimals: 18, balance: "99950", balanceUSD: "99950" },
        ],
      }]},
    });

    const pools = await fetchBalancerPools();
    expect(pools[0].tokens[0].priceUsd).toBeCloseTo(100050 / 100000);
    expect(pools[0].tokens[1].priceUsd).toBeCloseTo(99950 / 99950);
  });

  it("sets token priceUsd to null when balance is zero", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    mockJsonFetch({
      data: { poolGetPools: [{
        id: "0xpool",
        type: "STABLE",
        chain: "MAINNET",
        dynamicData: { totalLiquidity: "50000", volume24h: "0", swapFee: "0.0001" },
        poolTokens: [
          { address: "0xa", symbol: "USDC", decimals: 6, balance: "0", balanceUSD: "0" },
          { address: "0xb", symbol: "DAI", decimals: 18, balance: "50000", balanceUSD: "50000" },
        ],
      }]},
    });

    const pools = await fetchBalancerPools();
    expect(pools[0].tokens[0].priceUsd).toBeNull();
    expect(pools[0].tokens[1].priceUsd).toBeCloseTo(1.0);
  });

  it("paginates through multiple pages", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    // Page 1: full page (1000 items)
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `0xpool${i}`,
      type: "STABLE",
      chain: "MAINNET",
      dynamicData: { totalLiquidity: "100000", volume24h: "1000", swapFee: "0.0001" },
      poolTokens: [
        { address: `0xa${i}`, symbol: "USDC", decimals: 6, balance: "50000", balanceUSD: "50000" },
        { address: `0xb${i}`, symbol: "USDT", decimals: 6, balance: "50000", balanceUSD: "50000" },
      ],
    }));
    // Page 2: partial page (1 item) — signals end
    const page2 = [{
      id: "0xpoolLast",
      type: "WEIGHTED",
      chain: "BASE",
      dynamicData: { totalLiquidity: "50000", volume24h: "500", swapFee: "0.003" },
      poolTokens: [
        { address: "0xlast1", symbol: "USDC", decimals: 6, balance: "25000", balanceUSD: "25000" },
        { address: "0xlast2", symbol: "WETH", decimals: 18, balance: "10", balanceUSD: "25000" },
      ],
    }];

    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { poolGetPools: page1 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { poolGetPools: page2 } })));

    const pools = await fetchBalancerPools();
    expect(pools.length).toBe(1001);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("skips pools with unknown chain", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    mockJsonFetch({
      data: { poolGetPools: [{
        id: "0xpool",
        type: "STABLE",
        chain: "UNKNOWN_CHAIN",
        dynamicData: { totalLiquidity: "100000", volume24h: "1000", swapFee: "0.0001" },
        poolTokens: [
          { address: "0xa", symbol: "USDC", decimals: 6, balance: "50000", balanceUSD: "50000" },
        ],
      }]},
    });

    const pools = await fetchBalancerPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
  });

  it("skips pools with zero TVL", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    mockJsonFetch({
      data: { poolGetPools: [{
        id: "0xpool",
        type: "STABLE",
        chain: "MAINNET",
        dynamicData: { totalLiquidity: "0", volume24h: "0", swapFee: "0.0001" },
        poolTokens: [
          { address: "0xa", symbol: "USDC", decimals: 6, balance: "0", balanceUSD: "0" },
        ],
      }]},
    });

    const pools = await fetchBalancerPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
  });

  it("returns empty array when API returns error status", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    mockTextFetch("Internal Server Error", 500);
    const pools = await fetchBalancerPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("returns empty array when response has no poolGetPools", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    mockJsonFetch({ data: {} });
    const pools = await fetchBalancerPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("maps Balancer chain enums to internal chain names", async () => {
    const { fetchBalancerPools } = await import("../dex-liquidity/fetch-balancer");
    mockJsonFetch({
      data: { poolGetPools: [
        {
          id: "0xp1", type: "STABLE", chain: "MAINNET",
          dynamicData: { totalLiquidity: "100000", volume24h: "0", swapFee: "0.0001" },
          poolTokens: [{ address: "0xa", symbol: "X", decimals: 6, balance: "50000", balanceUSD: "50000" }],
        },
        {
          id: "0xp2", type: "STABLE", chain: "POLYGON",
          dynamicData: { totalLiquidity: "100000", volume24h: "0", swapFee: "0.0001" },
          poolTokens: [{ address: "0xb", symbol: "Y", decimals: 6, balance: "50000", balanceUSD: "50000" }],
        },
      ]},
    });

    const pools = await fetchBalancerPools();
    expect(pools[0].chain).toBe("ethereum");
    expect(pools[1].chain).toBe("polygon");
  });
});

// ---------------------------------------------------------------------------
// Raydium
// ---------------------------------------------------------------------------
describe("fetchRaydiumPools", () => {
  afterEach(() => { mockFetch.mockReset(); vi.resetModules(); });

  it("fetches concentrated pools and maps to DexApiPool", async () => {
    const { fetchRaydiumPools } = await import("../dex-liquidity/fetch-raydium");
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { count: 1, data: [{
          type: "Concentrated",
          id: "poolAddr1",
          mintA: { address: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", symbol: "USDS", decimals: 6 },
          mintB: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
          price: 0.9999,
          tvl: 42000000,
          mintAmountA: 20000000,
          mintAmountB: 22000000,
          feeRate: 0.0001,
          day: { volume: 2000000 },
        }]},
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { count: 0, data: [] },
      }));

    const pools = await fetchRaydiumPools();
    expect(pools.length).toBe(1);
    expect(pools[0].source).toBe("raydium");
    expect(pools[0].poolType).toBe("raydium-clmm");
    expect(pools[0].tvlUsd).toBe(42000000);
    expect(pools[0].price).toBeCloseTo(0.9999);
    expect(pools[0].balances).toEqual([20000000, 22000000]);
  });

  it("classifies standard pools as raydium-amm", async () => {
    const { fetchRaydiumPools } = await import("../dex-liquidity/fetch-raydium");
    // First call for concentrated returns empty, second for standard returns pool
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { count: 0, data: [] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { count: 1, data: [{
          type: "Standard",
          id: "stdPool",
          mintA: { address: "addr1", symbol: "USDC", decimals: 6 },
          mintB: { address: "addr2", symbol: "USDT", decimals: 6 },
          price: 1.0001,
          tvl: 100000,
          mintAmountA: 50000,
          mintAmountB: 50000,
          feeRate: 0.0025,
          day: { volume: 5000 },
        }]},
      })));

    const pools = await fetchRaydiumPools();
    const std = pools.find((p) => p.poolType === "raydium-amm");
    expect(std).toBeDefined();
  });

  it("sets chain to solana for all pools", async () => {
    const { fetchRaydiumPools } = await import("../dex-liquidity/fetch-raydium");
    mockJsonFetch({
      success: true,
      data: { count: 1, data: [{
        type: "Concentrated",
        id: "pool1",
        mintA: { address: "addr1", symbol: "USDC", decimals: 6 },
        mintB: { address: "addr2", symbol: "USDT", decimals: 6 },
        price: 1.0,
        tvl: 500000,
        mintAmountA: 250000,
        mintAmountB: 250000,
        feeRate: 0.0001,
        day: { volume: 10000 },
      }]},
    });

    const pools = await fetchRaydiumPools();
    expect(pools[0].chain).toBe("solana");
  });

  it("stops pagination when TVL drops below threshold", async () => {
    const { fetchRaydiumPools } = await import("../dex-liquidity/fetch-raydium");
    mockJsonFetch({
      success: true,
      data: { count: 2, data: [
        {
          type: "Concentrated", id: "pool1",
          mintA: { address: "a1", symbol: "USDC", decimals: 6 },
          mintB: { address: "b1", symbol: "USDT", decimals: 6 },
          price: 1.0, tvl: 50000, mintAmountA: 25000, mintAmountB: 25000,
          feeRate: 0.0001, day: { volume: 1000 },
        },
        {
          type: "Concentrated", id: "pool2",
          mintA: { address: "a2", symbol: "USDC", decimals: 6 },
          mintB: { address: "b2", symbol: "DAI", decimals: 18 },
          price: 1.0, tvl: 5000, mintAmountA: 2500, mintAmountB: 2500,
          feeRate: 0.0001, day: { volume: 100 },
        },
      ]},
    });

    const pools = await fetchRaydiumPools();
    // Only the first pool (50K TVL >= 10K threshold) is included;
    // second pool (5K) triggers the threshold break
    const clmm = pools.filter((p) => p.poolType === "raydium-clmm");
    expect(clmm).toHaveLength(1);
    expect(clmm[0].tvlUsd).toBe(50000);
  });

  it("handles complete API failure gracefully", async () => {
    const { fetchRaydiumPools } = await import("../dex-liquidity/fetch-raydium");
    mockFetch.mockRejectedValue(new Error("network error"));
    const pools = await fetchRaydiumPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("handles HTTP error status", async () => {
    const { fetchRaydiumPools } = await import("../dex-liquidity/fetch-raydium");
    mockTextFetch("error", 503);
    const pools = await fetchRaydiumPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("handles malformed response body", async () => {
    const { fetchRaydiumPools } = await import("../dex-liquidity/fetch-raydium");
    mockJsonFetch({ success: true, data: null });
    const pools = await fetchRaydiumPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("sets price to null when pool price is zero", async () => {
    const { fetchRaydiumPools } = await import("../dex-liquidity/fetch-raydium");
    mockJsonFetch({
      success: true,
      data: { count: 1, data: [{
        type: "Concentrated", id: "pool1",
        mintA: { address: "a", symbol: "X", decimals: 6 },
        mintB: { address: "b", symbol: "Y", decimals: 6 },
        price: 0, tvl: 100000, mintAmountA: 50000, mintAmountB: 50000,
        feeRate: 0.001, day: { volume: 1000 },
      }]},
    });

    const pools = await fetchRaydiumPools();
    expect(pools[0].price).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Orca
// ---------------------------------------------------------------------------
describe("fetchOrcaPools", () => {
  afterEach(() => { mockFetch.mockReset(); vi.resetModules(); });

  it("fetches whirlpools and normalizes to DexApiPool", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockJsonFetch({
      data: [{
        address: "9tXiuRRw7kbejLhZXtxDxYs2REe43uH2e7k1kocgdM9B",
        price: "0.99991840037040574739",
        tvlUsdc: "29901161.1424620915653082",
        feeRate: 100,
        tokenA: { address: "mint1", symbol: "PYUSD", decimals: 6 },
        tokenB: { address: "mint2", symbol: "USDC", decimals: 6 },
        tokenBalanceA: "17723442437577",
        tokenBalanceB: "12182931105377",
        stats: { "24h": { volume: "1635006.18" } },
      }],
      meta: { cursor: { next: null } },
    });

    const pools = await fetchOrcaPools();
    expect(pools.length).toBe(1);
    expect(pools[0].source).toBe("orca");
    expect(pools[0].poolType).toBe("orca-whirlpool");
    expect(pools[0].price).toBeCloseTo(0.9999184);
    expect(pools[0].tvlUsd).toBeCloseTo(29901161.14);
    expect(pools[0].feeRate).toBeCloseTo(0.0001); // 100 / 1_000_000
  });

  it("handles 429 rate limit gracefully", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockTextFetch("rate limited", 429);
    const pools = await fetchOrcaPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("normalizes feeRate by dividing by 1_000_000", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockJsonFetch({
      data: [{
        address: "pool1",
        price: "1.0",
        tvlUsdc: "100000",
        feeRate: 3000, // 3000 / 1_000_000 = 0.003 (30bps)
        tokenA: { address: "mintA", symbol: "USDC", decimals: 6 },
        tokenB: { address: "mintB", symbol: "USDT", decimals: 6 },
        tokenBalanceA: "50000",
        tokenBalanceB: "50000",
        stats: { "24h": { volume: "5000" } },
      }],
      meta: { cursor: { next: null } },
    });

    const pools = await fetchOrcaPools();
    expect(pools[0].feeRate).toBeCloseTo(0.003);
  });

  it("sets chain to solana for all pools", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockJsonFetch({
      data: [{
        address: "pool1",
        price: "1.0",
        tvlUsdc: "100000",
        feeRate: 100,
        tokenA: { address: "mintA", symbol: "USDC", decimals: 6 },
        tokenB: { address: "mintB", symbol: "USDT", decimals: 6 },
        tokenBalanceA: "50000",
        tokenBalanceB: "50000",
        stats: { "24h": { volume: "1000" } },
      }],
      meta: { cursor: { next: null } },
    });

    const pools = await fetchOrcaPools();
    expect(pools[0].chain).toBe("solana");
  });

  it("follows cursor-based pagination", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    const makePool = (addr: string) => ({
      address: addr,
      price: "1.0",
      tvlUsdc: "100000",
      feeRate: 100,
      tokenA: { address: "mintA", symbol: "USDC", decimals: 6 },
      tokenB: { address: "mintB", symbol: "USDT", decimals: 6 },
      tokenBalanceA: "50000",
      tokenBalanceB: "50000",
      stats: { "24h": { volume: "1000" } },
    });

    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        data: [makePool("pool1")],
        meta: { cursor: { next: "cursor123" } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [makePool("pool2")],
        meta: { cursor: { next: null } },
      }));

    const pools = await fetchOrcaPools();
    expect(pools).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Second call should include the cursor
    const secondCallUrl = mockFetch.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain("next=cursor123");
  });

  it("stops pagination on 429 mid-pagination and returns partial results", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          address: "pool1",
          price: "1.0",
          tvlUsdc: "100000",
          feeRate: 100,
          tokenA: { address: "mintA", symbol: "USDC", decimals: 6 },
          tokenB: { address: "mintB", symbol: "USDT", decimals: 6 },
          tokenBalanceA: "50000",
          tokenBalanceB: "50000",
          stats: { "24h": { volume: "1000" } },
        }],
        meta: { cursor: { next: "cursor456" } },
      }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    const pools = await fetchOrcaPools();
    expect(pools).toHaveLength(1);
    expect(pools[0].poolAddress).toBe("pool1");
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(true);
  });

  it("skips pools below TVL threshold", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockJsonFetch({
      data: [{
        address: "pool1",
        price: "1.0",
        tvlUsdc: "5000", // below 10K threshold
        feeRate: 100,
        tokenA: { address: "mintA", symbol: "USDC", decimals: 6 },
        tokenB: { address: "mintB", symbol: "USDT", decimals: 6 },
        tokenBalanceA: "2500",
        tokenBalanceB: "2500",
        stats: { "24h": { volume: "100" } },
      }],
      meta: { cursor: { next: null } },
    });

    const pools = await fetchOrcaPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
  });

  it("returns empty array on HTTP error", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockTextFetch("error", 500);
    const pools = await fetchOrcaPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("returns empty array when data is empty", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockJsonFetch({
      data: [],
      meta: { cursor: { next: null } },
    });
    const pools = await fetchOrcaPools();
    expect(pools).toHaveLength(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
  });

  it("parses string token balances correctly", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockJsonFetch({
      data: [{
        address: "pool1",
        price: "0.9998",
        tvlUsdc: "500000",
        feeRate: 100,
        tokenA: { address: "mintA", symbol: "PYUSD", decimals: 6 },
        tokenB: { address: "mintB", symbol: "USDC", decimals: 6 },
        tokenBalanceA: "250000.5",
        tokenBalanceB: "249999.5",
        stats: { "24h": { volume: "10000" } },
      }],
      meta: { cursor: { next: null } },
    });

    const pools = await fetchOrcaPools();
    expect(pools[0].balances).toEqual([250000.5, 249999.5]);
  });

  it("sets price to null for invalid price strings", async () => {
    const { fetchOrcaPools } = await import("../dex-liquidity/fetch-orca");
    mockJsonFetch({
      data: [{
        address: "pool1",
        price: "invalid",
        tvlUsdc: "100000",
        feeRate: 100,
        tokenA: { address: "mintA", symbol: "USDC", decimals: 6 },
        tokenB: { address: "mintB", symbol: "USDT", decimals: 6 },
        tokenBalanceA: "50000",
        tokenBalanceB: "50000",
        stats: { "24h": { volume: "1000" } },
      }],
      meta: { cursor: { next: null } },
    });

    const pools = await fetchOrcaPools();
    expect(pools[0].price).toBeNull();
  });
});
