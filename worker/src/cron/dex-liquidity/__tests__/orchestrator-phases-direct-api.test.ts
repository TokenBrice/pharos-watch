import { afterEach, describe, expect, it, vi } from "vitest";
import type { DexApiPool } from "../../../lib/dex-api-common";
import { compactDirectApiFetchPhasePools, integrateDirectApiLiquidityPhase } from "../orchestrator-phases/direct-api";
import { buildAuthoritativeStagedPoolConfirmationIndex } from "../orchestrator-phases/authoritative";
import { createKnownPoolIdentityIndex } from "../pool-identity";
import { initMetrics } from "../pool-helpers";
import { buildChainAddressKey } from "../token-resolution";

const SOLANA_POOL_ADDRESS = "11111111111111111111111111111111";
const SOLANA_USDC_MINT = "UsdcMint";
const SOLANA_USDT_MINT = "UsdtMint";

function makeSolanaDirectPool(overrides: Partial<DexApiPool> = {}): DexApiPool {
  return {
    source: "raydium",
    chain: "solana",
    poolAddress: SOLANA_POOL_ADDRESS,
    poolType: "raydium-amm",
    tokens: [
      { address: SOLANA_USDC_MINT, symbol: "USDC", decimals: 6 },
      { address: SOLANA_USDT_MINT, symbol: "USDT", decimals: 6 },
    ],
    price: 1,
    tvlUsd: 4_000_000,
    volume24hUsd: 100_000,
    feeRate: 0.0025,
    balances: [2_000_000, 2_000_000],
    balancesNormalized: true,
    ...overrides,
  };
}

type DirectApiScenarioOverrides = Partial<Parameters<typeof integrateDirectApiLiquidityPhase>[0]>;

async function runDirectApiScenario(overrides: DirectApiScenarioOverrides = {}) {
  return integrateDirectApiLiquidityPhase({
    directApiPools: [makeSolanaDirectPool()],
    knownPoolIndex: createKnownPoolIdentityIndex(),
    contractMetaByChainAddress: new Map(),
    metrics: new Map(),
    priceObservations: new Map(),
    chainAddressToId: new Map([
      [`solana:${SOLANA_USDC_MINT}`, "usdc-circle"],
      [`solana:${SOLANA_USDT_MINT}`, "usdt-tether"],
    ]),
    symbolToChainScopedIds: new Map(),
    symbolToIds: new Map(),
    validationReferences: {} as never,
    stablecoinPriceById: new Map([
      ["usdc-circle", 1],
      ["usdt-tether", 1],
    ]),
    ...overrides,
  });
}

