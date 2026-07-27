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
    dynamicData: {
      totalLiquidity: "5000000",
      volume24h: "1000000",
      swapFee: "0.0001",
      isPaused: false,
      swapEnabled: true,
    },
    poolTokens: [
      { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", symbol: "USDC", decimals: 6, balance: "2500000", balanceUSD: "2500000", weight: "0.5" },
      { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", symbol: "USDT", decimals: 6, balance: "2500000", balanceUSD: "2500000", weight: "0.5" },
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

  function weightedPool() {
    const pool = cleanPool();
    pool.id = "0x22bbccddeeff00112233445566778899aabbccdd000200000000000000000002";
    pool.address = "0x22bbccddeeff00112233445566778899aabbccdd";
    pool.type = "WEIGHTED";
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
    expect(stable?.executionCapabilityGate).toBeUndefined();
    // Gyro pools do not use stable math; amp must never attach even if the sweep returns a row.
    expect(gyro?.amp).toBeUndefined();
    expect(gyro?.executionCapabilityGate).toEqual({
      family: "balancer-amm",
      reason: "unsupported-invariant",
    });
  });

  it("fails closed when stable-math numeric inputs contain malformed suffixes", async () => {
    const malformedAmp = stablePool();
    malformedAmp.id = "0x66bbccddeeff00112233445566778899aabbccdd000200000000000000000006";
    malformedAmp.address = "0x66bbccddeeff00112233445566778899aabbccdd";
    const malformedRate = stablePool();
    malformedRate.id = "0x77bbccddeeff00112233445566778899aabbccdd000200000000000000000007";
    malformedRate.address = "0x77bbccddeeff00112233445566778899aabbccdd";
    malformedRate.poolTokens = malformedRate.poolTokens.map((token, index) =>
      index === 1 ? { ...token, priceRate: "1.02junk" } : token,
    );
    const malformedFee = stablePool();
    malformedFee.id = "0x88bbccddeeff00112233445566778899aabbccdd000200000000000000000008";
    malformedFee.address = "0x88bbccddeeff00112233445566778899aabbccdd";
    malformedFee.dynamicData.swapFee = "0.0001junk";

    dispatchByQuery(
      [malformedAmp, malformedRate, malformedFee],
      [{ id: malformedAmp.id, chain: malformedAmp.chain, amp: "250junk" }],
    );

    const result = await fetchBalancerPools();

    expect(result.pools).toHaveLength(3);
    for (const pool of result.pools) {
      expect(pool.amp).toBeUndefined();
      expect(pool.executionCapabilityGate).toEqual({
        family: "balancer-amm",
        reason: "invalid-invariant-parameters",
      });
    }
  });

  it("fails closed when a weighted invariant input contains a malformed suffix", async () => {
    const weighted = weightedPool();
    weighted.poolTokens = weighted.poolTokens.map((token, index) =>
      index === 1 ? { ...token, weight: "0.5junk" } : token,
    );
    dispatchByQuery([weighted], []);

    const result = await fetchBalancerPools();

    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.executionCapabilityGate).toEqual({
      family: "balancer-amm",
      reason: "invalid-invariant-parameters",
    });
  });

  it("retains paused, swap-disabled, and unknown-state pools behind explicit gates", async () => {
    const paused = {
      ...stablePool(),
      id: "0x33bbccddeeff00112233445566778899aabbccdd000200000000000000000003",
      address: "0x33bbccddeeff00112233445566778899aabbccdd",
      dynamicData: {
        totalLiquidity: "5000000",
        volume24h: "1000000",
        swapFee: "0.0001",
        isPaused: true,
        swapEnabled: true,
      },
    };
    const disabled = {
      ...weightedPool(),
      dynamicData: {
        totalLiquidity: "5000000",
        volume24h: "1000000",
        swapFee: "0.0001",
        isPaused: false,
        swapEnabled: false,
      },
    };
    const unknown = {
      ...stablePool(),
      id: "0x44bbccddeeff00112233445566778899aabbccdd000200000000000000000004",
      address: "0x44bbccddeeff00112233445566778899aabbccdd",
      dynamicData: {
        totalLiquidity: "5000000",
        volume24h: "1000000",
        swapFee: "0.0001",
        isPaused: false,
      },
    };
    dispatchByQuery([paused, disabled, unknown], []);
    const result = await fetchBalancerPools();
    expect(result.pools).toHaveLength(3);
    expect(result.pools.find((pool) => pool.poolAddress === paused.address)?.executionCapabilityGate).toEqual({
      family: "balancer-amm",
      reason: "paused-or-swap-disabled",
    });
    expect(result.pools.find((pool) => pool.poolAddress === disabled.address)?.executionCapabilityGate).toEqual({
      family: "balancer-amm",
      reason: "paused-or-swap-disabled",
    });
    expect(result.pools.find((pool) => pool.poolAddress === unknown.address)?.executionCapabilityGate).toEqual({
      family: "balancer-amm",
      reason: "incomplete-exact-capture",
    });
  });

  it("keeps complete-sweep misses explicit for stable and weighted candidates", async () => {
    dispatchByQuery([stablePool(), weightedPool()], []);
    const result = await fetchBalancerPools();
    expect(result.pools.find((pool) => pool.poolType === "balancer-stable")?.executionCapabilityGate).toEqual({
      family: "balancer-amm",
      reason: "rate-bearing-inputs",
    });
    expect(result.pools.find((pool) => pool.poolType === "balancer-weighted")?.executionCapabilityGate).toEqual({
      family: "balancer-amm",
      reason: "incomplete-exact-capture",
    });
  });

  it("authorizes a weighted model only when the hook-free capability sweep contains it", async () => {
    const weighted = weightedPool();
    dispatchByQuery(
      [weighted],
      [{ id: weighted.id, chain: weighted.chain, amp: null }],
    );
    const result = await fetchBalancerPools();
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.executionCapabilityGate).toBeUndefined();
    expect(result.pools[0]?.amp).toBeUndefined();
  });

  it("retains a reviewed custom invariant as a gated diagnostic row", async () => {
    const custom = weightedPool();
    custom.type = "COW_AMM";
    dispatchByQuery([custom], []);
    const result = await fetchBalancerPools();
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.poolType).toBe("balancer-custom");
    expect(result.pools[0]?.executionCapabilityGate).toEqual({
      family: "balancer-amm",
      reason: "unsupported-invariant",
    });
  });

  it("never authorizes exact models with malformed EVM pool or token identities", async () => {
    const malformedPool = weightedPool();
    malformedPool.address = "not-an-address";
    malformedPool.id = "not-a-pool-id";
    const malformedToken = weightedPool();
    malformedToken.id = "0x55bbccddeeff00112233445566778899aabbccdd000200000000000000000005";
    malformedToken.address = "0x55bbccddeeff00112233445566778899aabbccdd";
    malformedToken.poolTokens[1]!.address = "0xbb";
    dispatchByQuery(
      [malformedPool, malformedToken],
      [
        { id: malformedPool.id, chain: malformedPool.chain, amp: null },
        { id: malformedToken.id, chain: malformedToken.chain, amp: null },
      ],
    );

    const result = await fetchBalancerPools();

    expect(result.pools).toHaveLength(2);
    expect(result.pools.map((pool) => pool.executionCapabilityGate)).toEqual([
      { family: "balancer-amm", reason: "incomplete-exact-capture" },
      { family: "balancer-amm", reason: "incomplete-exact-capture" },
    ]);
    expect(result.pools.every((pool) => pool.amp == null)).toBe(true);
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

  it("degrades a failed capability sweep to an explicit incomplete-capture gate", async () => {
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
    expect(result.pools[0]!.executionCapabilityGate).toEqual({
      family: "balancer-amm",
      reason: "incomplete-exact-capture",
    });
    expect(result.ok).toBe(true);
  });
});
