import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDexApiFetchResult, type DexApiPool } from "../../../lib/dex-api-common";
import {
  buildDexDirectApiFetchers,
  integrateDirectApiLiquidityPhase,
  type DirectApiCensusScope,
} from "../orchestrator-phases/direct-api";
import { fetchDirectApiFixture } from "../../__tests__/dex-liquidity-direct-api.test-support";
import { buildAuthoritativeStagedPoolConfirmationIndex } from "../orchestrator-phases/authoritative";
import { createKnownPoolIdentityIndex } from "../pool-identity";
import { initSourcePoolGraph } from "../pool-helpers";
import { buildChainAddressKey } from "../token-resolution";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { computeDexPrices } from "../dex-price-publisher";
import { filterRetainedPools, projectRetainedPoolPrice } from "../scoring-helpers";
import { readPublicPriceRows, seedPublishedDexGeneration } from "./scoring-test-support";

const SOLANA_POOL_ADDRESS = "11111111111111111111111111111112";
const SOLANA_USDC_MINT = "UsdcMint";
const SOLANA_USDT_MINT = "UsdtMint";

function makeSolanaDirectPool(overrides: Partial<DexApiPool> = {}): DexApiPool {
  return {
    source: "raydium",
    chain: "solana",
    poolAddress: SOLANA_POOL_ADDRESS,
    poolType: "raydium-amm",
    tokens: [
      { address: SOLANA_USDC_MINT, symbol: "USDC", decimals: 6, priceUsd: 1 },
      { address: SOLANA_USDT_MINT, symbol: "USDT", decimals: 6, priceUsd: 1 },
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
  const params = {
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
  };
  const phase = await fetchDirectApiFixture([{
    name: "fixture", circuitKey: "fixture", normalizedProtocol: "fixture", supportedChains: [],
    censusScope: "bounded-sample", result: makeDexApiFetchResult(params.directApiPools, { ok: true, degraded: false, errors: [] }),
  }], params);
  return integrateDirectApiLiquidityPhase({ ...params, directApiPools: phase.pools, preprocessedPoolCounts: phase.counts });
}

describe("integrateDirectApiLiquidityPhase", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers exact ids for sub-threshold direct API pools so staged duplicates cannot re-add them", async () => {
    const poolAddress = "0x4ba45fb7de134bcb24a6053bbe21c3a4be9f85ea";
    const directApiPools: DexApiPool[] = [
      makeSolanaDirectPool({
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
        balancesNormalized: undefined,
      }),
    ];

    const knownPoolIndex = createKnownPoolIdentityIndex();
    const metrics = new Map();
    const priceObservations = new Map();
    await runDirectApiScenario({
      directApiPools,
      knownPoolIndex,
      metrics,
      priceObservations,
      chainAddressToId: new Map([["plasma:0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", "usdai-usd-ai"]]),
      stablecoinPriceById: new Map(),
    });

    expect(metrics.size).toBe(0);
    expect(priceObservations.size).toBe(0);
    expect(knownPoolIndex.exactKeys.has(`plasma:${poolAddress}`)).toBe(true);
    expect(knownPoolIndex.exactStablecoinIdsByKey.get(`plasma:${poolAddress}`)).toEqual(new Set(["usdai-usd-ai"]));
  });

  it("skips untracked direct API pools before identity processing", async () => {
    const result = await runDirectApiScenario({
      directApiPools: [
        makeSolanaDirectPool({
          poolAddress: "pool-untracked",
          tokens: [
            { address: "token-a", symbol: "AAA", decimals: 6 },
            { address: "token-b", symbol: "BBB", decimals: 6 },
          ],
          tvlUsd: 1_000_000,
          volume24hUsd: 50_000,
          feeRate: null,
          balances: [500_000, 500_000],
          balancesNormalized: undefined,
        }),
      ],
      chainAddressToId: new Map(),
      stablecoinPriceById: new Map(),
    });

    expect(result.directApiSkippedUntracked).toBe(1);
    expect(result.directApiDedupSkippedByAddress).toBe(0);
    expect(result.excludedByReason).toEqual({ untracked_token: 1 });
  });

  it("compacts direct results before identity work without losing raw source evidence", async () => {
    const rawPoolCount = 5;
    const retainedPoolCount = 2;
    const trackedAddress = "0x1111111111111111111111111111111111111111";
    const hexAddr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    const makePool = (index: number, tracked: boolean): DexApiPool => makeSolanaDirectPool({
      source: "balancer",
      chain: "ethereum",
      poolAddress: hexAddr(tracked ? index : index + retainedPoolCount),
      poolType: "balancer-stable",
      tokens: [
        { address: tracked ? trackedAddress : hexAddr(index + rawPoolCount), symbol: tracked ? "TRACKED" : "UNKNOWN", decimals: 6 },
        { address: hexAddr(index + rawPoolCount * 2), symbol: "QUOTE", decimals: 6 },
      ],
      tvlUsd: 1_000_000,
      volume24hUsd: 50_000,
      feeRate: null,
      balances: [500_000, 500_000],
      balancesNormalized: undefined,
    });
    const rawPools = [
      ...Array.from({ length: retainedPoolCount }, (_, index) => makePool(index, true)),
      ...Array.from({ length: rawPoolCount - retainedPoolCount }, (_, index) => makePool(index, false)),
    ];
    const pagination = {
      state: "partial" as const,
      headRefreshed: true,
      pagesFetched: 50,
      cursor: "next-page",
      cycleCompleted: false,
    };
    const compacted = await fetchDirectApiFixture([{
      name: "Balancer",
      circuitKey: "balancer-api",
      normalizedProtocol: "balancer",
      supportedChains: ["ethereum"],
      censusScope: "exhaustive",
      result: makeDexApiFetchResult(rawPools, { ok: true, degraded: false, errors: [], pagination }),
    }], {
      chainAddressToId: new Map([[buildChainAddressKey("ethereum", trackedAddress), "tracked-stablecoin"]]),
      symbolToChainScopedIds: new Map(),
      contractMetaByChainAddress: new Map(),
    });
    const authoritativeConfirmation = buildAuthoritativeStagedPoolConfirmationIndex(compacted.results);

    expect(compacted.counts).toEqual({
      rawPoolCount,
      retainedPoolCount,
      skippedInvalidUnitCount: 0,
      skippedUntrackedCount: 3,
    });
    expect(compacted.pools).toHaveLength(retainedPoolCount);
    expect(compacted.results[0]?.result.pools).toHaveLength(retainedPoolCount);
    expect(compacted.results[0]?.result.pagination).toEqual(pagination);
    expect(compacted.sourceWarnings).toEqual([]);
    expect(compacted.results[0]?.authoritativeExactPoolKeys).toContain(`ethereum:${hexAddr(rawPoolCount - 1)}`);
    expect(authoritativeConfirmation.confirmedExactKeysByProtocol.has("balancer")).toBe(false);
  });

  it("keeps Fluid pools out of the measured-execution routing after the overlay removal", async () => {
    const poolAddress = "0x218c659b6bbb73d47c7926fc90d9893342534b84";
    const paxg = "0x45804880de22913dafe09f4980848ece6ecbaf78";
    const xaut = "0x68749665ff8d2d112fa859aa293f07a622782f38";
    const compacted = await fetchDirectApiFixture([{
      name: "Fluid",
      circuitKey: "fluid-dex-api",
      normalizedProtocol: "fluid",
      supportedChains: ["ethereum"],
      censusScope: "bounded-sample",
      result: makeDexApiFetchResult([makeSolanaDirectPool({
        source: "fluid",
        chain: "ethereum",
        poolAddress,
        poolType: "fluid-dex",
        tokens: [
          { address: paxg, symbol: "PAXG", decimals: 18 },
          { address: xaut, symbol: "XAUT", decimals: 6 },
        ],
        tvlUsd: 2_000_000,
        volume24hUsd: 0,
        feeRate: 0.0005,
        balances: [2_000, 2_000],
        balancesNormalized: undefined,
      })], { ok: true, degraded: false, errors: [] }),
    }], {
      chainAddressToId: new Map([
        [buildChainAddressKey("ethereum", paxg), "paxg-paxos"],
        [buildChainAddressKey("ethereum", xaut), "xaut-tether"],
      ]),
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

  it("counts invalid direct API units before tracking and identity processing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runDirectApiScenario({
      directApiPools: [
        makeSolanaDirectPool({
          source: "meteora",
          poolAddress: "pool-invalid",
          poolType: "meteora-dlmm",
          tokens: [
            { address: "token-a", symbol: "AAA", decimals: 6 },
            { address: "token-b", symbol: "BBB", decimals: 6 },
          ],
          tvlUsd: Number.NaN,
          volume24hUsd: 50_000,
          feeRate: null,
          balances: [500_000, 500_000],
          balancesNormalized: undefined,
        }),
      ],
      chainAddressToId: new Map([["solana:token-a", "aaa-test"]]),
      stablecoinPriceById: new Map(),
    });

    expect(result.directApiSkippedInvalidUnits).toBe(1);
    expect(result.directApiSkippedUntracked).toBe(0);
    expect(result.excludedByReason).toEqual({ invalid_units: 1 });
    expect(logSpy).not.toHaveBeenCalledWith("[dex-liquidity] Fetched 1 direct API pools total");
  });

  it("counts tracked direct API pools filtered by the TVL threshold", async () => {
    const result = await runDirectApiScenario({
      directApiPools: [
        makeSolanaDirectPool({
          source: "balancer",
          chain: "ethereum",
          poolAddress: "0x0000000000000000000000000000000000000abc",
          poolType: "balancer-stable",
          tokens: [
            { address: "0x00000000000000000000000000000000000000a1", symbol: "USDt", decimals: 6 },
            { address: "0x00000000000000000000000000000000000000b2", symbol: "USDC", decimals: 6 },
          ],
          tvlUsd: 9_999,
          volume24hUsd: 500,
          feeRate: null,
          balances: [5_000, 5_000],
          balancesNormalized: undefined,
        }),
      ],
      chainAddressToId: new Map([["ethereum:0x00000000000000000000000000000000000000a1", "usdt-tether"]]),
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
    const usdcMetrics = initSourcePoolGraph("usdc-circle", "USDC");
    usdcMetrics.pools.push({
      poolId: `solana:${SOLANA_POOL_ADDRESS}`,
      project: "raydium",
      chain: "Solana",
      tvlUsd: 4_000_000,
      symbol: "USDT-USDC",
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
    expect(usdcMetrics.pools.reduce((total, pool) => total + pool.tvlUsd, 0)).toBe(4_000_000);
    expect(usdcMetrics.pools.length).toBe(1);
    expect(usdcMetrics.pools).toHaveLength(1);
    expect(usdcMetrics.pools[0]?.extra?.ammExecutionModel).toMatchObject({
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

  it.each([
    ["new", -30, -60, true],
    ["new", undefined, -60, false],
    ["new", 1, -60, false],
    ["new", -4_500, -60, false],
    ["new", -30, undefined, false],
    ["exact", -120, -60, true],
    ["exact", undefined, -60, false],
    ["incompatible", -30, -60, false],
  ] as const)("admits a ratio through retention and publication only with both clocks and compatible identity (%s, %s, %s)", async (mode, ratioOffset, markOffset, admitted) => {
    const nowSec = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const poolKey = `solana:${SOLANA_POOL_ADDRESS}`;
    const ratioObservedAtSec = ratioOffset == null ? undefined : nowSec + ratioOffset;
    const mark = markOffset == null ? undefined : { priceUsd: 0.87, observedAtSec: nowSec + markOffset, source: "coinbase+kraken" };
    const pool = makeSolanaDirectPool({ price: 1 / 0.87, ratioObservedAtSec });
    for (const token of pool.tokens) delete token.priceUsd;
    const stablecoinPriceById = Object.assign(new Map([["usdt-tether", 0.87]]), {
      marketMarks: new Map(mark ? [["usdt-tether", mark]] : []),
    });
    const knownPoolIndex = createKnownPoolIdentityIndex();
    const metric = initSourcePoolGraph("usdc-circle", "USDC");
    const metrics = new Map([["usdc-circle", metric]]);
    const priceObservations = new Map();
    if (mode !== "new") {
      knownPoolIndex.exactKeys.add(poolKey);
      metric.pools.push({ poolId: poolKey, project: mode === "exact" ? "raydium" : "orca", chain: "solana",
        tvlUsd: 5_000_000, symbol: "USDT / USDC", volumeUsd1d: 100_000, poolType: "raydium-amm", source: "dl" });
    }
    await runDirectApiScenario({ knownPoolIndex, metrics, priceObservations, directApiPools: [pool], stablecoinPriceById });
    const retained = filterRetainedPools(metric.pools);
    const observedAt = admitted ? Math.min(ratioObservedAtSec!, mark!.observedAtSec) : undefined;
    expect(retained).toEqual([expect.objectContaining({
      poolId: poolKey, source: mode === "new" ? "direct_api" : "dl", tvlUsd: mode === "new" ? 4_000_000 : 5_000_000,
    })]);
    const counterpartyPrice = { ...mark, stablecoinId: "usdt-tether" };
    const observation = expect.objectContaining({
      price: expect.closeTo(1), observedAt, poolKey, identityConfidence: "exact", sourceFamily: "direct_api",
      counterpartyPrice,
    });
    expect(retained[0]?.price).toEqual(admitted ? expect.closeTo(1) : undefined);
    expect(retained[0]?.priceObservedAt).toBe(observedAt);
    expect(retained[0]?.priceCounterparty).toEqual(admitted ? counterpartyPrice : undefined);
    expect(projectRetainedPoolPrice(retained[0]!)).toEqual(admitted ? observation : null);
    expect(priceObservations.get("usdc-circle")).toEqual(admitted ? [observation] : undefined);
    const { db, sqlite, generationId } = seedPublishedDexGeneration({ nowSec });
    try {
      await computeDexPrices({ db, generationId, nowSec, retainedPoolsByStablecoin: new Map([["usdc-circle", retained]]),
        exactPriceEvidenceByStablecoin: priceObservations, primaryPrices: new Map([["usdc-circle", 1]]) });
      const rows = readPublicPriceRows(sqlite);
      expect(rows).toEqual(admitted ? [expect.objectContaining({
        stablecoin_id: "usdc-circle", dex_price_usd: expect.closeTo(1), source_pool_count: 1, source_total_tvl: 4_000_000,
      })] : []);
      if (admitted) expect(JSON.parse(rows[0]!.price_sources_json!).displaySources).toEqual([expect.objectContaining({
        protocol: "raydium", observedAt, aggregateObservedAt: null, displayAggregateObservedAt: observedAt,
        upstreamKeys: [poolKey, "venue:coinbase", "venue:kraken"], sourceFamily: "direct_api",
      })]);
    } finally {
      sqlite.close();
    }
  });

  it("does not overwrite retained exact-pool evidence when protocol compatibility fails", async () => {
    const knownPoolIndex = createKnownPoolIdentityIndex();
    knownPoolIndex.exactKeys.add(`solana:${SOLANA_POOL_ADDRESS}`);
    const usdcMetrics = initSourcePoolGraph("usdc-circle", "USDC");
    usdcMetrics.pools.push({
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

    expect(usdcMetrics.pools.reduce((total, pool) => total + pool.tvlUsd, 0)).toBe(4_000_000);
    expect(usdcMetrics.pools.length).toBe(1);
    expect(usdcMetrics.pools[0]?.extra?.ammExecutionModel).toMatchObject({
      source: "balancer",
      invariant: "stableswap",
      feeRate: 0.0001,
    });
  });

  it.each([100_000, 0, null])("retains PancakeSwap's own clock for volume %s and keeps empty chain counts", async (volume24hUsd) => {
    const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const usdt = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const volumeWindowEndSec = 1_800_000_000;
    const pancakeEthereumPool = {
      ...makeSolanaDirectPool({
        source: "pancakeswap", chain: "ethereum", volume24hUsd,
        poolAddress: "0x00000000000000000000000000000000000000aa", poolType: "pancakeswap-v3-1bp",
        tokens: [
          { address: usdc, symbol: "USDC", decimals: 6 },
          { address: usdt, symbol: "USDT", decimals: 6 },
        ],
      }),
      volumeWindowEndSec: volume24hUsd == null ? null : volumeWindowEndSec,
    };
    const metrics = new Map();

    const result = await runDirectApiScenario({
      directApiPools: [pancakeEthereumPool],
      metrics,
      volumeObservedAtSec: volumeWindowEndSec + 600,
      chainAddressToId: new Map([
        [buildChainAddressKey("ethereum", usdc), "usdc-circle"],
        [buildChainAddressKey("ethereum", usdt), "usdt-tether"],
      ]),
      stablecoinPriceById: new Map([["usdc-circle", 1], ["usdt-tether", 1]]),
      attemptedProtocolChains: ["pancakeswap:bsc", "pancakeswap:ethereum", "pancakeswap:base"],
    });

    // BSC failed while its siblings answered: the explicit zero is the telemetry,
    // not the silence that let a frozen chain hide for six days.
    expect(result.acceptedByProtocolChain).toEqual({
      "pancakeswap:bsc": 0,
      "pancakeswap:ethereum": 1,
      "pancakeswap:base": 0,
    });
    expect(metrics.get("usdc-circle")?.pools[0]?.volumeReading).toMatchObject({
      volume24hUsd,
      observedAtSec: pancakeEthereumPool.volumeWindowEndSec,
    });
  });
});

const ETHEREUM_POOL_KEY = "ethereum:0x4ba45fb7de134bcb24a6053bbe21c3a4be9f85ea";

describe("buildAuthoritativeStagedPoolConfirmationIndex", () => {
  type AuthEntry = Parameters<typeof buildAuthoritativeStagedPoolConfirmationIndex>[0][number];
  function makeAuthEntry(overrides: Partial<AuthEntry> = {}): AuthEntry {
    return {
      name: "Balancer",
      circuitKey: "balancer-api",
      normalizedProtocol: "balancer",
      supportedChains: ["ethereum"],
      censusScope: "exhaustive",
      authoritativeExactPoolKeys: new Set([ETHEREUM_POOL_KEY]),
      result: { pools: [], ok: true, degraded: false, errors: [] },
      ...overrides,
    };
  }

  it("requires positive exhaustive authority even when raw identities and a healthy result exist", () => {
    const entry = makeAuthEntry({ name: "Undeclared", circuitKey: "undeclared-api", normalizedProtocol: "undeclared" });
    Reflect.deleteProperty(entry, "censusScope");
    const index = buildAuthoritativeStagedPoolConfirmationIndex([entry]);
    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });

  it.each([
    {
      label: "an exhaustive census legitimately found no pools",
      entry: makeAuthEntry({ supportedChains: ["ethereum", "plasma"] }),
      chains: ["ethereum", "plasma"],
    },
    {
      label: "warning-only authoritative protocol fetches",
      entry: makeAuthEntry({
        result: { pools: [], ok: true, degraded: false, errors: [], warnings: ["page 1 skipped 1 malformed pool rows"] },
      }),
      chains: ["ethereum"],
    },
  ])("enforces confirmation when $label", ({ entry, chains }) => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([entry]);
    expect(index.enforcedChainsByProtocol.get("balancer")).toEqual(new Set(chains));
    expect(index.confirmedExactKeysByProtocol.get("balancer")).toEqual(new Set([ETHEREUM_POOL_KEY]));
  });

  it.each<{ name: string; entry: AuthEntry }>([
    {
      name: "fails open when the authoritative fetch has a real failure",
      entry: makeAuthEntry({ supportedChains: ["plasma"], result: { pools: [], ok: true, degraded: true, errors: ["partial"] } }),
    },
    {
      name: "fails open when the authoritative fetch has mixed warnings and real failures",
      entry: makeAuthEntry({
        result: {
          pools: [],
          ok: true,
          degraded: true,
          errors: ["balancer page 2 returned 503"],
          warnings: ["page 1 skipped 1 malformed pool rows"],
        },
      }),
    },
    {
      name: "fails open while a paginated authoritative inventory is incomplete",
      entry: makeAuthEntry({
        name: "PancakeSwap",
        circuitKey: "pancakeswap-api",
        normalizedProtocol: "pancakeswap",
        supportedChains: ["bsc"],
        result: {
          pools: [],
          ok: true,
          degraded: false,
          errors: [],
          pagination: { state: "partial", headRefreshed: true, pagesFetched: 3, cursor: "750", cycleCompleted: false },
        },
      }),
    },
    {
      name: "never enforces from a bounded-sample census",
      entry: makeAuthEntry({
        name: "Meteora",
        circuitKey: "meteora-api",
        normalizedProtocol: "meteora",
        supportedChains: ["solana"],
        censusScope: "bounded-sample",
        authoritativeExactPoolKeys: new Set(["solana:5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"]),
      }),
    },
    {
      name: "never enforces when the census produced no identity at all",
      entry: makeAuthEntry({
        name: "Aerodrome Slipstream",
        circuitKey: "aerodrome-slipstream-api",
        normalizedProtocol: "aerodrome",
        supportedChains: ["base"],
        authoritativeExactPoolKeys: new Set<string>(),
      }),
    },
    {
      name: "never enforces from the compacted tracked-token pool list",
      entry: makeAuthEntry({
        name: "Orca",
        circuitKey: "orca-api",
        normalizedProtocol: "orca",
        supportedChains: ["solana"],
        authoritativeExactPoolKeys: undefined,
        result: {
          pools: [makeSolanaDirectPool({
            source: "orca",
            poolAddress: "2D9mokxthTheNAU6hCWGRXdNmhNQoypHs1JcRCbwkgLL",
            poolType: "orca-whirlpool",
            price: 100,
            tvlUsd: 1_000_000,
            volume24hUsd: 0,
            feeRate: null,
            balances: null,
          })],
          ok: true,
          degraded: false,
          errors: [],
        },
      }),
    },
  ])("$name", ({ entry }) => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([entry]);

    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });
});

describe("direct API census scope declarations", () => {
  // One matrix enrolls every descriptor's maximum authority and stop policy.
  // Completion must describe this run, never a resumed multi-run rotation.
  const contracts: { name: string; censusScope: DirectApiCensusScope; stop: string }[] = [
    { name: "Fluid", censusScope: "bounded-sample", stop: "tracked-token extract" },
    { name: "Balancer", censusScope: "exhaustive", stop: "short page; full page at cap is partial" },
    { name: "PancakeSwap", censusScope: "bounded-sample", stop: "head plus two rotating tail pages" },
    { name: "Meteora", censusScope: "bounded-sample", stop: "three-page head sample" },
    { name: "Raydium", censusScope: "exhaustive", stop: "short page or below admission floor; cap is partial" },
    { name: "Orca", censusScope: "exhaustive", stop: "four-page budget; contiguous exhausted run only" },
    { name: "Aerodrome Slipstream", censusScope: "bounded-sample", stop: "tracked priceable reserve extract" },
    { name: "Uniswap V3 BSC shadow", censusScope: "bounded-sample", stop: "bounded staged exact-pool recovery" },
  ];
  const fetchers = buildDexDirectApiFetchers({
    db: makeNoopD1(),
    graphApiKey: null,
    chainAddressToId: new Map(),
    symbolToChainScopedIds: new Map(),
    stablecoinPriceById: new Map(),
  });

  it.each(contracts)("$name declares its $stop census contract", ({ name, censusScope }) => {
    const fetcher = fetchers.find((adapter) => adapter.name === name)!;
    expect(fetcher.censusScope).toBe(censusScope);
    for (const scan of ["exhausted", "capped", "later-page-failure", "malformed-identity", "resumed-tail"] as const) {
      const chain = fetcher.supportedChains[0];
      const index = buildAuthoritativeStagedPoolConfirmationIndex([{
        ...fetcher,
        authoritativeExactPoolKeys: new Set([`${chain}:pool`]),
        result: {
          pools: [], ok: true, degraded: scan === "later-page-failure", errors: [],
          physicalPoolCensus: { exactPoolKeys: [`${chain}:pool`], incompleteChains: scan === "malformed-identity" ? [chain] : [] },
          pagination: {
            state: scan === "exhausted" || scan === "malformed-identity" ? "complete" : "partial",
            headRefreshed: true, pagesFetched: 1, cursor: scan === "exhausted" ? null : "tail",
            cycleCompleted: scan === "exhausted" || scan === "malformed-identity" || scan === "resumed-tail",
          },
        },
      }]);
      expect(index.enforcedChainsByProtocol.get(fetcher.normalizedProtocol)?.has(chain) ?? false,
        `${name}: ${scan}`).toBe(censusScope === "exhaustive" && scan === "exhausted");
    }
  });
});
