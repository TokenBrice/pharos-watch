import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { fetchBalancerPools } from "../dex-liquidity/fetch-balancer";
import { fetchFluidPools } from "../dex-liquidity/fetch-fluid";
import { fetchOrcaPools } from "../dex-liquidity/fetch-orca";
import { fetchRaydiumPools } from "../dex-liquidity/fetch-raydium";

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

function encodeRpcWords(words: Array<number | bigint>): string {
  return `0x${words.map((word) => BigInt(word).toString(16).padStart(64, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Fluid
// ---------------------------------------------------------------------------
describe("fetchFluidPools", () => {
  const FLUID_POOL_ADDRESS = "0x1111111111111111111111111111111111111111";

  afterEach(() => { mockFetch.mockReset(); });

  it("fetches all chains and normalizes to DexApiPool[]", async () => {
    mockJsonFetch([
      {
        ticker_id: "0xbase_0xquote",
        base_currency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        target_currency: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        last_price: "0.9999",
        base_volume: "100000",
        target_volume: "100000",
        pool_id: FLUID_POOL_ADDRESS,
        liquidity_in_usd: "500000",
      },
    ]);

    const pools = await fetchFluidPools();
    expect(pools.pools.length).toBeGreaterThan(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
    const pool = pools.pools[0];
    expect(pool.source).toBe("fluid");
    expect(pool.poolType).toBe("fluid-dex");
    expect(pool.tvlUsd).toBe(500000);
    expect(pool.price).toBeCloseTo(0.9999);
    expect(pool.tokens).toHaveLength(2);
  });

  it("hydrates balances and fee rate from the Fluid DexReservesResolver when available", async () => {
    mockFetch.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "https://api.fluid.instadapp.io/v2/1/dexes/stats/tickers") {
        return Promise.resolve(jsonResponse([
          {
            ticker_id: "0xbase_0xquote",
            base_currency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            target_currency: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            last_price: "0.9999",
            base_volume: "100000",
            target_volume: "100000",
            pool_id: FLUID_POOL_ADDRESS,
            liquidity_in_usd: "500000",
          },
        ]));
      }
      if (url.startsWith("https://api.fluid.instadapp.io/v2/")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes("ethereum-rpc.publicnode.com") || url.includes("eth.llamarpc.com")) {
        const body = String(init?.body ?? "");
        if (body.includes("0x957755e6")) {
          return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: encodeRpcWords([1_500_000, 500_000, 0, 0]) }));
        }
        if (body.includes("0x55181f11")) {
          return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: encodeRpcWords([0, 0, 500_000, 2_500_000, 0, 0]) }));
        }
        if (body.includes("0x42fcc6fb")) {
          return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: encodeRpcWords([100]) }));
        }
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const pools = await fetchFluidPools();
    expect(pools.pools[0].balances).toEqual([2000000, 3000000]);
    expect(pools.pools[0].feeRate).toBeCloseTo(0.0001);
  });

  it("uses provided chain RPCs for resolver enrichment", async () => {
    mockFetch.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "https://api.fluid.instadapp.io/v2/1/dexes/stats/tickers") {
        return Promise.resolve(jsonResponse([
          {
            ticker_id: "0xbase_0xquote",
            base_currency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            target_currency: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            last_price: "0.9999",
            base_volume: "100000",
            target_volume: "100000",
            pool_id: FLUID_POOL_ADDRESS,
            liquidity_in_usd: "500000",
          },
        ]));
      }
      if (url.startsWith("https://api.fluid.instadapp.io/v2/")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url === "https://rpc.example") {
        const body = String(init?.body ?? "");
        if (body.includes("0x957755e6")) {
          return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: encodeRpcWords([1_500_000, 500_000, 0, 0]) }));
        }
        if (body.includes("0x55181f11")) {
          return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: encodeRpcWords([0, 0, 500_000, 2_500_000, 0, 0]) }));
        }
        if (body.includes("0x42fcc6fb")) {
          return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: encodeRpcWords([100]) }));
        }
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const chainRpcs = new Map<string, ChainRpcConfig>([
      ["ethereum", {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://rpc.example",
        explorerUrl: "https://etherscan.io",
      }],
    ]);

    const pools = await fetchFluidPools(undefined, chainRpcs);

    expect(pools.pools[0].balances).toEqual([2000000, 3000000]);
    expect(mockFetch.mock.calls.some(([input]) => String(input) === "https://rpc.example")).toBe(true);
  });

  it("keeps Fluid source healthy when retained-pool enrichment fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockImplementation((input) => {
      const url = String(input);
      if (url === "https://api.fluid.instadapp.io/v2/1/dexes/stats/tickers") {
        return Promise.resolve(jsonResponse([
          {
            ticker_id: "0xbase_0xquote",
            base_currency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            target_currency: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            last_price: "0.9999",
            base_volume: "100000",
            target_volume: "100000",
            pool_id: FLUID_POOL_ADDRESS,
            liquidity_in_usd: "500000",
          },
        ]));
      }
      if (url.startsWith("https://api.fluid.instadapp.io/v2/")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url === "https://rpc.example") {
        return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: `0x${"z".repeat(64)}` }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const chainRpcs = new Map<string, ChainRpcConfig>([
      ["ethereum", {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://rpc.example",
        explorerUrl: "https://etherscan.io",
      }],
    ]);

    const pools = await fetchFluidPools(undefined, chainRpcs);

    expect(pools.pools.map((pool) => pool.poolAddress)).toEqual([FLUID_POOL_ADDRESS]);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
    expect(pools.errors).toEqual([]);
    expect(pools.warnings).toHaveLength(1);
    expect(pools.warnings?.[0]).toContain("enrichment failed");
    expect(warnSpy).toHaveBeenCalledWith("[fetch-fluid] Pool enrichment failed:", expect.any(String));
    warnSpy.mockRestore();
  });

  it("skips malformed Fluid pool IDs while preserving valid pools", async () => {
    const malformedPoolAddress = "not-a-20-byte-hex-address";
    mockFetch.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "https://api.fluid.instadapp.io/v2/1/dexes/stats/tickers") {
        return Promise.resolve(jsonResponse([
          {
            ticker_id: "0xbase_0xquote",
            base_currency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            target_currency: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            last_price: "0.9999",
            base_volume: "100000",
            target_volume: "100000",
            pool_id: FLUID_POOL_ADDRESS,
            liquidity_in_usd: "500000",
          },
          {
            ticker_id: "0xbroken_0xquote",
            base_currency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            target_currency: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            last_price: "1.0001",
            base_volume: "50000",
            target_volume: "50000",
            pool_id: malformedPoolAddress,
            liquidity_in_usd: "400000",
          },
        ]));
      }
      if (url.startsWith("https://api.fluid.instadapp.io/v2/")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url === "https://rpc.example") {
        const body = String(init?.body ?? "");
        if (body.includes("0x957755e6")) {
          return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: encodeRpcWords([1_500_000, 500_000, 0, 0]) }));
        }
        if (body.includes("0x55181f11")) {
          return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: encodeRpcWords([0, 0, 500_000, 2_500_000, 0, 0]) }));
        }
        if (body.includes("0x42fcc6fb")) {
          return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: encodeRpcWords([100]) }));
        }
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const chainRpcs = new Map<string, ChainRpcConfig>([
      ["ethereum", {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://rpc.example",
        explorerUrl: "https://etherscan.io",
      }],
    ]);

    const pools = await fetchFluidPools(undefined, chainRpcs);

    expect(pools.pools.map((pool) => pool.poolAddress)).toEqual([FLUID_POOL_ADDRESS]);
    expect(pools.pools[0].balances).toEqual([2000000, 3000000]);
    expect(pools.ok).toBe(true);
    // Cosmetic row-skip notes are warnings, not fetch-level degradation (w-dex:2).
    expect(pools.degraded).toBe(false);
    expect(pools.warnings?.[0]).toContain(malformedPoolAddress);
    expect(pools.warnings?.[0]).toContain("invalid EVM address");
    expect(mockFetch.mock.calls.filter(([input]) => String(input) === "https://rpc.example")).toHaveLength(3);
  });

  it("sets empty symbols and decimals=0 for tokens", async () => {
    mockJsonFetch([
      {
        ticker_id: "0xbase_0xquote",
        base_currency: "0xtoken1",
        target_currency: "0xtoken2",
        last_price: "1.0",
        base_volume: "50000",
        target_volume: "50000",
        pool_id: "0x2222222222222222222222222222222222222222",
        liquidity_in_usd: "200000",
      },
    ]);

    const pools = await fetchFluidPools();
    expect(pools.pools[0].tokens[0].symbol).toBe("");
    expect(pools.pools[0].tokens[0].decimals).toBe(0);
    expect(pools.pools[0].tokens[1].symbol).toBe("");
    expect(pools.pools[0].tokens[1].decimals).toBe(0);
  });

  it("approximates volume as sum of base and target volumes", async () => {
    mockJsonFetch([
      {
        ticker_id: "tid",
        base_currency: "0xa",
        target_currency: "0xb",
        last_price: "1.0",
        base_volume: "75000",
        target_volume: "25000",
        pool_id: "0x3333333333333333333333333333333333333333",
        liquidity_in_usd: "100000",
      },
    ]);

    const pools = await fetchFluidPools();
    // volume24hUsd is now 0 — raw token volumes are not summed as USD.
    // The downstream derivePoolVolume24hUsd path handles USD conversion via tokenVolumes24h.
    expect(pools.pools[0].volume24hUsd).toBe(0);
    expect(pools.pools[0].tokenVolumes24h).toEqual([75000, 25000]);
  });

  it("handles chain failure gracefully with Promise.allSettled", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("network error"))
      .mockImplementation(() => Promise.resolve(jsonResponse([])));

    const pools = await fetchFluidPools();
    // Should not throw — partial failure is OK
    expect(Array.isArray(pools.pools)).toBe(true);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(true);
  });

  it("returns empty array on complete failure", async () => {
    mockFetch.mockRejectedValue(new Error("all chains down"));
    const pools = await fetchFluidPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("skips tickers with zero or invalid TVL", async () => {
    mockJsonFetch([
      {
        ticker_id: "tid",
        base_currency: "0xa",
        target_currency: "0xb",
        last_price: "1.0",
        base_volume: "100",
        target_volume: "100",
        pool_id: "0x3333333333333333333333333333333333333333",
        liquidity_in_usd: "0",
      },
      {
        ticker_id: "tid2",
        base_currency: "0xc",
        target_currency: "0xd",
        last_price: "1.0",
        base_volume: "100",
        target_volume: "100",
        pool_id: "0x4444444444444444444444444444444444444444",
        liquidity_in_usd: "NaN",
      },
    ]);

    const pools = await fetchFluidPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
  });

  it("sets price to null for invalid prices", async () => {
    mockJsonFetch([
      {
        ticker_id: "tid",
        base_currency: "0xa",
        target_currency: "0xb",
        last_price: "not-a-number",
        base_volume: "100",
        target_volume: "100",
        pool_id: "0x3333333333333333333333333333333333333333",
        liquidity_in_usd: "100000",
      },
    ]);

    const pools = await fetchFluidPools();
    expect(pools.pools[0].price).toBeNull();
  });

  it("sets feeRate to null (Fluid API does not provide fee data)", async () => {
    mockJsonFetch([
      {
        ticker_id: "tid",
        base_currency: "0xa",
        target_currency: "0xb",
        last_price: "1.0",
        base_volume: "100",
        target_volume: "100",
        pool_id: "0x3333333333333333333333333333333333333333",
        liquidity_in_usd: "100000",
      },
    ]);

    const pools = await fetchFluidPools();
    expect(pools.pools[0].feeRate).toBeNull();
    expect(pools.pools[0].balances).toBeNull();
  });

  it("handles non-array response body", async () => {
    mockJsonFetch({ error: "bad request" });

    const pools = await fetchFluidPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("handles HTTP error status gracefully", async () => {
    mockTextFetch("Server Error", 500);

    const pools = await fetchFluidPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Balancer
// ---------------------------------------------------------------------------
describe("fetchBalancerPools", () => {
  afterEach(() => { mockFetch.mockReset(); });

  it("fetches stable pools and classifies pool type", async () => {
    mockJsonFetch({
      data: { poolGetPools: [{
        id: "0xpool",
        address: "0x0000000000000000000000000000000000000abc",
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
    expect(pools.pools.length).toBe(1);
    expect(pools.pools[0].source).toBe("balancer");
    expect(pools.pools[0].poolType).toBe("balancer-stable");
    expect(pools.pools[0].tvlUsd).toBe(1000000);
    expect(pools.pools[0].feeRate).toBeCloseTo(0.0001);
    expect(pools.pools[0].poolAddress).toBe("0x0000000000000000000000000000000000000abc");
    expect(pools.pools[0].balances).toEqual([500000, 500000]);
    expect(pools.pools[0].balancesNormalized).toBe(true);
  });

  it("uses the exact pool address exposed by the API instead of the 32-byte vault pool id", async () => {
    mockJsonFetch({
      data: { poolGetPools: [{
        id: "0x4e415957aa4fd703ad701e43ee5335d1d7891d8300020000000000000000053b",
        address: "0x4e415957aa4fd703ad701e43ee5335d1d7891d83",
        type: "STABLE",
        chain: "MAINNET",
        dynamicData: { totalLiquidity: "100000", volume24h: "1000", swapFee: "0.0001" },
        poolTokens: [
          { address: "0xa", symbol: "USDC", decimals: 6, balance: "50000", balanceUSD: "50000" },
          { address: "0xb", symbol: "USDT", decimals: 6, balance: "50000", balanceUSD: "50000" },
        ],
      }]},
    });

    const pools = await fetchBalancerPools();
    expect(pools.pools[0].poolAddress).toBe("0x4e415957aa4fd703ad701e43ee5335d1d7891d83");
  });

  it("classifies WEIGHTED pools correctly", async () => {
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
    expect(pools.pools[0].poolType).toBe("balancer-weighted");
  });

  it("classifies all stable pool variants as balancer-stable", async () => {
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
    expect(pools.pools).toHaveLength(stableTypes.length);
    for (const pool of pools.pools) {
      expect(pool.poolType).toBe("balancer-stable");
    }
  });

  it("derives per-token priceUsd from balanceUSD / balance", async () => {
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
    expect(pools.pools[0].tokens[0].priceUsd).toBeCloseTo(100050 / 100000);
    expect(pools.pools[0].tokens[1].priceUsd).toBeCloseTo(99950 / 99950);
  });

  it("sets token priceUsd to null when balance is zero", async () => {
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
    expect(pools.pools[0].tokens[0].priceUsd).toBeNull();
    expect(pools.pools[0].tokens[1].priceUsd).toBeCloseTo(1.0);
  });

  it("paginates through multiple pages", async () => {
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
    expect(pools.pools.length).toBe(1001);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("skips pools with unknown chain", async () => {
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
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
  });

  it("skips pools with zero TVL", async () => {
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
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
  });

  it("returns empty array when API returns error status", async () => {
    mockTextFetch("Internal Server Error", 500);
    const pools = await fetchBalancerPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("returns empty array when response has no poolGetPools", async () => {
    mockJsonFetch({ data: {} });
    const pools = await fetchBalancerPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("returns a degraded result when Balancer returns invalid JSON", async () => {
    mockFetch.mockResolvedValueOnce(new Response("{bad-json", { status: 200 }));

    const pools = await fetchBalancerPools();

    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
    expect(pools.errors[0]).toContain("invalid JSON");
  });

  it("returns a degraded result when Balancer returns a null root", async () => {
    mockFetch.mockResolvedValueOnce(new Response("null", { status: 200 }));

    const pools = await fetchBalancerPools();

    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
    expect(pools.errors[0]).toContain("non-object JSON root");
  });

  it("skips malformed Balancer pool rows while preserving valid rows from the same page", async () => {
    mockJsonFetch({
      data: { poolGetPools: [
        {
          id: "0xbroken",
          type: "STABLE",
          chain: "MAINNET",
          poolTokens: [
            { address: "0xa", symbol: "USDC", decimals: 6, balance: "50000", balanceUSD: "50000" },
          ],
        },
        {
          id: "0xvalid",
          type: "STABLE",
          chain: "MAINNET",
          dynamicData: { totalLiquidity: "100000", volume24h: "1000", swapFee: "0.0001" },
          poolTokens: [
            { address: "0xb", symbol: "USDT", decimals: 6, balance: "50000", balanceUSD: "50000" },
            { address: "0xc", symbol: "DAI", decimals: 18, balance: "50000", balanceUSD: "50000" },
          ],
        },
      ]},
    });

    const pools = await fetchBalancerPools();

    expect(pools.ok).toBe(true);
    // Cosmetic row-skip notes are warnings, not fetch-level degradation (w-dex:2).
    expect(pools.degraded).toBe(false);
    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0].poolAddress).toBe("0xvalid");
    expect(pools.warnings).toContain("page 1 skipped 1 malformed pool rows");
  });

  it("maps Balancer chain enums to internal chain names", async () => {
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
    expect(pools.pools[0].chain).toBe("ethereum");
    expect(pools.pools[1].chain).toBe("polygon");
  });
});

// ---------------------------------------------------------------------------
// Raydium
// ---------------------------------------------------------------------------
describe("fetchRaydiumPools", () => {
  afterEach(() => { mockFetch.mockReset(); });

  it("fetches concentrated pools and maps to DexApiPool", async () => {
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
    expect(pools.pools.length).toBe(1);
    expect(pools.pools[0].source).toBe("raydium");
    expect(pools.pools[0].poolType).toBe("raydium-clmm");
    expect(pools.pools[0].tvlUsd).toBe(42000000);
    expect(pools.pools[0].price).toBeCloseTo(0.9999);
    expect(pools.pools[0].balances).toEqual([20000000, 22000000]);
  });

  it("classifies standard pools as raydium-amm", async () => {
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
    const std = pools.pools.find((p) => p.poolType === "raydium-amm");
    expect(std).toBeDefined();
    expect(std?.balancesNormalized).toBe(true);
  });

  it("sets chain to solana for all pools", async () => {
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
    expect(pools.pools[0].chain).toBe("solana");
  });

  it("stops pagination when TVL drops below threshold", async () => {
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
    const clmm = pools.pools.filter((p) => p.poolType === "raydium-clmm");
    expect(clmm).toHaveLength(1);
    expect(clmm[0].tvlUsd).toBe(50000);
  });

  it("handles complete API failure gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const pools = await fetchRaydiumPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("handles HTTP error status", async () => {
    mockTextFetch("error", 503);
    const pools = await fetchRaydiumPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("handles malformed response body", async () => {
    mockJsonFetch({ success: true, data: null });
    const pools = await fetchRaydiumPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("preserves Raydium standard pools when concentrated returns invalid JSON", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("{bad-json", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
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
      }));

    const pools = await fetchRaydiumPools();

    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(true);
    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0].poolType).toBe("raydium-amm");
    expect(pools.errors.some((error) => error.includes("invalid JSON"))).toBe(true);
  });

  it("returns a degraded result when Raydium returns a null root", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(new Response("null", { status: 200 })));

    const pools = await fetchRaydiumPools();

    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
    expect(pools.errors.every((error) => error.includes("non-object JSON root"))).toBe(true);
  });

  it("skips malformed Raydium pool rows while preserving valid rows from the same page", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { count: 2, data: [
          {
            type: "Concentrated",
            id: "brokenPool",
            mintB: { address: "addr2", symbol: "USDT", decimals: 6 },
            price: 1.0,
            tvl: 100000,
            mintAmountA: 50000,
            mintAmountB: 50000,
            feeRate: 0.0001,
            day: { volume: 5000 },
          },
          {
            type: "Concentrated",
            id: "validPool",
            mintA: { address: "addr1", symbol: "USDC", decimals: 6 },
            mintB: { address: "addr2", symbol: "USDT", decimals: 6 },
            price: 1.0,
            tvl: 100000,
            mintAmountA: 50000,
            mintAmountB: 50000,
            feeRate: 0.0001,
            day: { volume: 5000 },
          },
        ]},
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { count: 0, data: [] },
      }));

    const pools = await fetchRaydiumPools();

    expect(pools.ok).toBe(true);
    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0].poolAddress).toBe("validPool");
  });

  it("sets price to null when pool price is zero", async () => {
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
    expect(pools.pools[0].price).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Orca
// ---------------------------------------------------------------------------
describe("fetchOrcaPools", () => {
  afterEach(() => { mockFetch.mockReset(); });

  it("fetches whirlpools and normalizes to DexApiPool", async () => {
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
    expect(pools.pools.length).toBe(1);
    expect(pools.pools[0].source).toBe("orca");
    expect(pools.pools[0].poolType).toBe("orca-whirlpool");
    expect(pools.pools[0].price).toBeCloseTo(0.9999184);
    expect(pools.pools[0].tvlUsd).toBeCloseTo(29901161.14);
    expect(pools.pools[0].feeRate).toBeCloseTo(0.0001); // 100 / 1_000_000
  });

  it("skips malformed Orca pool rows while preserving valid rows from the same page", async () => {
    mockJsonFetch({
      data: [
        {
          address: "brokenPoolMissingToken",
          price: "1.0",
          tvlUsdc: "100000",
          feeRate: 100,
          tokenB: { address: "mintB", symbol: "USDT", decimals: 6 },
          tokenBalanceA: "50000",
          tokenBalanceB: "50000",
          stats: { "24h": { volume: "1000" } },
        },
        {
          address: "brokenPoolBadDecimals",
          price: "1.0",
          tvlUsdc: "100000",
          feeRate: 100,
          tokenA: { address: "mintA", symbol: "USDC", decimals: "6" },
          tokenB: { address: "mintB", symbol: "USDT", decimals: 6 },
          tokenBalanceA: "50000",
          tokenBalanceB: "50000",
          stats: { "24h": { volume: "1000" } },
        },
        {
          address: "validPool",
          price: "1.0",
          tvlUsdc: "100000",
          feeRate: 100,
          tokenA: { address: "mintA", symbol: "USDC", decimals: 6 },
          tokenB: { address: "mintB", symbol: "USDT", decimals: 6 },
          tokenBalanceA: "50000",
          tokenBalanceB: "50000",
          stats: { "24h": { volume: "1000" } },
        },
      ],
      meta: { cursor: { next: null } },
    });

    const pools = await fetchOrcaPools();

    expect(pools.ok).toBe(true);
    // Cosmetic row-skip notes are warnings, not fetch-level degradation (w-dex:2).
    expect(pools.degraded).toBe(false);
    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0].poolAddress).toBe("validPool");
    expect(pools.warnings).toContain("page 1 skipped 2 malformed pool rows");
  });

  it("handles 429 rate limit gracefully", async () => {
    mockTextFetch("rate limited", 429);
    const pools = await fetchOrcaPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("normalizes feeRate by dividing by 1_000_000", async () => {
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
    expect(pools.pools[0].feeRate).toBeCloseTo(0.003);
  });

  it("sets chain to solana for all pools", async () => {
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
    expect(pools.pools[0].chain).toBe("solana");
  });

  it("follows cursor-based pagination", async () => {
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
    expect(pools.pools).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Second call should include the cursor
    const secondCallUrl = mockFetch.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain("next=cursor123");
  });

  it("refreshes the Orca head before resuming a durable tail cursor", async () => {
    const makePool = (address: string) => ({
      address,
      price: "1",
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
        data: [makePool("head")],
        meta: { cursor: { next: "fresh-head-tail" } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [makePool("stored-tail")],
        meta: { cursor: { next: null } },
      }));
    const writes: unknown[][] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...binds: unknown[]) => ({
          first: vi.fn(async () => sql.includes("SELECT cursor")
            ? {
                cursor: "stored-cursor",
                cycle_started_at: 100,
                updated_at: 110,
                completed_at: null,
                pages_fetched: 4,
              }
            : null),
          run: vi.fn(async () => {
            writes.push(binds);
            return { meta: { changes: 1 } };
          }),
        })),
      })),
    } as unknown as D1Database;

    const result = await fetchOrcaPools(undefined, db);

    expect(String(mockFetch.mock.calls[0][0])).toContain("sortBy=tvl");
    expect(String(mockFetch.mock.calls[1][0])).toContain("next=stored-cursor");
    expect(result.pools.map((pool) => pool.poolAddress)).toEqual(["head", "stored-tail"]);
    expect(result.pagination).toMatchObject({ state: "complete", headRefreshed: true, cycleCompleted: true });
    expect(writes[0]?.[1]).toBe("fresh-head-tail");
  });

  it("degrades on cursor write failure and retries the stored tail next run", async () => {
    const makePool = (address: string) => ({
      address,
      price: "1",
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
        data: [makePool("head-1")],
        meta: { cursor: { next: "fresh-head-tail-1" } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [makePool("tail-1")],
        meta: { cursor: { next: null } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [makePool("head-2")],
        meta: { cursor: { next: "fresh-head-tail-2" } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [makePool("tail-2")],
        meta: { cursor: { next: null } },
      }));

    let storedCursor = "stored-tail";
    let writeAttempts = 0;
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...binds: unknown[]) => ({
          first: vi.fn(async () => sql.includes("SELECT cursor")
            ? {
                cursor: storedCursor,
                cycle_started_at: 100,
                updated_at: 110,
                completed_at: null,
                pages_fetched: 4,
              }
            : null),
          run: vi.fn(async () => {
            writeAttempts++;
            if (writeAttempts === 1) throw new Error("cursor write unavailable");
            storedCursor = String(binds[1]);
            return { success: true, meta: { changes: 1 } };
          }),
        })),
      })),
    } as unknown as D1Database;

    const failedWrite = await fetchOrcaPools(undefined, db);
    const retriedWrite = await fetchOrcaPools(undefined, db);

    expect(failedWrite).toMatchObject({ ok: true, degraded: true });
    expect(failedWrite.warnings).toContain(
      "orca: pagination cursor persistence failed (write-failed); stored cursor remains retryable",
    );
    expect(failedWrite.pagination?.cursorPersistence).toEqual({
      attempts: 1,
      written: 0,
      failures: [{ sourceKey: "orca:solana", errorClass: "write-failed" }],
    });
    expect(retriedWrite).toMatchObject({ ok: true, degraded: false });
    expect(retriedWrite.pagination?.cursorPersistence).toEqual({
      attempts: 1,
      written: 1,
      failures: [],
    });
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("next=stored-tail");
    expect(String(mockFetch.mock.calls[3]?.[0])).toContain("next=stored-tail");
    expect(storedCursor).toBe("fresh-head-tail-2");
  });

  it("preserves a far-tail cursor across a transient failure and retries it next run", async () => {
    const makePool = (address: string) => ({
      address,
      price: "1",
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
        data: [makePool("head-1")],
        meta: { cursor: { next: "fresh-head-tail-1" } },
      }))
      .mockResolvedValueOnce(new Response("temporary upstream failure", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({
        data: [makePool("head-2")],
        meta: { cursor: { next: "fresh-head-tail-2" } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [makePool("far-tail-retry")],
        meta: { cursor: { next: null } },
      }));

    let storedCursor = "far-tail-cursor";
    const persistedCursors: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...binds: unknown[]) => ({
          first: vi.fn(async () => sql.includes("SELECT cursor")
            ? {
                cursor: storedCursor,
                cycle_started_at: 100,
                updated_at: 110,
                completed_at: null,
                pages_fetched: 4,
              }
            : null),
          run: vi.fn(async () => {
            storedCursor = String(binds[1]);
            persistedCursors.push(storedCursor);
            return { success: true, meta: { changes: 1 } };
          }),
        })),
      })),
    } as unknown as D1Database;

    const transientFailure = await fetchOrcaPools(undefined, db);
    const retriedTail = await fetchOrcaPools(undefined, db);

    expect(transientFailure).toMatchObject({ ok: true, degraded: true });
    expect(transientFailure.pagination).toMatchObject({
      state: "partial",
      cursor: "far-tail-cursor",
      cycleCompleted: false,
    });
    expect(retriedTail).toMatchObject({ ok: true, degraded: false });
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("next=far-tail-cursor");
    expect(String(mockFetch.mock.calls[3]?.[0])).toContain("next=far-tail-cursor");
    expect(persistedCursors).toEqual(["far-tail-cursor", "fresh-head-tail-2"]);
  });

  it("resets a tail only when the API explicitly rejects its cursor", async () => {
    const pool = {
      address: "head",
      price: "1",
      tvlUsdc: "100000",
      feeRate: 100,
      tokenA: { address: "mintA", symbol: "USDC", decimals: 6 },
      tokenB: { address: "mintB", symbol: "USDT", decimals: 6 },
      tokenBalanceA: "50000",
      tokenBalanceB: "50000",
      stats: { "24h": { volume: "1000" } },
    };
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        data: [pool],
        meta: { cursor: { next: "fresh-head-tail" } },
      }))
      .mockResolvedValueOnce(new Response("expired cursor", { status: 404 }));
    const writes: unknown[][] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...binds: unknown[]) => ({
          first: vi.fn(async () => sql.includes("SELECT cursor")
            ? {
                cursor: "expired-tail",
                cycle_started_at: 100,
                updated_at: 110,
                completed_at: null,
                pages_fetched: 4,
              }
            : null),
          run: vi.fn(async () => {
            writes.push(binds);
            return { success: true, meta: { changes: 1 } };
          }),
        })),
      })),
    } as unknown as D1Database;

    const result = await fetchOrcaPools(undefined, db);

    expect(result.pagination).toMatchObject({ state: "partial", cursor: "fresh-head-tail" });
    expect(result.errors).toContain("API rejected tail cursor (404); restarting from refreshed head");
    expect(writes[0]?.[1]).toBe("fresh-head-tail");
  });

  it("stops pagination on 429 mid-pagination and returns partial results", async () => {
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
    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0].poolAddress).toBe("pool1");
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(true);
  });

  it("skips pools below TVL threshold", async () => {
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
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(true);
  });

  it("returns empty array on HTTP error", async () => {
    mockTextFetch("error", 500);
    const pools = await fetchOrcaPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(false);
    expect(pools.degraded).toBe(true);
  });

  it("returns empty array when data is empty", async () => {
    mockJsonFetch({
      data: [],
      meta: { cursor: { next: null } },
    });
    const pools = await fetchOrcaPools();
    expect(pools.pools).toHaveLength(0);
    expect(pools.ok).toBe(true);
    expect(pools.degraded).toBe(false);
  });

  it("parses string token balances correctly", async () => {
    mockJsonFetch({
      data: [{
        address: "pool1",
        price: "0.9998",
        tvlUsdc: "500000",
        feeRate: 100,
        tokenA: { address: "mintA", symbol: "PYUSD", decimals: 6 },
        tokenB: { address: "mintB", symbol: "USDC", decimals: 6 },
        tokenBalanceA: "250000500000",
        tokenBalanceB: "249999500000",
        stats: { "24h": { volume: "10000" } },
      }],
      meta: { cursor: { next: null } },
    });

    const pools = await fetchOrcaPools();
    expect(pools.pools[0].balances).toEqual([250000.5, 249999.5]);
  });

  it("sets price to null for invalid price strings", async () => {
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
    expect(pools.pools[0].price).toBeNull();
  });
});
