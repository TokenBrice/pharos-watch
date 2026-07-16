import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBalancerPools } from "../fetch-balancer";
import { convertToGtNewPools } from "../../../lib/dex-api-common";

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

describe("fetchBalancerPools reviewed USP route", () => {
  const poolId = "0x114907c2a07978c38ebb9f9f6a5261a846b79521";
  const usp = "0x97ccc1c046d067ab945d3cf3cc6920d3b1e54c88";
  const waEthUsdc = "0xd4fa2d31b7968e448877f69a96de69f5de8cd23e";
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

  afterEach(() => {
    mockFetch.mockReset();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch);
  });

  function uspPool(overrides: Record<string, unknown> = {}) {
    return {
      id: poolId,
      address: poolId,
      type: "STABLE",
      chain: "MAINNET",
      dynamicData: {
        totalLiquidity: "52654.79",
        volume24h: "0",
        swapFee: "0.0001",
        isPaused: false,
        swapEnabled: true,
      },
      poolTokens: [
        {
          index: 0,
          address: usp,
          symbol: "USP",
          decimals: 18,
          balance: "27051.901807226317",
          balanceUSD: "27051.90180722632",
          weight: null,
          priceRate: "1",
          priceRateProvider: "0x0000000000000000000000000000000000000000",
          isErc4626: false,
          isAllowed: true,
          underlyingToken: null,
        },
        {
          index: 1,
          address: waEthUsdc,
          symbol: "waEthUSDC",
          decimals: 6,
          balance: "21725.046993",
          balanceUSD: "25602.88946252088",
          weight: null,
          priceRate: "1.178408462294405222",
          priceRateProvider: "0x8f4e8439b970363648421c692dd897fb9c0bd1d9",
          isErc4626: true,
          isAllowed: true,
          underlyingToken: { address: usdc, symbol: "USDC", decimals: 6 },
        },
      ],
      amp: "1000",
      protocolVersion: 3,
      hasErc4626: true,
      hasAnyAllowedBuffer: true,
      hook: {
        address: "0xbdbadc891bb95dee80ebc491699228ef0f7d6ff1",
        type: "STABLE_SURGE",
        config: {
          enableHookAdjustedAmounts: false,
          shouldCallAfterSwap: false,
          shouldCallBeforeSwap: false,
          shouldCallComputeDynamicSwapFee: true,
        },
        reviewData: { summary: "safe", warnings: [] },
      },
      ...overrides,
    };
  }

  function quote(swapAmount: string, returnAmount: string, reportedPriceImpact: string | null) {
    return {
      tokenIn: usp,
      tokenOut: usdc,
      swapAmount,
      returnAmount,
      protocolVersion: 3,
      tokenAddresses: [usp, waEthUsdc, usdc],
      priceImpact: { priceImpact: reportedPriceImpact, error: reportedPriceImpact == null ? "Unable to calculate price impact" : null },
      paths: [{
        pools: [poolId, waEthUsdc],
        isBuffer: [false, true],
        protocolVersion: 3,
      }],
    };
  }

  function dispatch(params: {
    listedPools?: unknown[];
    reviewedPool?: unknown;
    referenceReturn?: string;
    boundedReturn?: string;
    reportedPriceImpact?: string | null;
  } = {}) {
    mockFetch.mockImplementation((_url: unknown, init?: { body?: unknown }) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const request = body ? JSON.parse(body) as {
        query?: string;
        variables?: { swapAmount?: string };
      } : {};
      if (body.includes("aggregatorPools")) {
        return Promise.resolve(jsonResponse({ data: { aggregatorPools: [] } }));
      }
      if (request.query?.includes("poolGetPool(id:")) {
        return Promise.resolve(jsonResponse({
          data: { poolGetPool: params.reviewedPool ?? uspPool() },
        }));
      }
      if (request.query?.includes("sorGetSwapPaths")) {
        const amount = request.variables?.swapAmount ?? "";
        return Promise.resolve(jsonResponse({
          data: {
            sorGetSwapPaths: quote(
              amount,
              amount === "1"
                ? params.referenceReturn ?? "1.00003"
                : params.boundedReturn ?? "999.990384",
              params.reportedPriceImpact ?? null,
            ),
          },
        }));
      }
      return Promise.resolve(jsonResponse({ data: { poolGetPools: params.listedPools ?? [uspPool()] } }));
    });
  }

  it("pins the exact pool and derives USP from a bounded executable USDC quote", async () => {
    dispatch();

    const result = await fetchBalancerPools();

    const pool = result.pools.find((entry) => entry.poolAddress === poolId);
    expect(pool?.tokens.find((token) => token.address === usp)).toMatchObject({
      priceUsd: null,
      priceUsdDependency: {
        stablecoinId: "usdc-circle",
        multiplier: 0.999990384,
      },
    });
    expect(pool?.tokens.find((token) => token.address === waEthUsdc)).toMatchObject({ priceUsd: null });
    expect(pool?.amp).toBe(1000);
    expect(pool?.executionCapabilityGate).toEqual({
      family: "balancer-amm",
      reason: "unsupported-invariant",
    });
    const withoutUsdcDependency = convertToGtNewPools(
      pool ? [pool] : [],
      new Map([[`ethereum:${usp}`, "usp-pareto-credit"]]),
      new Map(),
    );
    expect(withoutUsdcDependency.get("usp-pareto-credit")?.[0]).toMatchObject({
      price: 0,
      measurement: { priceMeasured: false },
    });

    const converted = convertToGtNewPools(
      pool ? [pool] : [],
      new Map([[`ethereum:${usp}`, "usp-pareto-credit"]]),
      new Map(),
      undefined,
      new Map([["usdc-circle", 0.9997]]),
    );
    expect(converted.get("usp-pareto-credit")?.[0]?.price).toBeCloseTo(0.9996903868848, 12);
    expect(converted.get("usp-pareto-credit")?.[0]?.measurement?.priceMeasured).toBe(true);
  });

  it("resolves the reviewed route even when it is absent from the generic list page", async () => {
    dispatch({ listedPools: [] });

    const result = await fetchBalancerPools();

    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.poolAddress).toBe(poolId);
    expect(result.pools[0]?.tokens.find((token) => token.address === usp)?.priceUsdDependency).toEqual({
      stablecoinId: "usdc-circle",
      multiplier: 0.999990384,
    });
  });

  it("fails price discovery closed when the reviewed wrapper identity changes", async () => {
    const invalid = uspPool();
    invalid.poolTokens[1]!.priceRateProvider = "0x0000000000000000000000000000000000000001";
    dispatch({ reviewedPool: invalid });

    const result = await fetchBalancerPools();

    const token = result.pools.find((entry) => entry.poolAddress === poolId)
      ?.tokens.find((entry) => entry.address === usp);
    expect(token?.priceUsd).toBeNull();
    expect(token?.priceUsdDependency).toBeUndefined();
  });

  it("preserves a non-par SOR mark instead of using generic balanceUSD", async () => {
    dispatch({ referenceReturn: "0.92001", boundedReturn: "920" });

    const result = await fetchBalancerPools();
    const pool = result.pools.find((entry) => entry.poolAddress === poolId);
    const converted = convertToGtNewPools(
      pool ? [pool] : [],
      new Map([[`ethereum:${usp}`, "usp-pareto-credit"]]),
      new Map(),
      undefined,
      new Map([["usdc-circle", 0.9998]]),
    );

    expect(pool?.tokens.find((token) => token.address === usp)).toMatchObject({
      priceUsd: null,
      priceUsdDependency: { stablecoinId: "usdc-circle", multiplier: 0.92 },
    });
    expect(converted.get("usp-pareto-credit")?.[0]?.price).toBeCloseTo(0.919816, 9);
  });

  it("fails price discovery closed when the API reports excessive impact", async () => {
    dispatch({ reportedPriceImpact: "0.05" });

    const result = await fetchBalancerPools();

    const token = result.pools.find((entry) => entry.poolAddress === poolId)
      ?.tokens.find((entry) => entry.address === usp);
    expect(token?.priceUsd).toBeNull();
    expect(token?.priceUsdDependency).toBeUndefined();
  });

  it("fails price discovery closed when the bounded quote diverges from the reference quote", async () => {
    dispatch({ boundedReturn: "950" });

    const result = await fetchBalancerPools();

    const token = result.pools.find((entry) => entry.poolAddress === poolId)
      ?.tokens.find((entry) => entry.address === usp);
    expect(token?.priceUsd).toBeNull();
    expect(token?.priceUsdDependency).toBeUndefined();
  });

  it("fails price discovery closed when the API reports malformed negative impact", async () => {
    dispatch({ reportedPriceImpact: "-0.01" });

    const result = await fetchBalancerPools();

    const token = result.pools.find((entry) => entry.poolAddress === poolId)
      ?.tokens.find((entry) => entry.address === usp);
    expect(token?.priceUsd).toBeNull();
    expect(token?.priceUsdDependency).toBeUndefined();
  });
});
