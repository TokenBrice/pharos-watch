import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBalancerPools } from "../fetch-balancer";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function cleanPool() {
  return {
    id: "0xaabbccddeeff00112233445566778899aabbccdd000200000000000000000001",
    type: "STABLE",
    chain: "MAINNET",
    address: "0xaabbccddeeff00112233445566778899aabbccdd",
    dynamicData: { totalLiquidity: "5000000", volume24h: "1000000", swapFee: "0.0001" },
    poolTokens: [
      { address: "0xaa", symbol: "USDC", decimals: 6, balance: "2500000", balanceUSD: "2500000", weight: "0.5" },
      { address: "0xbb", symbol: "USDT", decimals: 6, balance: "2500000", balanceUSD: "2500000", weight: "0.5" },
    ],
  };
}

function fantomJunkPool() {
  // Real fixture from audit — Fantom multiUSDC/DEI at $337B
  return {
    id: "0x4e415957aa4fd703ad701e43ee5335d1d7891d8300020000000000000000053b",
    type: "STABLE",
    chain: "FANTOM",
    address: "0x4e415957aa4fd703ad701e43ee5335d1d7891d83",
    dynamicData: { totalLiquidity: "337677697052.70", volume24h: "0.00", swapFee: "0.0001" },
    poolTokens: [
      { address: "0xmuusdc", symbol: "multiUSDC", decimals: 6, balance: "0.000001", balanceUSD: "0.00000005684014991798558", weight: "0.5" },
      { address: "0xdei", symbol: "DEI", decimals: 18, balance: "1000002064258.7402", balanceUSD: "337677697052.6986", weight: "0.5" },
    ],
  };
}

describe("fetchBalancerPools sanity cap and pool.price footgun", () => {
  afterEach(() => {
    mockFetch.mockReset();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("rejects pools with totalLiquidity above the per-source sanity cap", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { poolGetPools: [fantomJunkPool(), cleanPool()] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { aggregatorPools: [] } }));
    const result = await fetchBalancerPools();
    // Junk row must be dropped
    expect(result.pools.find((p) => p.tvlUsd > 2_000_000_000)).toBeUndefined();
    expect(
      result.pools.some((p) => p.poolAddress.toLowerCase() === "0x4e415957aa4fd703ad701e43ee5335d1d7891d83"),
    ).toBe(false);
    // Clean row survives
    expect(result.pools.length).toBeGreaterThanOrEqual(1);
  });

  it("sets pool.price to null (per-token priceUsd is authoritative)", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { poolGetPools: [cleanPool()] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { aggregatorPools: [] } }));
    const result = await fetchBalancerPools();
    expect(result.pools.length).toBeGreaterThanOrEqual(1);
    for (const pool of result.pools) {
      expect(pool.price).toBeNull();
    }
  });
});

describe("fetchBalancerPools stable-math amp join", () => {
  afterEach(() => {
    mockFetch.mockReset();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch);
  });

  function dispatchByQuery(pools: unknown[], ampRows: unknown[]) {
    mockFetch.mockImplementation((_url: unknown, init?: { body?: unknown }) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("aggregatorPools")) {
        return Promise.resolve(jsonResponse({ data: { aggregatorPools: ampRows } }));
      }
      return Promise.resolve(jsonResponse({ data: { poolGetPools: pools } }));
    });
  }

  function stablePool() {
    const pool = cleanPool();
    pool.type = "COMPOSABLE_STABLE";
    pool.poolTokens = pool.poolTokens.map((token) => ({ ...token, priceRate: "1.02" }));
    return pool;
  }

  function gyroPool() {
    const pool = cleanPool();
    pool.id = "0x11bbccddeeff00112233445566778899aabbccdd000200000000000000000002";
    pool.address = "0x11bbccddeeff00112233445566778899aabbccdd";
    pool.type = "GYRO";
    return pool;
  }

  it("attaches amp to stable-math pools present in the aggregator sweep", async () => {
    dispatchByQuery(
      [stablePool(), gyroPool()],
      [{ id: stablePool().id, chain: "MAINNET", amp: "250.0" }, { id: gyroPool().id, chain: "MAINNET", amp: "999" }],
    );
    const result = await fetchBalancerPools();
    const stable = result.pools.find((pool) => pool.poolAddress === "0xaabbccddeeff00112233445566778899aabbccdd");
    const gyro = result.pools.find((pool) => pool.poolAddress === "0x11bbccddeeff00112233445566778899aabbccdd");
    expect(stable?.amp).toBe(250);
    expect(stable?.tokens.every((token) => token.priceRate === 1.02)).toBe(true);
    // Gyro pools do not use stable math; amp must never attach even if the sweep returns a row.
    expect(gyro?.amp).toBeUndefined();
  });

  it("keys the amp join by chain so same-id pools on other chains cannot cross-attach", async () => {
    const mainnetPool = stablePool();
    const arbitrumPool = stablePool();
    arbitrumPool.chain = "ARBITRUM";
    dispatchByQuery(
      [mainnetPool, arbitrumPool],
      [
        { id: mainnetPool.id, chain: "MAINNET", amp: "250.0" },
        { id: arbitrumPool.id, chain: "ARBITRUM", amp: "5000" },
      ],
    );
    const result = await fetchBalancerPools();
    const mainnet = result.pools.find((pool) => pool.chain === "ethereum");
    const arbitrum = result.pools.find((pool) => pool.chain === "arbitrum");
    expect(mainnet?.amp).toBe(250);
    expect(arbitrum?.amp).toBe(5000);
  });

  it("degrades to no amp when the sweep fails, without dropping pools", async () => {
    mockFetch.mockImplementation((_url: unknown, init?: { body?: unknown }) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("aggregatorPools")) {
        return Promise.resolve(jsonResponse({ errors: [{ message: "nope" }] }, 500));
      }
      return Promise.resolve(jsonResponse({ data: { poolGetPools: [stablePool()] } }));
    });
    const result = await fetchBalancerPools();
    expect(result.pools.length).toBe(1);
    expect(result.pools[0]!.amp).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
