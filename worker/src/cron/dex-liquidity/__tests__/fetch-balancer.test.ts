import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBalancerPools } from "../fetch-balancer";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { compactDirectApiFetchPhasePools } from "../orchestrator-phases/direct-api";
import { buildAuthoritativeStagedPoolConfirmationIndex } from "../orchestrator-phases/authoritative";

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
    vi.unstubAllGlobals();
  });

  it.each([true, false])("keeps raw physical census independent of malformed economic rows (identity %s)", async (hasIdentity) => {
    const rejectedAddress = "0x1234567890123456789012345678901234567890";
    mockFetch([{ match: "api-v3.balancer.fi", outcomes: [
      { body: { data: { poolGetPools: [
        cleanPool(), { chain: "MAINNET", address: hasIdentity ? rejectedAddress : "invalid", poolTokens: null },
      ] } } },
      { body: { data: { aggregatorPools: [] } } },
    ] }], { requireMatch: true });
    const result = await fetchBalancerPools();
    expect(result.pools).toHaveLength(1);
    expect(result.pools.some((pool) => pool.poolAddress === rejectedAddress)).toBe(false);
    const compacted = compactDirectApiFetchPhasePools({
      results: [{ name: "Balancer", circuitKey: "balancer-api", normalizedProtocol: "balancer",
        supportedChains: ["ethereum", "base"], result }],
      failedSources: [], degradedSources: [], attemptedProtocolChains: [], fallbackSignals: [],
      sourceWarnings: [], circuitEvents: [],
    }, { chainAddressToId: new Map(), symbolToChainScopedIds: new Map(), contractMetaByChainAddress: new Map() });
    const index = buildAuthoritativeStagedPoolConfirmationIndex(compacted.phase.results);
    // Independent staged observation has this exact physical key, despite rejected metadata.
    expect(index.confirmedExactKeysByProtocol.get("balancer")?.has(`ethereum:${rejectedAddress}`)).toBe(hasIdentity);
    expect(index.enforcedChainsByProtocol.get("balancer")?.has("ethereum")).toBe(hasIdentity);
    expect(index.enforcedChainsByProtocol.get("balancer")?.has("base")).toBe(true);
  });

  it("rejects pools with totalLiquidity above the per-source sanity cap", async () => {
    mockFetch([{
      match: "api-v3.balancer.fi",
      outcomes: [
        { body: { data: { poolGetPools: [fantomJunkPool(), cleanPool()] } } },
        { body: { data: { aggregatorPools: [] } } },
      ],
    }], { requireMatch: true });
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
    mockFetch([{
      match: "api-v3.balancer.fi",
      outcomes: [
        { body: { data: { poolGetPools: [cleanPool()] } } },
        { body: { data: { aggregatorPools: [] } } },
      ],
    }], { requireMatch: true });
    const result = await fetchBalancerPools();
    expect(result.pools.length).toBeGreaterThanOrEqual(1);
    for (const pool of result.pools) {
      expect(pool.price).toBeNull();
    }
  });
});

