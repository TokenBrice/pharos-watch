import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBalancerPools } from "../fetch-balancer";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { fetchDirectApiFixture } from "../../__tests__/dex-liquidity-direct-api.test-support";
import { buildAuthoritativeStagedPoolConfirmationIndex } from "../orchestrator-phases/authoritative";
import { convertToGtNewPools } from "../../../lib/dex-api-pool-shaping";

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
    const compacted = await fetchDirectApiFixture(({
      results: [{ name: "Balancer", circuitKey: "balancer-api", normalizedProtocol: "balancer",
        supportedChains: ["ethereum", "base"], censusScope: "exhaustive" as const, result }],
      failedSources: [], degradedSources: [], attemptedProtocolChains: [], fallbackSignals: [],
      sourceWarnings: [], circuitEvents: [],
    }).results, { chainAddressToId: new Map(), symbolToChainScopedIds: new Map(), contractMetaByChainAddress: new Map() });
    const index = buildAuthoritativeStagedPoolConfirmationIndex(compacted.results);
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
    expect(result.pools.find((p) => p.tvlUsd > 2_000_000_000)).toBeUndefined();
    expect(
      result.pools.some((p) => p.poolAddress.toLowerCase() === "0x4e415957aa4fd703ad701e43ee5335d1d7891d83"),
    ).toBe(false);
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

  const balancerGate = (reason: string) => ({ family: "balancer-amm", reason });
  const withHexTag = <T extends { id: string; address: string }>(pool: T, tag: string): T => {
    const address = `0x${tag}bbccddeeff00112233445566778899aabbccdd`;
    return { ...pool, address, id: `${address}00020000000000000000000${tag[0]}` };
  };

  it("fails closed when stable-math numeric inputs contain malformed suffixes", async () => {
    const malformedAmp = withHexTag(stablePool(), "66");
    const malformedRate = withHexTag(stablePool(), "77");
    malformedRate.poolTokens = malformedRate.poolTokens.map((token, index) =>
      index === 1 ? { ...token, priceRate: "1.02junk" } : token,
    );
    const malformedFee = withHexTag(stablePool(), "88");
    malformedFee.dynamicData.swapFee = "0.0001junk";

    dispatchByQuery(
      [malformedAmp, malformedRate, malformedFee],
      [{ id: malformedAmp.id, chain: malformedAmp.chain, amp: "250junk" }],
    );

    const result = await fetchBalancerPools();

    expect(result.pools).toHaveLength(3);
    for (const pool of result.pools) {
      expect(pool.amp).toBeUndefined();
      expect(pool.executionCapabilityGate).toEqual(balancerGate("invalid-invariant-parameters"));
    }
  });

  it("retains paused, swap-disabled, and unknown-state pools behind explicit gates", async () => {
    const paused = {
      ...withHexTag(stablePool(), "33"),
      dynamicData: { totalLiquidity: "5000000", volume24h: "1000000", swapFee: "0.0001", isPaused: true, swapEnabled: true },
    };
    const disabled = {
      ...weightedPool(),
      dynamicData: { totalLiquidity: "5000000", volume24h: "1000000", swapFee: "0.0001", isPaused: false, swapEnabled: false },
    };
    const unknown = {
      ...withHexTag(stablePool(), "44"),
      dynamicData: { totalLiquidity: "5000000", volume24h: "1000000", swapFee: "0.0001", isPaused: false },
    };
    dispatchByQuery([paused, disabled, unknown], []);
    const result = await fetchBalancerPools();
    expect(result.pools).toHaveLength(3);
    expect(result.pools.find((pool) => pool.poolAddress === paused.address)?.executionCapabilityGate)
      .toEqual(balancerGate("paused-or-swap-disabled"));
    expect(result.pools.find((pool) => pool.poolAddress === disabled.address)?.executionCapabilityGate)
      .toEqual(balancerGate("paused-or-swap-disabled"));
    expect(result.pools.find((pool) => pool.poolAddress === unknown.address)?.executionCapabilityGate)
      .toEqual(balancerGate("incomplete-exact-capture"));
  });

  it("keeps complete-sweep misses explicit for stable and weighted candidates", async () => {
    dispatchByQuery([stablePool(), weightedPool()], []);
    const result = await fetchBalancerPools();
    expect(result.pools.find((pool) => pool.poolType === "balancer-stable")?.executionCapabilityGate)
      .toEqual(balancerGate("rate-bearing-inputs"));
    expect(result.pools.find((pool) => pool.poolType === "balancer-weighted")?.executionCapabilityGate)
      .toEqual(balancerGate("incomplete-exact-capture"));
  });

  it.each<{
    label: string;
    build: () => { pool: ReturnType<typeof weightedPool>; sweep: Array<{ id: string; chain: string; amp: string | null }> };
    expectedGate: ReturnType<typeof balancerGate> | undefined;
    expectedPoolType?: string;
  }>([
    {
      label: "fails closed when a weighted invariant input contains a malformed suffix",
      build: () => {
        const weighted = weightedPool();
        weighted.poolTokens = weighted.poolTokens.map((token, index) =>
          index === 1 ? { ...token, weight: "0.5junk" } : token,
        );
        return { pool: weighted, sweep: [] };
      },
      expectedGate: balancerGate("invalid-invariant-parameters"),
    },
    {
      label: "authorizes a weighted model only when the hook-free capability sweep contains it",
      build: () => {
        const weighted = weightedPool();
        return { pool: weighted, sweep: [{ id: weighted.id, chain: weighted.chain, amp: null }] };
      },
      expectedGate: undefined,
    },
    {
      label: "keeps missing amplification unavailable even when membership is reviewed",
      build: () => {
        const pool = stablePool();
        return { pool, sweep: [{ id: pool.id, chain: pool.chain, amp: null }] };
      },
      expectedGate: balancerGate("incomplete-exact-capture"),
    },
    {
      label: "retains a reviewed custom invariant as a gated diagnostic row",
      build: () => {
        const custom = weightedPool();
        custom.type = "COW_AMM";
        return { pool: custom, sweep: [] };
      },
      expectedGate: balancerGate("unsupported-invariant"),
      expectedPoolType: "balancer-custom",
    },
  ])("$label", async ({ build, expectedGate, expectedPoolType }) => {
    const { pool, sweep } = build();
    dispatchByQuery([pool], sweep);
    const result = await fetchBalancerPools();
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.amp).toBeUndefined();
    expect(result.pools[0]?.executionCapabilityGate).toEqual(expectedGate);
    if (expectedPoolType) expect(result.pools[0]?.poolType).toBe(expectedPoolType);
  });

  it("gates a weighted pool withheld from the enrichment sweep instead of authorizing its model", async () => {
    const withheld = weightedPool();
    // >$100M TVL with no measured volume fails the enrichment budget, so the
    // pool is never submitted to the hook-free/reviewed-rate-provider sweep.
    withheld.dynamicData.totalLiquidity = "150000000";
    withheld.dynamicData.volume24h = "0.00";
    mockFetch([{
      match: "api-v3.balancer.fi",
      matchBody: "poolGetPools",
      body: { data: { poolGetPools: [withheld] } },
    }], { requireMatch: true });

    const result = await fetchBalancerPools();
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.executionCapabilityGate).toEqual(balancerGate("incomplete-exact-capture"));

    // The gate withholds the exact weighted-constant-mean model downstream.
    const shaped = convertToGtNewPools(
      result.pools,
      new Map([["ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "usdc-circle"]]),
      new Map(),
    ).get("usdc-circle")?.[0];
    expect(shaped).toBeDefined();
    expect(shaped?.ammExecutionModel).toBeUndefined();
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
    const missingPause = {
      ...weightedPool(),
      dynamicData: { totalLiquidity: "5000000", volume24h: "1000000", swapFee: "0.0001", swapEnabled: true },
    };
    const missingRate = stablePool();
    missingRate.poolTokens = missingRate.poolTokens.map((token) => ({ ...token, priceRate: undefined }));
    dispatchByQuery([missingPause, missingRate], [
      { id: missingPause.id, chain: missingPause.chain, amp: null },
      { id: missingRate.id, chain: missingRate.chain, amp: "250" },
    ]);
    const result = await fetchBalancerPools();
    expect(result.pools).toHaveLength(2);
    expect(result.pools.every((pool) => pool.executionCapabilityGate?.reason === "incomplete-exact-capture")).toBe(true);
    expect(result.pools.every((pool) => pool.amp == null)).toBe(true);
  });

  it("never authorizes exact models with malformed EVM pool or token identities", async () => {
    const malformedPool = { ...weightedPool(), address: "not-an-address", id: "not-a-pool-id" };
    const malformedToken = withHexTag(weightedPool(), "55");
    malformedToken.poolTokens[1]!.address = "0xbb";
    dispatchByQuery([malformedPool, malformedToken], [
      { id: malformedPool.id, chain: malformedPool.chain, amp: null },
      { id: malformedToken.id, chain: malformedToken.chain, amp: null },
    ]);

    const result = await fetchBalancerPools();

    expect(result.pools).toHaveLength(2);
    expect(result.pools.map((pool) => pool.executionCapabilityGate)).toEqual([
      balancerGate("incomplete-exact-capture"),
      balancerGate("incomplete-exact-capture"),
    ]);
    expect(result.pools.every((pool) => pool.amp == null)).toBe(true);
  });

  it("keys the amp join by chain so same-id pools on other chains cannot cross-attach", async () => {
    const mainnetPool = stablePool();
    const arbitrumPool = { ...stablePool(), chain: "ARBITRUM" };
    dispatchByQuery([mainnetPool, arbitrumPool], [
      { id: mainnetPool.id, chain: "MAINNET", amp: "250.0" },
      { id: arbitrumPool.id, chain: "ARBITRUM", amp: "5000" },
    ]);
    const result = await fetchBalancerPools();
    expect(result.pools.find((pool) => pool.chain === "ethereum")?.amp).toBe(250);
    expect(result.pools.find((pool) => pool.chain === "arbitrum")?.amp).toBe(5000);
  });

  it("degrades a failed capability sweep to an explicit incomplete-capture gate", async () => {
    mockFetch([
      { match: "api-v3.balancer.fi", matchBody: "aggregatorPools", body: { errors: [{ message: "nope" }] }, status: 500 },
      { match: "api-v3.balancer.fi", matchBody: "poolGetPools", body: { data: { poolGetPools: [stablePool()] } } },
    ], { requireMatch: true });
    const result = await fetchBalancerPools();
    expect(result.pools.length).toBe(1);
    expect(result.pools[0]!.amp).toBeUndefined();
    expect(result.pools[0]!.executionCapabilityGate).toEqual(balancerGate("incomplete-exact-capture"));
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

  it.each([
    { label: "small pool with unparseable volume", addr: SMALL, tvl: "5000000", vol: "not-a-number", expVol: null, expAmp: 250 },
    { label: "large pool with absent volume", addr: LARGE, tvl: "150000000", vol: "not-a-number", expVol: null, expAmp: undefined },
    { label: "large pool with measured volume clearing floor", addr: LARGE, tvl: "150000000", vol: "60000", expVol: 60_000, expAmp: 250 },
    { label: "large pool with zero measured volume", addr: LARGE, tvl: "150000000", vol: "0.00", expVol: 0, expAmp: undefined },
    { label: "pool whose vol/TVL ratio exceeds sanity bound", addr: SMALL, tvl: "5000000", vol: "300000000", expVol: 300_000_000, expAmp: undefined },
  ])("handles enrichment admission for $label", async ({ addr, tvl, vol, expVol, expAmp }) => {
    dispatch([admissionPool(addr, tvl, vol)]);
    const result = await fetchBalancerPools();
    const pool = result.pools.find((row) => row.poolAddress === addr);
    expect(pool?.volume24hUsd).toBe(expVol);
    expect(pool?.amp).toBe(expAmp);
    expect(pool?.executionCapabilityGate).toBeUndefined();
  });
});