describe("integrateDirectApiLiquidityPhase", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers exact ids for sub-threshold direct API pools so staged duplicates cannot re-add them", async () => {
    const poolAddress = "0x4ba45fb7de134bcb24a6053bbe21c3a4be9f85ea";
    const directApiPools: DexApiPool[] = [
      {
        source: "balancer",
        chain: "plasma",
        poolAddress,
        poolType: "balancer-stable",
        tokens: [
          { address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", symbol: "USDai", decimals: 18 },
          { address: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", symbol: "USDT0", decimals: 6 },
        ],
        price: 1.0545990385,
        tvlUsd: 7.24,
        volume24hUsd: 0,
        feeRate: 0.0005,
        balances: [6.991123220641848, 0.000001],
      },
    ];

    const knownPoolIndex = createKnownPoolIdentityIndex();
    const metrics = new Map();
    const priceObservations = new Map();
    const chainAddressToId = new Map([["plasma:0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", "usdai-usd-ai"]]);

    await integrateDirectApiLiquidityPhase({
      directApiPools,
      knownPoolIndex,
      contractMetaByChainAddress: new Map(),
      metrics,
      priceObservations,
      chainAddressToId,
      symbolToChainScopedIds: new Map(),
      symbolToIds: new Map(),
      validationReferences: {} as never,
      stablecoinPriceById: new Map(),
    });

    expect(metrics.size).toBe(0);
    expect(priceObservations.size).toBe(0);
    expect(knownPoolIndex.exactKeys.has(`plasma:${poolAddress}`)).toBe(true);
    expect(knownPoolIndex.exactStablecoinIdsByKey.get(`plasma:${poolAddress}`)).toEqual(
      new Set(["usdai-usd-ai"]),
    );
  });

  it("skips untracked direct API pools before identity processing", async () => {
    const directApiPools: DexApiPool[] = [
      {
        source: "raydium",
        chain: "solana",
        poolAddress: "pool-untracked",
        poolType: "raydium-amm",
        tokens: [
          { address: "token-a", symbol: "AAA", decimals: 6 },
          { address: "token-b", symbol: "BBB", decimals: 6 },
        ],
        price: 1,
        tvlUsd: 1_000_000,
        volume24hUsd: 50_000,
        feeRate: null,
        balances: [500_000, 500_000],
      },
    ];

    const result = await integrateDirectApiLiquidityPhase({
      directApiPools,
      knownPoolIndex: createKnownPoolIdentityIndex(),
      contractMetaByChainAddress: new Map(),
      metrics: new Map(),
      priceObservations: new Map(),
      chainAddressToId: new Map(),
      symbolToChainScopedIds: new Map(),
      symbolToIds: new Map(),
      validationReferences: {} as never,
      stablecoinPriceById: new Map(),
    });

    expect(result.directApiSkippedUntracked).toBe(1);
    expect(result.directApiDedupSkippedByAddress).toBe(0);
    expect(result.excludedByReason).toEqual({ untracked_token: 1 });
  });

  it("compacts production-scale direct results before identity work without losing raw source evidence", () => {
    const rawPoolCount = 6_673;
    const retainedPoolCount = 1_442;
    const trackedAddress = "0x1111111111111111111111111111111111111111";
    const makePool = (index: number, tracked: boolean): DexApiPool => ({
      source: "balancer",
      chain: "ethereum",
      poolAddress: `0x${(tracked ? index : index + retainedPoolCount).toString(16).padStart(40, "0")}`,
      poolType: "balancer-stable",
      tokens: [
        {
          address: tracked ? trackedAddress : `0x${(index + rawPoolCount).toString(16).padStart(40, "0")}`,
          symbol: tracked ? "TRACKED" : "UNKNOWN",
          decimals: 6,
        },
        {
          address: `0x${(index + rawPoolCount * 2).toString(16).padStart(40, "0")}`,
          symbol: "QUOTE",
          decimals: 6,
        },
      ],
      price: 1,
      tvlUsd: 1_000_000,
      volume24hUsd: 50_000,
      feeRate: null,
      balances: [500_000, 500_000],
    });
    const rawPools = [
      ...Array.from({ length: retainedPoolCount }, (_, index) => makePool(index, true)),
      ...Array.from({ length: rawPoolCount - retainedPoolCount }, (_, index) => makePool(index, false)),
    ];
    const rawPhase = {
      results: [
        {
          name: "Balancer",
          circuitKey: "balancer-api",
          normalizedProtocol: "balancer",
          supportedChains: ["ethereum"],
          result: {
            pools: rawPools,
            ok: true,
            degraded: false,
            errors: [],
            warnings: [],
            pagination: {
              state: "partial" as const,
              headRefreshed: true,
              pagesFetched: 50,
              cursor: "next-page",
              cycleCompleted: false,
            },
          },
        },
      ],
      failedSources: [],
      fallbackSignals: [],
      sourceWarnings: ["balancer-api: bounded-tail"],
      circuitEvents: [],
    };

    const compacted = compactDirectApiFetchPhasePools(rawPhase, {
      chainAddressToId: new Map([[buildChainAddressKey("ethereum", trackedAddress), "tracked-stablecoin"]]),
      symbolToChainScopedIds: new Map(),
      contractMetaByChainAddress: new Map(),
    });
    const authoritativeConfirmation = buildAuthoritativeStagedPoolConfirmationIndex(compacted.phase.results);

    expect(compacted.counts).toEqual({
      rawPoolCount,
      retainedPoolCount,
      skippedInvalidUnitCount: 0,
      skippedUntrackedCount: 5_231,
    });
    expect(compacted.pools).toHaveLength(retainedPoolCount);
    expect(compacted.phase.results[0]?.result.pools).toHaveLength(retainedPoolCount);
    expect(compacted.phase.results[0]?.result.pagination).toEqual(rawPhase.results[0]?.result.pagination);
    expect(compacted.phase.sourceWarnings).toEqual(rawPhase.sourceWarnings);
    const lastPoolKey = `ethereum:0x${(rawPoolCount - 1).toString(16).padStart(40, "0")}`;
    expect(compacted.phase.results[0]?.authoritativeExactPoolKeys).toContain(lastPoolKey);
    expect(authoritativeConfirmation.confirmedExactKeysByProtocol.has("balancer")).toBe(false);
  });

  it("keeps Fluid pools out of the measured-execution routing after the overlay removal", () => {
    const poolAddress = "0x218c659b6bbb73d47c7926fc90d9893342534b84";
    const paxg = "0x45804880de22913dafe09f4980848ece6ecbaf78";
    const xaut = "0x68749665ff8d2d112fa859aa293f07a622782f38";
    const rawPhase = {
      results: [
        {
          name: "Fluid",
          circuitKey: "fluid-dex-api",
          normalizedProtocol: "fluid",
          supportedChains: ["ethereum"],
          result: {
            pools: [{
              source: "fluid" as const,
              chain: "ethereum",
              poolAddress,
              poolType: "fluid-dex",
              tokens: [
                { address: paxg, symbol: "PAXG", decimals: 18 },
                { address: xaut, symbol: "XAUT", decimals: 6 },
              ],
              price: 1,
              tvlUsd: 2_000_000,
              volume24hUsd: 0,
              feeRate: 0.0005,
              balances: [2_000, 2_000],
            }],
            ok: true,
            degraded: false,
            errors: [],
            warnings: [],
          },
        },
      ],
      failedSources: [],
      fallbackSignals: [],
      sourceWarnings: [],
      circuitEvents: [],
    };
    const chainAddressToId = new Map([
      [buildChainAddressKey("ethereum", paxg), "paxg-paxos"],
      [buildChainAddressKey("ethereum", xaut), "xaut-tether"],
    ]);
    const compacted = compactDirectApiFetchPhasePools(rawPhase, {
      chainAddressToId,
      symbolToChainScopedIds: new Map(),
      contractMetaByChainAddress: new Map(),
    });

    // The Fluid measured overlay is deleted (Liquidity Score v6 Phase 3):
    // Fluid pools still contribute normalized liquidity but no longer split
    // into a measured-execution target copy.
    expect(compacted.measuredExecutionPools).toHaveLength(0);
    expect(compacted.pools).toHaveLength(1);
    expect(compacted.pools[0]).toMatchObject({ source: "fluid", poolAddress });
  });

  it("reports pre-compaction exclusion counts after receiving only retained direct pools", async () => {
    const trackedPool: DexApiPool = {
      source: "raydium",
      chain: "solana",
      poolAddress: "pool-tracked",
      poolType: "raydium-amm",
      tokens: [
        { address: "tracked-mint", symbol: "TRACKED", decimals: 6 },
        { address: "quote-mint", symbol: "QUOTE", decimals: 6 },
      ],
      price: 1,
      tvlUsd: 9_999,
      volume24hUsd: 500,
      feeRate: null,
      balances: [5_000, 5_000],
    };

    const result = await integrateDirectApiLiquidityPhase({
      directApiPools: [trackedPool],
      preprocessedPoolCounts: {
        rawPoolCount: 5_233,
        retainedPoolCount: 1,
        skippedInvalidUnitCount: 1,
        skippedUntrackedCount: 5_231,
      },
      knownPoolIndex: createKnownPoolIdentityIndex(),
      contractMetaByChainAddress: new Map(),
      metrics: new Map(),
      priceObservations: new Map(),
      chainAddressToId: new Map([[buildChainAddressKey("solana", "tracked-mint"), "tracked-stablecoin"]]),
      symbolToChainScopedIds: new Map(),
      symbolToIds: new Map(),
      validationReferences: {} as never,
      stablecoinPriceById: new Map(),
    });

    expect(result.directApiSkippedInvalidUnits).toBe(1);
    expect(result.directApiSkippedUntracked).toBe(5_231);
    expect(result.directApiSkippedBelowTvlThreshold).toBe(1);
    expect(result.excludedByReason).toEqual({
      invalid_units: 1,
      untracked_token: 5_231,
      below_tvl_threshold: 1,
    });
  });

  it("counts invalid direct API units before tracking and identity processing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const directApiPools: DexApiPool[] = [
      {
        source: "meteora",
        chain: "solana",
        poolAddress: "pool-invalid",
        poolType: "meteora-dlmm",
        tokens: [
          { address: "token-a", symbol: "AAA", decimals: 6 },
          { address: "token-b", symbol: "BBB", decimals: 6 },
        ],
        price: 1,
        tvlUsd: Number.NaN,
        volume24hUsd: 50_000,
        feeRate: null,
        balances: [500_000, 500_000],
      },
    ];

    const result = await integrateDirectApiLiquidityPhase({
      directApiPools,
      knownPoolIndex: createKnownPoolIdentityIndex(),
      contractMetaByChainAddress: new Map(),
      metrics: new Map(),
      priceObservations: new Map(),
      chainAddressToId: new Map([["solana:token-a", "aaa-test"]]),
      symbolToChainScopedIds: new Map(),
      symbolToIds: new Map(),
      validationReferences: {} as never,
      stablecoinPriceById: new Map(),
    });

    expect(result.directApiSkippedInvalidUnits).toBe(1);
    expect(result.directApiSkippedUntracked).toBe(0);
    expect(result.excludedByReason).toEqual({ invalid_units: 1 });
    expect(logSpy).not.toHaveBeenCalledWith("[dex-liquidity] Fetched 1 direct API pools total");
  });

  it("counts tracked direct API pools filtered by the TVL threshold", async () => {
    const poolAddress = "0x0000000000000000000000000000000000000abc";
    const directApiPools: DexApiPool[] = [
      {
        source: "balancer",
        chain: "ethereum",
        poolAddress,
        poolType: "balancer-stable",
        tokens: [
          { address: "0x00000000000000000000000000000000000000a1", symbol: "USDt", decimals: 6 },
          { address: "0x00000000000000000000000000000000000000b2", symbol: "USDC", decimals: 6 },
        ],
        price: 1,
        tvlUsd: 9_999,
        volume24hUsd: 500,
        feeRate: null,
        balances: [5_000, 5_000],
      },
    ];

    const result = await integrateDirectApiLiquidityPhase({
      directApiPools,
      knownPoolIndex: createKnownPoolIdentityIndex(),
      contractMetaByChainAddress: new Map(),
      metrics: new Map(),
      priceObservations: new Map(),
      chainAddressToId: new Map([["ethereum:0x00000000000000000000000000000000000000a1", "usdt-tether"]]),
      symbolToChainScopedIds: new Map(),
      symbolToIds: new Map(),
      validationReferences: {} as never,
      stablecoinPriceById: new Map(),
    });

    expect(result.directApiSkippedBelowTvlThreshold).toBe(1);
    expect(result.directApiSkippedAboveTvlSanityCap).toBe(0);
    expect(result.acceptedByProtocolChain).toEqual({});
    expect(result.excludedByReason).toEqual({ below_tvl_threshold: 1 });
  });

  it("enriches an exact primary duplicate with supported execution evidence without double counting", async () => {
    const knownPoolIndex = createKnownPoolIdentityIndex();
    knownPoolIndex.exactKeys.add(`solana:${SOLANA_POOL_ADDRESS}`);
    const usdcMetrics = initMetrics("usdc-circle", "USDC");
    usdcMetrics.totalTvlUsd = 4_000_000;
    usdcMetrics.poolCount = 1;
    usdcMetrics.topPools.push({
      poolId: `solana:${SOLANA_POOL_ADDRESS}`,
      project: "raydium",
      chain: "Solana",
      tvlUsd: 4_000_000,
      symbol: "USDC / USDT",
      volumeUsd1d: 100_000,
      poolType: "raydium-amm",
      source: "dl",
    });
    const metrics = new Map([["usdc-circle", usdcMetrics]]);
    const priceObservations = new Map();
    const result = await runDirectApiScenario({
      knownPoolIndex,
      metrics,
      priceObservations,
    });

    expect(result.directApiDedupSkippedByAddress).toBe(1);
    expect(usdcMetrics.totalTvlUsd).toBe(4_000_000);
    expect(usdcMetrics.poolCount).toBe(1);
    expect(usdcMetrics.topPools).toHaveLength(1);
    expect(usdcMetrics.topPools[0]?.extra?.ammExecutionModel).toMatchObject({
      invariant: "constant-product",
      trackedTokenIndex: 0,
    });
    expect(priceObservations.get("usdc-circle")).toEqual([
      expect.objectContaining({
        price: 1,
        tvl: 4_000_000,
        poolKey: `solana:${SOLANA_POOL_ADDRESS}`,
        identityConfidence: "exact",
        sourceFamily: "direct_api",
      }),
    ]);
  });

  it("drops exact duplicate evidence when no matching primary top-pool row was counted", async () => {
    const knownPoolIndex = createKnownPoolIdentityIndex();
    knownPoolIndex.exactKeys.add(`solana:${SOLANA_POOL_ADDRESS}`);
    const metrics = new Map();
    const priceObservations = new Map();

    const result = await runDirectApiScenario({
      knownPoolIndex,
      metrics,
      priceObservations,
    });

    expect(result.directApiDedupSkippedByAddress).toBe(1);
    expect(metrics.size).toBe(0);
    expect(priceObservations.get("usdc-circle")).toEqual([
      expect.objectContaining({
        poolKey: `solana:${SOLANA_POOL_ADDRESS}`,
        identityConfidence: "exact",
        sourceFamily: "direct_api",
      }),
    ]);
  });

  it("does not overwrite retained exact-pool evidence when protocol compatibility fails", async () => {
    const knownPoolIndex = createKnownPoolIdentityIndex();
    knownPoolIndex.exactKeys.add(`solana:${SOLANA_POOL_ADDRESS}`);
    const usdcMetrics = initMetrics("usdc-circle", "USDC");
    usdcMetrics.totalTvlUsd = 4_000_000;
    usdcMetrics.poolCount = 1;
    usdcMetrics.topPools.push({
      poolId: `solana:${SOLANA_POOL_ADDRESS}`,
      project: "retained-primary-protocol",
      chain: "Solana",
      tvlUsd: 4_000_000,
      symbol: "USDC / USDT",
      volumeUsd1d: 100_000,
      poolType: "primary-stable",
      source: "dl",
      extra: {
        ammExecutionModel: {
          source: "balancer",
          invariant: "stableswap",
          trackedTokenIndex: 0,
          feeRate: 0.0001,
          tokens: [
            {
              address: "UsdcMint",
              symbol: "USDC",
              decimals: 6,
              balance: 2_000_000,
              referencePriceUsd: 1,
              referencePriceSource: "tracked-market",
            },
            {
              address: "UsdtMint",
              symbol: "USDT",
              decimals: 6,
              balance: 2_000_000,
              referencePriceUsd: 1,
              referencePriceSource: "tracked-market",
            },
          ],
        },
      },
    });
    const metrics = new Map([["usdc-circle", usdcMetrics]]);

    await runDirectApiScenario({
      knownPoolIndex,
      metrics,
      priceObservations: new Map(),
    });

    expect(usdcMetrics.totalTvlUsd).toBe(4_000_000);
    expect(usdcMetrics.poolCount).toBe(1);
    expect(usdcMetrics.topPools[0]?.extra?.ammExecutionModel).toMatchObject({
      source: "balancer",
      invariant: "stableswap",
      feeRate: 0.0001,
    });
  });
});