describe("fetchBalancerPools stable-math amp join", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function dispatchByQuery(pools: unknown[], ampRows: unknown[]) {
    mockFetch([
      {
        match: "api-v3.balancer.fi",
        matchBody: "aggregatorPools",
        body: { data: { aggregatorPools: ampRows } },
      },
      {
        match: "api-v3.balancer.fi",
        matchBody: "poolGetPools",
        body: { data: { poolGetPools: pools } },
      },
    ], { requireMatch: true });
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

  it("sends raw Sonic vault ids to idIn while retaining chain-scoped admission", async () => {
    const sonic = weightedPool();
    sonic.chain = "SONIC";
    sonic.address = "0x25ca5451cd5a50ab1d324b5e64f32c0799661891";
    sonic.id = `${sonic.address}0002000000000000000018`;
    sonic.poolTokens[0]!.weight = "0.3";
    sonic.poolTokens[1]!.weight = "0.7";
    const fetch = mockFetch([
      {
        match: "api-v3.balancer.fi", matchBody: "aggregatorPools",
        respond: async (request) => {
          const body = await request.json() as { variables: { poolIds: string[] } };
          // Match the real provider behavior, not a fixture independent of idIn.
          return { body: { data: { aggregatorPools: body.variables.poolIds.includes(sonic.id)
            ? [{ id: sonic.id, chain: sonic.chain, amp: null }] : [] } } };
        },
      },
      {
        match: "api-v3.balancer.fi", matchBody: "poolGetPools",
        body: { data: { poolGetPools: [sonic] } },
      },
    ], { requireMatch: true });
    const result = await fetchBalancerPools();
    const sweepRequest = fetch.getHistory().find((entry) => entry.body?.includes("aggregatorPools"));
    expect(JSON.parse(sweepRequest!.body!).variables.poolIds).toEqual([sonic.id]);
    expect(result.pools[0]?.chain).toBe("sonic");
    expect(result.pools[0]?.executionCapabilityGate).toBeUndefined();
  });

  it("never derives enabled flags or missing rates from provider membership", async () => {
    const unknownPause = weightedPool();
    const missingPause = { ...unknownPause, dynamicData: {
      totalLiquidity: "5000000", volume24h: "1000000", swapFee: "0.0001", swapEnabled: true,
    } };
    const missingRate = stablePool();
    missingRate.poolTokens = missingRate.poolTokens.map((token) => ({
      ...token, priceRate: undefined,
    }));
    dispatchByQuery([missingPause, missingRate], [
      { id: missingPause.id, chain: missingPause.chain, amp: null },
      { id: missingRate.id, chain: missingRate.chain, amp: "250" },
    ]);
    const result = await fetchBalancerPools();
    expect(result.pools).toHaveLength(2);
    expect(result.pools.every((pool) => pool.executionCapabilityGate?.reason === "incomplete-exact-capture")).toBe(true);
    expect(result.pools.every((pool) => pool.amp == null)).toBe(true);
  });

  it("keeps missing amplification unavailable even when membership is reviewed", async () => {
    const pool = stablePool();
    dispatchByQuery([pool], [{ id: pool.id, chain: pool.chain, amp: null }]);
    const result = await fetchBalancerPools();
    expect(result.pools[0]?.amp).toBeUndefined();
    expect(result.pools[0]?.executionCapabilityGate?.reason).toBe("incomplete-exact-capture");
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
    mockFetch([
      {
        match: "api-v3.balancer.fi",
        matchBody: "aggregatorPools",
        body: { errors: [{ message: "nope" }] },
        status: 500,
      },
      {
        match: "api-v3.balancer.fi",
        matchBody: "poolGetPools",
        body: { data: { poolGetPools: [stablePool()] } },
      },
    ], { requireMatch: true });
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

describe("fetchBalancerPools enrichment admission (absent volume is not a zero)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function admissionPool(address: string, totalLiquidity: string, volume24h: string) {
    return {
      id: `${address}0002000000000000000000aa`,
      type: "COMPOSABLE_STABLE",
      chain: "MAINNET",
      address,
      dynamicData: { totalLiquidity, volume24h, swapFee: "0.0001", isPaused: false, swapEnabled: true },
      poolTokens: [
        { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", symbol: "USDC", decimals: 6, balance: "2500000", balanceUSD: "2500000", weight: "0.5", priceRate: "1.02" },
        { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", symbol: "USDT", decimals: 6, balance: "2500000", balanceUSD: "2500000", weight: "0.5", priceRate: "1.02" },
      ],
    };
  }

  function dispatch(pools: Array<{ id: string }>) {
    // The sweep always offers an amp row for every pool, so a pool that is
    // wrongly admitted as an exact candidate attaches amp and fails the test.
    mockFetch([
      {
        match: "api-v3.balancer.fi",
        matchBody: "aggregatorPools",
        body: { data: { aggregatorPools: pools.map((pool) => ({ id: pool.id, chain: "MAINNET", amp: "250.0" })) } },
      },
      {
        match: "api-v3.balancer.fi",
        matchBody: "poolGetPools",
        body: { data: { poolGetPools: pools } },
      },
    ], { requireMatch: true });
  }

  const SMALL = "0xaaaa000000000000000000000000000000000001";
  const LARGE = "0xbbbb000000000000000000000000000000000002";

  it("enriches a small pool whose volume field is unparseable (absent, not zero)", async () => {
    dispatch([admissionPool(SMALL, "5000000", "not-a-number")]);
    const result = await fetchBalancerPools();
    const pool = result.pools.find((row) => row.poolAddress === SMALL);
    expect(pool?.volume24hUsd).toBeNull();
    expect(pool?.amp).toBe(250);
    expect(pool?.executionCapabilityGate).toBeUndefined();
  });

  it("skips the capability sweep for a large pool with an absent volume reading", async () => {
    dispatch([admissionPool(LARGE, "150000000", "not-a-number")]);
    const result = await fetchBalancerPools();
    const pool = result.pools.find((row) => row.poolAddress === LARGE);
    expect(pool?.volume24hUsd).toBeNull();
    expect(pool?.amp).toBeUndefined();
    expect(pool?.executionCapabilityGate).toBeUndefined();
  });

  it("enriches a large pool whose measured volume clears the floor", async () => {
    dispatch([admissionPool(LARGE, "150000000", "60000")]);
    const result = await fetchBalancerPools();
    const pool = result.pools.find((row) => row.poolAddress === LARGE);
    expect(pool?.volume24hUsd).toBe(60000);
    expect(pool?.amp).toBe(250);
  });

  it("does not enrich a large pool whose measured volume is zero", async () => {
    dispatch([admissionPool(LARGE, "150000000", "0.00")]);
    const result = await fetchBalancerPools();
    const pool = result.pools.find((row) => row.poolAddress === LARGE);
    expect(pool?.volume24hUsd).toBe(0);
    expect(pool?.amp).toBeUndefined();
    expect(pool?.executionCapabilityGate).toBeUndefined();
  });

  it("does not enrich any pool whose measured vol/TVL ratio exceeds the sanity bound", async () => {
    dispatch([admissionPool(SMALL, "5000000", "300000000")]);
    const result = await fetchBalancerPools();
    const pool = result.pools.find((row) => row.poolAddress === SMALL);
    expect(pool?.amp).toBeUndefined();
    expect(pool?.executionCapabilityGate).toBeUndefined();
  });
});
