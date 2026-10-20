import { afterEach, describe, expect, it, vi } from "vitest";
import { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-capacity";
import { DEX_ROUTE_CAPABILITY_MATRIX_VERSION } from "@shared/lib/p4-exit-route-capability-policy";
import type { CurvePoolEntry, LlamaPool, PoolEntry } from "../dex-liquidity/types";
import { mergeStagedPools } from "../dex-liquidity/staging-merge";
import { createKnownPoolIdentityIndex } from "../dex-liquidity/pool-identity";
import { makeStagedPoolRow } from "../dex-liquidity/__tests__/staging-merge.test-support";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { processPoolMetrics } from "../dex-liquidity/process-pools";
import { buildPoolFingerprint } from "../dex-liquidity/pool-helpers";
import { accumulateGlobalAggregate, rebuildMetricsFromPools, summarizeRetainedPoolVolume, type GlobalPoolAggregateEntry } from "../dex-liquidity/scoring-helpers";
import { buildChainAddressToId, buildSymbolToChainScopedIds } from "./dex-liquidity-fixtures";
import {
  buildUniswapV4ExecutionCandidateKey,
  type UniswapV4ExecutionCandidate,
} from "../measured-execution/inventory";
import {
  UNISWAP_V4_HOOK_FREE_ADDRESS,
  computeUniswapV4PoolId,
} from "../measured-execution/uniswap-v4";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { computeStablecoinScores } from "../dex-liquidity/scoring";
import { persistScores } from "../dex-liquidity/persistence";

function makePool(overrides: Partial<LlamaPool>): LlamaPool {
  return {
    pool: "0xpool",
    chain: "Ethereum",
    project: "curve",
    symbol: "USDT-USDC",
    tvlUsd: 100_000,
    volumeUsd1d: 10_000,
    volumeUsd7d: 70_000,
    stablecoin: true,
    underlyingTokens: null,
    apyBase: null,
    apyReward: null,
    apy: 0,
    sigma: 0,
    exposure: "multi",
    count: 0,
    ...overrides,
  };
}

function makeCurveEntry(overrides: Partial<CurvePoolEntry>): CurvePoolEntry {
  return {
    A: 100,
    balanceRatio: 0.8,
    tvl: 1_000_000,
    registryId: "stableswap",
    isMetaPool: false,
    metapoolAdjustedTvl: 900_000,
    creationTs: 0,
    balanceDetails: [],
    tokenPrices: {},
    ...overrides,
  };
}

describe("processPoolMetrics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { ratio: null, scope: "full-pool", measured: false },
    { ratio: 0, scope: "full-pool", measured: true },
    { ratio: null, scope: "base-pool-excluded", measured: false },
    { ratio: 0.5, scope: "base-pool-excluded", measured: false },
  ] as const)("persists Curve balance availability and scope ($ratio, $scope)", async ({ ratio, scope, measured }) => {
    const { db, sqlite } = createLatestSchemaSqlite();
    const nowSec = 1_790_000_000;
    try {
      const { metrics } = processPoolMetrics({
        pools: [makePool({
          pool: "0xcurve", symbol: "USDC-USDT", count: 365, apyBase: 1, apy: 1,
        })],
        dexProjects: new Set(["curve"]),
        symbolToChainScopedIds: buildSymbolToChainScopedIds(new Map([["USDC", ["usdc-circle"]]]), ["ethereum"]),
        chainAddressToId: new Map(),
        curvePoolMap: new Map([["ethereum:0xcurve", makeCurveEntry({
          balanceRatio: ratio,
          balanceDetails: ratio == null ? undefined : [
            { symbol: "USDC", balancePct: 0, isTracked: true },
            { symbol: "USDT", balancePct: 100, isTracked: false },
          ],
          tvl: scope === "full-pool" ? 100_000 : 200_000,
          metapoolAdjustedTvl: 100_000, isMetaPool: scope !== "full-pool",
          balanceTvlScope: "full-pool", contributionTvlScope: scope,
        })]]),
        uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(), volumeObservedAtSec: nowSec,
      });
      const processed = metrics.get("usdc-circle")!.topPools[0]!;
      expect(processed.extra?.measurement?.balanceMeasured).toBe(measured);
      expect(processed.extra?.balanceRatio).toBe(measured ? 0 : undefined);
      expect(processed.extra?.balanceDetails).toEqual(measured ? [
        { symbol: "USDC", balancePct: 0, isTracked: true },
        { symbol: "USDT", balancePct: 100, isTracked: false },
      ] : undefined);
      expect(processed.extra?.qualityAdjustedTvl).toBe(measured ? 0 : 85_000);
      expect(processed.extra?.effectiveTvl).toBe(measured ? 0 : 85_000);
      expect(processed.extra?.stressIndex).toBe(measured ? 35 : 0);
      const scored = await computeStablecoinScores(
        db, metrics, new Map(), undefined, nowSec, new Map(), undefined, new Map(), "none", nowSec,
      );
      expect(scored.scores.get("usdc-circle")).toMatchObject({
        weightedBalanceRatio: measured ? 0 : null,
        balanceMeasuredTvlUsd: measured ? 100_000 : 0,
      });
      await persistScores(db, metrics, scored.scores, scored.globalAgg, nowSec);
      const stored = sqlite.prepare(
        "SELECT top_pools_json, weighted_balance_ratio, balance_measured_tvl_usd FROM dex_liquidity WHERE stablecoin_id = ?",
      ).get("usdc-circle") as {
        top_pools_json: string; weighted_balance_ratio: number | null; balance_measured_tvl_usd: number;
      };
      expect(stored.weighted_balance_ratio).toBe(measured ? 0 : null);
      expect(stored.balance_measured_tvl_usd).toBe(measured ? 100_000 : 0);
      const storedPools: PoolEntry[] = JSON.parse(stored.top_pools_json);
      expect(storedPools[0]?.extra?.measurement?.balanceMeasured).toBe(measured);
      expect(storedPools[0]?.extra?.balanceRatio).toBe(measured ? 0 : undefined);
      expect(storedPools[0]?.extra?.balanceDetails).toEqual(processed.extra?.balanceDetails);
    } finally {
      sqlite.close();
    }
  });

  it("retains same-pair UUID deployments and counts identical provider repeats once per coin and globally", () => {
    const first = makePool({ pool: "10000000-0000-4000-8000-000000000000", project: "uniswap-v3",
      underlyingTokens: ["0xusdc", "0xusdt"], poolMeta: "0.01%" });
    const second = { ...first, pool: "20000000-0000-4000-8000-000000000000", tvlUsd: 200_000, poolMeta: "0.05%" };
    const { metrics, rejections } = processPoolMetrics({
      pools: [first, { ...first }, second],
      dexProjects: new Set(["uniswap-v3"]),
      symbolToChainScopedIds: new Map(),
      chainAddressToId: new Map([["ethereum:0xusdc", "usdc-circle"], ["ethereum:0xusdt", "usdt-tether"]]),
      curvePoolMap: new Map(), uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(), volumeObservedAtSec: 1000,
    });
    expect(rejections).toEqual([]);
    for (const metric of metrics.values()) {
      expect(rebuildMetricsFromPools(metric.topPools)).toMatchObject({ totalTvlUsd: 300_000, poolCount: 2 });
      expect(metric.topPools.map((pool) => pool.poolId)).toEqual([
        `ethereum:defillama:${first.pool}`, `ethereum:defillama:${second.pool}`,
      ]);
      expect(metric.topPools[0]?.candidateFingerprint).toBe(metric.topPools[1]?.candidateFingerprint);
    }
    const seen = new Map<string, GlobalPoolAggregateEntry>();
    const protocolTvl: Record<string, number> = {};
    const chainTvl: Record<string, number> = {};
    const chains = new Set<string>();
    const deltas = [...metrics.values()].map((metric) =>
      accumulateGlobalAggregate(metric.topPools, protocolTvl, chainTvl, chains, seen));
    expect(deltas.reduce((sum, delta) => sum + delta.totalTvl, 0)).toBe(300_000);
    expect(deltas.reduce((sum, delta) => sum + delta.poolCount, 0)).toBe(2);
    expect(summarizeRetainedPoolVolume([...seen.values()].map((pool) => ({
      tvlUsd: pool.tvl, reading: pool.reading,
    })), { asOfSec: 1000, maxObservationAgeSec: 72 * 3600 }).totalVolume24hUsd).toBe(20_000);
  });

  it.each(["tvlUsd", "volumeUsd1d", "poolMeta"] as const)("quarantines conflicting provider %s in either arrival order", (field) => {
    const first = makePool({ pool: "same-provider-uuid", project: "uniswap-v3", poolMeta: "0.01%" });
    const conflict = { ...first, [field]: field === "poolMeta" ? "0.05%" : 200_000 };
    const healthy = { ...first, pool: "healthy-provider-uuid" };
    for (const pools of [[first, conflict, healthy], [conflict, first, healthy]]) {
      const { metrics, rejections } = processPoolMetrics({
        pools, dexProjects: new Set(["uniswap-v3"]),
        symbolToChainScopedIds: buildSymbolToChainScopedIds(new Map([["USDC", ["usdc-circle"]]]), ["ethereum"]),
        chainAddressToId: new Map(), curvePoolMap: new Map(), uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(),
      });
      expect(metrics.get("usdc-circle")?.topPools.map((pool) => pool.poolId)).toEqual(["ethereum:defillama:healthy-provider-uuid"]);
      expect(rejections).toEqual([{
        reason: "conflicting-pool-observations", poolIds: ["same-provider-uuid"],
        count: 2, tvlUsd: field === "tvlUsd" ? 300_000 : 200_000,
      }]);
    }
  });

  it("quarantines conflicting physical Curve aliases before attributing either coin", () => {
    const address = "0xabc0000000000000000000000000000000000000";
    const tokens = ["0xusdc", "0xusdt"];
    const first = makePool({ pool: "first-provider-uuid", underlyingTokens: tokens });
    const second = { ...first, pool: "second-provider-uuid", volumeUsd1d: 20_000 };
    for (const pools of [[first, second], [second, first]]) {
      const { metrics, rejections } = processPoolMetrics({
        pools, dexProjects: new Set(["curve"]), symbolToChainScopedIds: new Map(),
        chainAddressToId: new Map([["ethereum:0xusdc", "usdc-circle"], ["ethereum:0xusdt", "usdt-tether"]]),
        curvePoolMap: new Map([[buildPoolFingerprint("ethereum", "curve", tokens)!,
          makeCurveEntry({ poolAddress: address })]]),
        uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(),
      });
      expect(metrics.size).toBe(0);
      expect(rejections).toEqual([expect.objectContaining({
        reason: "conflicting-pool-observations", count: 2, tvlUsd: 200_000,
      })]);
    }
  });

  it("keeps exact native Curve identity and excludes inflated two-token discovery duplicates", async () => {
    const now = 1_710_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const address = "0x4ebdf703948ddcea3b11f675b4d1fba9d2414a14";
    const tokens = [
      "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e",
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "0xd533a949740bb3306d119cc777fa900ba034cd52",
    ];
    const native = makeCurveEntry({ poolAddress: address, tvl: 2_800_000,
      metapoolAdjustedTvl: 2_800_000, registryId: "factory-tricrypto" });
    const pool = makePool({ pool: "llama-pool-uuid", symbol: "CRVUSD-WETH-CRV",
      underlyingTokens: tokens, tvlUsd: 2_900_000 });
    const { metrics } = processPoolMetrics({
      // Aliases of the same proven physical pool must not count twice either.
      pools: [pool, { ...pool, pool: "another-llama-uuid" }],
      dexProjects: new Set(["curve"]),
      symbolToChainScopedIds: new Map(),
      chainAddressToId: new Map([[`ethereum:${tokens[0]}`, "crvusd-curve"]]),
      curvePoolMap: new Map([[buildPoolFingerprint("ethereum", "curve", tokens)!, native]]),
      uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(),
    });
    const staged = makeStagedPoolRow({
      pool_id: `ethereum:${address}`, stablecoin_id: "crvusd-curve", chain: "ethereum",
      protocol: "curve", dex_id: "curve", tvl_usd: 878_858_169,
      base_token: tokens[0], quote_token: tokens[1], price_usd: 1, refreshed_at: now,
    });
    const db = makeNoopD1({ prepare: () => ({ bind: () => ({ all: async () => ({ results: [staged] }) }) }) });
    const result = await mergeStagedPools(db, metrics, createKnownPoolIdentityIndex(), now, new Map());
    const metric = metrics.get("crvusd-curve")!;
    expect(metric.topPools).toHaveLength(1);
    expect(metric.topPools[0]).toMatchObject({ poolId: `ethereum:${address}`, tvlUsd: 2_800_000 });
    expect(rebuildMetricsFromPools(metric.topPools).totalTvlUsd).toBe(2_800_000);
    expect(result.skippedByExactIdentityCount).toBe(1);
    expect(result.mergedCount).toBe(0);
  });

  it("reports a malformed upstream pool and keeps processing later pools", () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const symbolToIds = new Map<string, string[]>([["USDC", ["usdc-circle"]]]);
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, ["ethereum"]);

    const result = processPoolMetrics({
      pools: [
        makePool({
          pool: "0xmalformed",
          symbol: "USDC-USDC",
          chain: null as unknown as string,
          tvlUsd: 100_000,
        }),
        makePool({
          pool: "0xvalid",
          symbol: "USDC-USDC",
          tvlUsd: 150_000,
          count: 5,
        }),
      ],
      dexProjects: new Set(["curve"]),
      symbolToChainScopedIds: symbolToChainScopedIds,
      chainAddressToId: new Map(),
      curvePoolMap: new Map(),
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
    });

    expect(result.rejections).toEqual([
      {
        reason: "invalid-pool-identity",
        poolIds: ["0xmalformed"],
        count: 1,
        tvlUsd: 100_000,
      },
    ]);
    const { metrics } = result;
    expect(metrics.get("usdc-circle")?.topPools).toHaveLength(1);
    expect(metrics.get("usdc-circle")?.topPools[0]?.poolId).toBe("ethereum:defillama:0xvalid");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[dex-liquidity] Matched 1 stablecoins with DEX liquidity"));
  });

  it("rethrows internal processing exceptions", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const invariant = new Error("metric invariant failed");
    const pool = makePool({
      pool: "0xinvariant",
      symbol: "USDC-USDC",
      tvlUsd: 150_000,
    });
    Object.defineProperty(pool, "count", {
      get() {
        throw invariant;
      },
    });
    const symbolToIds = new Map<string, string[]>([["USDC", ["usdc-circle"]]]);

    expect(() =>
      processPoolMetrics({
        pools: [pool],
        dexProjects: new Set(["curve"]),
        symbolToChainScopedIds: buildSymbolToChainScopedIds(
          symbolToIds,
          ["ethereum"],
        ),
        chainAddressToId: new Map(),
        curvePoolMap: new Map(),
        uniV3PoolFees: new Map(),
        uniV3SymbolFees: new Map(),
      }),
    ).toThrow(invariant);
  });

  it("does not apply Curve symbol fallback enrichment to non-Curve DeFiLlama rows", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const symbolToIds = new Map<string, string[]>([
      ["USDT", ["usdt-tether"]],
      ["USDC", ["usdc-circle"]],
    ]);
    const chainAddressToId = new Map<string, string>([
      ["ethereum:0xusdt", "usdt-tether"],
      ["ethereum:0xusdc", "usdc-circle"],
    ]);
    const curvePoolMap = new Map<string, CurvePoolEntry>([
      [
        "ethereum:USDC-USDT",
        makeCurveEntry({
          A: 700,
          balanceRatio: 0.2,
          registryId: "factory-stable-ng",
          metapoolAdjustedTvl: 1_000_000,
          balanceDetails: [
            { symbol: "USDT", balancePct: 80, isTracked: true },
            { symbol: "USDC", balancePct: 20, isTracked: true },
          ],
        }),
      ],
    ]);

    const metrics = processPoolMetrics({
      pools: [
        makePool({
          pool: "uuid-uniswap-v3",
          project: "uniswap-v3",
          symbol: "USDT-USDC",
          tvlUsd: 500_000,
          volumeUsd1d: 25_000,
          underlyingTokens: ["0xusdt", "0xusdc"],
        }),
      ],
      dexProjects: new Set(["uniswap-v3"]),
      symbolToChainScopedIds: buildSymbolToChainScopedIds(symbolToIds, ["ethereum"]),
      chainAddressToId: chainAddressToId,
      curvePoolMap: curvePoolMap,
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
    }).metrics;

    const usdt = metrics.get("usdt-tether");
    const pool = usdt?.topPools[0];
    expect(pool?.poolType).toBe("uniswap-v3-5bp");
    expect(pool?.extra?.amplificationCoefficient).toBeUndefined();
    expect(pool?.extra?.registryId).toBeUndefined();
    expect(pool?.extra?.measurement?.balanceMeasured).toBe(false);
    expect(rebuildMetricsFromPools(usdt?.topPools ?? []).totalTvlForBalance).toBe(0);
  });

  it("matches pools without mutating canonical addresses, protects symbol collisions, and enriches pool extras", () => {
    const nowMs = Date.UTC(2026, 0, 1);
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const symbolToIds = new Map<string, string[]>([
      ["USDT", ["usdt-tether"]],
      ["USDC", ["usdc-circle"]],
      ["USDE", ["usde-ethena"]],
      ["DAI", ["dai-makerdao"]],
      ["CUSD", ["cusd-cap", "cusd-celo"]],
    ]);
    const addressToId = new Map<string, string>([["0xusdt", "usdt-tether"]]);
    const chains = ["ethereum", "base"];
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, chains);
    const chainAddressToId = buildChainAddressToId(addressToId, chains);
    const dexProjects = new Set(["curve", "uniswap-v3", "aerodrome", "sushiswap"]);

    const curvePoolMap = new Map<string, CurvePoolEntry>([
      [
        "ethereum:0xcurve1",
        makeCurveEntry({
          A: 700,
          balanceRatio: 0.8,
          registryId: "main-stableswap",
          tvl: 900_000,
          balanceTvlScope: "full-pool",
          contributionTvlScope: "full-pool",
          metapoolAdjustedTvl: 900_000,
          creationTs: Math.floor(nowMs / 1000) - 200 * 86_400,
          balanceDetails: [
            { symbol: "USDT", balancePct: 0.52, isTracked: true },
            { symbol: "USDC", balancePct: 0.48, isTracked: true },
          ],
        }),
      ],
      [
        "ethereum:USDC-USDT",
        makeCurveEntry({
          A: 80,
          balanceRatio: 0.5,
          registryId: "tricrypto-factory",
          isMetaPool: true,
          metapoolAdjustedTvl: 300_000,
          balanceTvlScope: "full-pool",
          contributionTvlScope: "base-pool-excluded",
          creationTs: Math.floor(nowMs / 1000) - 100 * 86_400,
          balanceDetails: [
            { symbol: "USDT", balancePct: 0.5, isTracked: true },
            { symbol: "USDC", balancePct: 0.5, isTracked: true },
          ],
        }),
      ],
    ]);
    const uniV3PoolFees = new Map<string, number>([["ethereum:0xuni1", 100]]);
    const uniV3SymbolFees = new Map<string, number>([["ethereum:USDC:USDE", 3000]]);

    const metrics = processPoolMetrics({
      pools: [
        makePool({ pool: "0xdust", tvlUsd: 5_000 }),
        makePool({ pool: "0xabsurd", tvlUsd: 2e12 }),
        makePool({ pool: "0xblocked", project: "retro", tvlUsd: 50_000 }),
        makePool({ pool: "0xnotdex", project: "not-in-whitelist", tvlUsd: 50_000 }),
        makePool({ pool: "0xlending", exposure: "single", tvlUsd: 50_000 }),
        makePool({
          pool: "0xcurve1",
          project: "curve",
          symbol: "USDT-USDC",
          tvlUsd: 1_000_000,
          volumeUsd1d: 200_000,
          volumeUsd7d: 1_400_000,
          underlyingTokens: ["0xusdt", "0xusdc-new"],
          apyBase: 4,
          apy: 10,
          count: 30,
        }),
        makePool({
          pool: "0xcurve2",
          project: "curve",
          symbol: "USDT-USDC",
          tvlUsd: 750_000,
          volumeUsd1d: 60_000,
          volumeUsd7d: 420_000,
        }),
        makePool({
          pool: "0xuni1",
          project: "uniswap-v3",
          symbol: "USDT-DAI",
          tvlUsd: 500_000,
          volumeUsd1d: 100_000,
          volumeUsd7d: 700_000,
          apyBase: 0.02,
          apy: 0.005,
          count: 45,
        }),
        makePool({
          pool: "0xuni2",
          project: "uniswap-v3",
          symbol: "USDC-USDE",
          tvlUsd: 400_000,
          volumeUsd1d: 80_000,
          volumeUsd7d: 560_000,
          apyBase: 0,
          apy: 0,
          count: 20,
        }),
        makePool({
          pool: "0xaero",
          chain: "Base",
          project: "aerodrome",
          symbol: "USDC-USDT",
          tvlUsd: 300_000,
          volumeUsd1d: 90_000,
          volumeUsd7d: 630_000,
          count: 12,
        }),
        makePool({
          pool: "0xcollision",
          project: "sushiswap",
          symbol: "CUSD-USDT",
          tvlUsd: 200_000,
          volumeUsd1d: 50_000,
          volumeUsd7d: 350_000,
          count: 10,
        }),
      ],
      dexProjects: dexProjects,
      symbolToChainScopedIds: symbolToChainScopedIds,
      chainAddressToId: chainAddressToId,
      curvePoolMap: curvePoolMap,
      uniV3PoolFees: uniV3PoolFees,
      uniV3SymbolFees: uniV3SymbolFees,
    }).metrics;

    expect(chainAddressToId.get("ethereum:0xusdc-new")).toBeUndefined();
    expect(metrics.has("cusd-cap")).toBe(false);
    expect(metrics.has("cusd-celo")).toBe(false);

    const usdt = metrics.get("usdt-tether");
    expect(usdt).toBeDefined();
    const rebuiltUsdt = rebuildMetricsFromPools(usdt?.topPools ?? []);
    expect(rebuiltUsdt.totalTvlUsd).toBe(2_650_000);
    expect(rebuiltUsdt.poolCount).toBe(5);
    expect(rebuiltUsdt.protocolTvl).toEqual({
      curve: 1_650_000,
      "uniswap-v3": 500_000,
      aerodrome: 300_000,
      sushiswap: 200_000,
    });
    expect(rebuiltUsdt.chainTvl).toEqual({
      ethereum: 2_350_000,
      base: 300_000,
    });
    expect(rebuiltUsdt.totalTvlForBalance).toBe(1_650_000);
    expect(rebuiltUsdt.organicTvlWeightedSum).toBe(860_000);
    expect(rebuiltUsdt.totalTvlForOrganic).toBe(1_400_000);
    expect(rebuiltUsdt.oldestPoolDays).toBe(200);

    const curveAddressPool = usdt?.topPools.find((pool) => pool.poolId === "ethereum:defillama:0xcurve1");
    expect(curveAddressPool).toMatchObject({
      poolType: "curve-stableswap-high-a",
      extra: {
        amplificationCoefficient: 700,
        balanceRatio: 0.8,
        registryId: "main-stableswap",
        isMetaPool: false,
        organicFraction: 0.4,
        pairQuality: 1,
        maturityDays: 200,
      },
    });
    expect(curveAddressPool?.extra?.effectiveTvl).toBe(643988);

    const curveFallbackPool = usdt?.topPools.find((pool) => pool.poolId === "ethereum:defillama:0xcurve2");
    expect(curveFallbackPool).toMatchObject({
      poolType: "curve-cryptoswap",
      extra: {
        amplificationCoefficient: 80,
        isMetaPool: true,
        registryId: "tricrypto-factory",
        maturityDays: 100,
      },
    });
    expect(curveFallbackPool?.extra?.effectiveTvl).toBe(132583);

    const uniAddressPool = usdt?.topPools.find((pool) => pool.poolId === "ethereum:defillama:0xuni1");
    expect(uniAddressPool).toMatchObject({
      poolType: "uniswap-v3-1bp",
      extra: {
        feeTier: 1,
        organicFraction: 1,
        maturityDays: 45,
      },
    });

    const usdc = metrics.get("usdc-circle");
    const rebuiltUsdc = rebuildMetricsFromPools(usdc?.topPools ?? []);
    expect(rebuiltUsdc.poolCount).toBe(3);
    expect(rebuiltUsdc.totalTvlUsd).toBe(1_450_000);

    const uniSymbolPool = usdc?.topPools.find((pool) => pool.poolId === "ethereum:defillama:0xuni2");
    expect(uniSymbolPool).toMatchObject({
      poolType: "uniswap-v3-30bp",
      extra: {
        feeTier: 30,
        organicFraction: 0,
        maturityDays: 20,
      },
    });

    const aerodromePool = usdc?.topPools.find((pool) => pool.poolId === "base:defillama:0xaero");
    expect(aerodromePool?.poolType).toBe("aerodrome-volatile");

    const usde = metrics.get("usde-ethena");
    expect(rebuildMetricsFromPools(usde?.topPools ?? []).poolCount).toBe(1);
    expect(usde?.topPools[0]?.poolType).toBe("uniswap-v3-30bp");
  });

  it("does not learn wrapper addresses from positional DeFiLlama symbols", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const symbolToIds = new Map<string, string[]>([["USR", ["usr-resolv"]]]);
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, ["base"]);
    const chainAddressToId = new Map<string, string>([["base:0xusr", "usr-resolv"]]);

    const metrics = processPoolMetrics({
      pools: [
        makePool({
          chain: "Base",
          project: "curve",
          symbol: "AAVEGHO-USR",
          underlyingTokens: ["0xusr", "0xwabasgho"],
          tvlUsd: 200_000,
          volumeUsd1d: 50_000,
          volumeUsd7d: 350_000,
        }),
      ],
      dexProjects: new Set(["curve"]),
      symbolToChainScopedIds: symbolToChainScopedIds,
      chainAddressToId: chainAddressToId,
      curvePoolMap: new Map(),
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
    }).metrics;

    expect(chainAddressToId.get("base:0xwabasgho")).toBeUndefined();
    const rebuilt = rebuildMetricsFromPools(metrics.get("usr-resolv")?.topPools ?? []);
    expect(rebuilt.poolCount).toBe(1);
    expect(rebuilt.totalTvlUsd).toBe(200_000);
  });

  it("disables the DEX whitelist filter when the project index is empty", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const metrics = processPoolMetrics({
      pools: [
        makePool({
          pool: "0xfree",
          project: "unknown-dex",
          symbol: "USDT-USDC",
          tvlUsd: 75_000,
          volumeUsd1d: 9_000,
        }),
      ],
      dexProjects: new Set(),
      symbolToChainScopedIds: buildSymbolToChainScopedIds(
        new Map([
          ["USDT", ["usdt-tether"]],
          ["USDC", ["usdc-circle"]],
        ]),
        ["ethereum"],
      ),
      chainAddressToId: new Map(),
      curvePoolMap: new Map(),
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
    }).metrics;

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[dex-liquidity] DEX project index is empty — project whitelist filter disabled for this run"),
    );
    expect(rebuildMetricsFromPools(metrics.get("usdt-tether")?.topPools ?? []).poolCount).toBe(1);
    expect(rebuildMetricsFromPools(metrics.get("usdc-circle")?.topPools ?? []).poolCount).toBe(1);
  });

  it("skips blocked dead DEX variants including bunni", () => {
    const metrics = processPoolMetrics({
      pools: [
        makePool({
          pool: "0xbunni-root",
          project: "bunni",
          symbol: "USDT-USDC",
          underlyingTokens: ["0xusdt", "0xusdc"],
        }),
        makePool({
          pool: "0xbunni-eth",
          project: "bunni-ethereum",
          symbol: "USDT-USDC",
          underlyingTokens: ["0xusdt", "0xusdc"],
        }),
      ],
      dexProjects: new Set(["bunni", "bunni-ethereum"]),
      symbolToChainScopedIds: buildSymbolToChainScopedIds(
        new Map([
          ["USDT", ["usdt-tether"]],
          ["USDC", ["usdc-circle"]],
        ]),
        ["ethereum"],
      ),
      chainAddressToId: new Map([
        ["ethereum:0xusdt", "usdt-tether"],
        ["ethereum:0xusdc", "usdc-circle"],
      ]),
      curvePoolMap: new Map(),
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
    }).metrics;

    expect(metrics.size).toBe(0);
  });

  it("ignores organicFraction when apyBase is NaN", () => {
    const pool = makePool({ apyBase: NaN, apy: 5, symbol: "USDT-USDC" });
    const metrics = processPoolMetrics({
      pools: [pool],
      dexProjects: new Set(["curve"]),
      symbolToChainScopedIds: buildSymbolToChainScopedIds(
        new Map([
          ["USDT", ["usdt-tether"]],
          ["USDC", ["usdc-circle"]],
        ]),
        ["ethereum"],
      ),
      chainAddressToId: new Map(),
      curvePoolMap: new Map(),
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
    }).metrics;
    const m = metrics.get("usdt-tether");
    expect(m).toBeDefined();
    // NaN apyBase should not mark organic fraction as measured
    expect(rebuildMetricsFromPools(m!.topPools).totalTvlForOrganic).toBe(0);
  });

  it("uses apyBase fallback when apy is Infinity (avoids NaN from division)", () => {
    const pool = makePool({ apyBase: 3, apy: Infinity, symbol: "USDT-USDC" });
    const metrics = processPoolMetrics({
      pools: [pool],
      dexProjects: new Set(["curve"]),
      symbolToChainScopedIds: buildSymbolToChainScopedIds(
        new Map([
          ["USDT", ["usdt-tether"]],
          ["USDC", ["usdc-circle"]],
        ]),
        ["ethereum"],
      ),
      chainAddressToId: new Map(),
      curvePoolMap: new Map(),
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
    }).metrics;
    const m = metrics.get("usdt-tether");
    expect(m).toBeDefined();
    // apyBase is finite and positive → else-if branch sets organicFraction=1.0
    expect(rebuildMetricsFromPools(m!.topPools).totalTvlForOrganic).toBe(100_000);
  });

  it("normalizes top-pool project labels for DeFiLlama Orca rows", () => {
    const metrics = processPoolMetrics({
      pools: [
        makePool({
          chain: "Solana",
          project: "orca-dex",
          symbol: "USDC-USDT",
          underlyingTokens: [
            "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1",
            "Es9vMFrzaCERmJfrF4H2FY6q2JvE4YJzS83p2wM8wus",
          ],
          tvlUsd: 500_000,
          volumeUsd1d: 100_000,
          volumeUsd7d: 700_000,
        }),
      ],
      dexProjects: new Set(["orca-dex"]),
      symbolToChainScopedIds: buildSymbolToChainScopedIds(
        new Map([
          ["USDC", ["usdc-circle"]],
          ["USDT", ["usdt-tether"]],
        ]),
        ["solana"],
      ),
      chainAddressToId: new Map([
        ["solana:EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", "usdc-circle"],
        ["solana:Es9vMFrzaCERmJfrF4H2FY6q2JvE4YJzS83p2wM8wus", "usdt-tether"],
      ]),
      curvePoolMap: new Map(),
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
    }).metrics;

    expect(metrics.get("usdc-circle")?.topPools[0]?.project).toBe("orca");
    expect(metrics.get("usdt-tether")?.topPools[0]?.project).toBe("orca");
  });

  it("Curve metapool dedup: uses metapoolAdjustedTvl not raw usdTotal for effective and protocol TVL", () => {
    // F15 regression: a Curve metapool with basePoolAddress should surface
    // usdTotalExcludingBasePool (60M) via metapoolAdjustedTvl in scoring paths,
    // NOT the raw usdTotal (100M). Prevents base-pool TVL double-counting.
    vi.spyOn(console, "log").mockImplementation(() => {});

    const symbolToIds = new Map<string, string[]>([
      ["USDC", ["usdc-circle"]],
      ["USDT", ["usdt-tether"]],
    ]);
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, ["ethereum"]);
    const chainAddressToId = new Map<string, string>([
      ["ethereum:0xusdc", "usdc-circle"],
      ["ethereum:0xusdt", "usdt-tether"],
    ]);

    const curvePoolMap = new Map<string, CurvePoolEntry>([
      [
        "ethereum:0xmetapool",
        makeCurveEntry({
          A: 100,
          balanceRatio: 1,
          registryId: "factory-meta",
          isMetaPool: true,
          tvl: 100_000_000, // raw usdTotal
          metapoolAdjustedTvl: 60_000_000, // usdTotalExcludingBasePool
          balanceDetails: [
            { symbol: "USDC", balancePct: 50, isTracked: true },
            { symbol: "USDT", balancePct: 50, isTracked: true },
          ],
        }),
      ],
    ]);

    const metrics = processPoolMetrics({
      pools: [
        makePool({
          pool: "0xmetapool",
          project: "curve",
          symbol: "USDC-USDT",
          tvlUsd: 100_000_000, // DL raw usdTotal includes base-pool TVL
          underlyingTokens: ["0xusdc", "0xusdt"],
          count: 5,
        }),
      ],
      dexProjects: new Set(["curve"]),
      symbolToChainScopedIds: symbolToChainScopedIds,
      chainAddressToId: chainAddressToId,
      curvePoolMap: curvePoolMap,
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
    }).metrics;

    const usdc = metrics.get("usdc-circle");
    expect(usdc).toBeDefined();
    const rebuiltUsdc = rebuildMetricsFromPools(usdc?.topPools ?? []);
    // totalTvlUsd (and protocolTvl) rebuilt from metapoolAdjustedTvl, not raw 100M
    expect(rebuiltUsdc.totalTvlUsd).toBe(60_000_000);
    expect(rebuiltUsdc.protocolTvl.curve).toBe(60_000_000);
    // Top-pool row mirrors the metapool-adjusted TVL — not the raw $100M DL number
    expect(usdc?.topPools[0]?.tvlUsd).toBe(60_000_000);
    // Quality and effective TVL both use Curve's base-pool-excluded value,
    // keeping the quality numerator on the retained TVL denominator's basis.
    expect(rebuiltUsdc.qualityAdjustedTvl).toBe(51_000_000);
    expect(rebuiltUsdc.effectiveTvl).toBe(51_000_000);
    expect(usdc?.topPools[0]?.extra?.qualityAdjustedTvl).toBe(51_000_000);
    expect(usdc?.topPools[0]?.extra?.effectiveTvl).toBe(51_000_000);
  });


  it("joins UUID-id DeFiLlama rows to Curve pools via the coin-set fingerprint", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const USDC = "0x00000000000000000000000000000000000000c1";
    const USDT = "0x00000000000000000000000000000000000000c2";
    const addressToId = new Map([
      [USDC, "usdc-circle"],
      [USDT, "usdt-tether"],
    ]);
    const chainAddressToId = buildChainAddressToId(addressToId, ["ethereum"]);
    const symbolToIds = new Map<string, string[]>();
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, ["ethereum"]);

    const entry = makeCurveEntry({
      A: 200,
      registryId: "factory-stable-ng",
      metapoolAdjustedTvl: 900_000,
      executionCoins: [
        { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
        { address: USDT, symbol: "USDT", decimals: 6, balance: 5_000_000, usdPrice: 0.9995 },
      ],
    });
    const fingerprintKey = buildPoolFingerprint("ethereum", "curve", [USDC, USDT]);
    expect(fingerprintKey).not.toBeNull();
    const curvePoolMap = new Map([[fingerprintKey!, entry]]);

    // Production DeFiLlama yields rows carry UUID pool ids, never addresses.
    const uuidRow = makePool({
      pool: "4dbfda50-1111-2222-3333-444455556666",
      project: "curve-dex",
      symbol: "USDC-USDT",
      tvlUsd: 1_500_000,
      underlyingTokens: [USDT, USDC],
      count: 3,
    });

    const metrics = processPoolMetrics({
      pools: [uuidRow],
      dexProjects: new Set(["curve-dex"]),
      symbolToChainScopedIds: symbolToChainScopedIds,
      chainAddressToId: chainAddressToId,
      curvePoolMap: curvePoolMap,
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
    }).metrics;

    const usdc = metrics.get("usdc-circle");
    expect(usdc).toBeDefined();
    const topPool = usdc!.topPools[0]!;
    // Address-grade fingerprint match: metapool-adjusted TVL replaces the row's own TVL.
    expect(topPool.tvlUsd).toBe(900_000);
    const model = topPool.extra?.ammExecutionModel;
    expect(model).toBeDefined();
    expect(model).toMatchObject({
      source: "curve",
      invariant: "stableswap",
      amplification: 100,
    });
  });

  it("retains an exact-address Curve invariant gate for P4 completeness", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const USDC = "0x00000000000000000000000000000000000000c1";
    const WETH = "0x00000000000000000000000000000000000000c2";
    const addressToId = new Map([[USDC, "usdc-circle"]]);
    const chainAddressToId = buildChainAddressToId(addressToId, ["ethereum"]);
    const symbolToIds = new Map<string, string[]>();
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, ["ethereum"]);
    const fingerprintKey = buildPoolFingerprint("ethereum", "curve", [USDC, WETH]);
    const curvePoolMap = new Map([
      [
        fingerprintKey!,
        makeCurveEntry({
          A: 20_000_000,
          registryId: "factory-twocrypto",
          executionCoins: [
            { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
            { address: WETH, symbol: "WETH", decimals: 18, balance: 2_000, usdPrice: 2_500 },
          ],
        }),
      ],
    ]);

    const metrics = processPoolMetrics({
      pools: [
        makePool({
          pool: "4dbfda50-1111-2222-3333-444455556666",
          project: "curve-dex",
          symbol: "USDC-WETH",
          tvlUsd: 10_000_000,
          underlyingTokens: [USDC, WETH],
          count: 3,
        }),
      ],
      dexProjects: new Set(["curve-dex"]),
      symbolToChainScopedIds: symbolToChainScopedIds,
      chainAddressToId: chainAddressToId,
      curvePoolMap: curvePoolMap,
      uniV3PoolFees: new Map(),
      uniV3SymbolFees: new Map(),
    }).metrics;

    expect(metrics.get("usdc-circle")?.topPools[0]?.extra).toMatchObject({
      executionCapabilityGate: {
        family: "curve-cryptoswap",
        reason: "unsupported-invariant",
      },
    });
    expect(metrics.get("usdc-circle")?.topPools[0]?.extra?.ammExecutionModel).toBeUndefined();
  });

  it("promotes a uniquely TVL-matched active Curve CryptoSwap row to an exact measured target", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const CRVUSD = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e";
    const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
    const ACTIVE_POOL = "0x313698667d7fdd6789a9bc70821309ff891e729a";
    const ACTIVE_SIBLING = "0xd9ff8396554a0d18b2cfbec53e1979b7ecce8373";
    const chainAddressToId = buildChainAddressToId(new Map([[CRVUSD, "crvusd-curve"]]), ["ethereum"]);
    const symbolToIds = new Map<string, string[]>();
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, ["ethereum"]);
    const fingerprintKey = buildPoolFingerprint("ethereum", "curve", [CRVUSD, WBTC])!;
    const candidate = makeCurveEntry({
      poolAddress: ACTIVE_POOL,
      apiIsBroken: false,
      A: 50_000,
      tvl: 46_403_371,
      metapoolAdjustedTvl: 46_403_371,
      registryId: "factory-twocrypto",
      executionCoins: [
        { address: CRVUSD, symbol: "crvUSD", decimals: 18, balance: 23_000_000, usdPrice: 1 },
        { address: WBTC, symbol: "WBTC", decimals: 8, balance: 360, usdPrice: 65_000 },
      ],
    });
    const sibling = {
      ...candidate,
      poolAddress: ACTIVE_SIBLING,
      tvl: 7_494_912,
      metapoolAdjustedTvl: 7_494_912,
    };
    const retainedPool = makePool({
      pool: "128b253a-0903-476f-9a70-6007b336e395",
      project: "curve-dex",
      symbol: "CRVUSD-WBTC",
      tvlUsd: 46_360_886,
      underlyingTokens: [CRVUSD, WBTC],
      count: 63,
    });
    const run = (candidateMap: Map<string, CurvePoolEntry[]>) =>
      processPoolMetrics({
        pools: [retainedPool],
        dexProjects: new Set(["curve-dex"]),
        symbolToChainScopedIds: symbolToChainScopedIds,
        chainAddressToId: chainAddressToId,
        curvePoolMap: new Map([[`ethereum:${ACTIVE_POOL}`, candidate], [`ethereum:${ACTIVE_SIBLING}`, sibling]]),
        uniV3PoolFees: new Map(),
        uniV3SymbolFees: new Map(),
        uniV3ExecutionCandidates: new Map(),
        stablecoinPriceById: new Map([["crvusd-curve", 0.9998]]),
        measuredTargetCapturedAt: 1_752_500_000,
        validationReferences: undefined,
        curvePoolCandidatesByFingerprint: candidateMap,
      }).metrics.get("crvusd-curve")?.topPools[0];

    const retained = run(new Map([[fingerprintKey, [candidate, sibling]]]));
    expect(retained?.tvlUsd).toBe(46_360_886);
    expect(retained?.extra?.registryId).toBeUndefined();
    expect(retained?.extra?.executionCapabilityGate).toBeUndefined();
    expect(retained?.extra?.measuredExecutionTarget).toMatchObject({
      adapterProfileId: "curve-cryptoswap-get-dy-v1",
      stablecoinId: "crvusd-curve",
      poolId: `ethereum:${ACTIVE_POOL}`,
      retainedTvlUsd: 46_360_886,
      retainedPoolPriceUsd: 0.9998,
    });

    const baseline = run(new Map());
    const legacyProjection = (pool: typeof retained) => {
      const projection = structuredClone(pool);
      if (projection?.extra) {
        delete projection.extra.measuredExecutionTarget;
        delete projection.extra.executionCapabilityGate;
      }
      return projection;
    };
    expect(legacyProjection(retained)).toEqual(legacyProjection(baseline));
  });

  it("keeps unresolved Curve joins in the exact-capability denominator", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const USDC = "0x00000000000000000000000000000000000000c1";
    const USDT = "0x00000000000000000000000000000000000000c2";
    const POOL_A = "0x00000000000000000000000000000000000000a1";
    const POOL_B = "0x00000000000000000000000000000000000000b1";
    const addressToId = new Map([
      [USDC, "usdc-circle"],
      [USDT, "usdt-tether"],
    ]);
    const chainAddressToId = buildChainAddressToId(addressToId, ["ethereum"]);
    const symbolToIds = new Map<string, string[]>();
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, ["ethereum"]);
    const entry = makeCurveEntry({
      executionCoins: [
        { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000, usdPrice: 1 },
        { address: USDT, symbol: "USDT", decimals: 6, balance: 5_000_000, usdPrice: 1 },
      ],
    });
    const symbolKey = "ethereum:USDC-USDT";
    const cases: Array<{ name: string; curvePoolMap: Map<string, CurvePoolEntry> }> = [
      { name: "no Curve map entry", curvePoolMap: new Map() },
      { name: "symbol-only fallback", curvePoolMap: new Map([[symbolKey, entry]]) },
      {
        name: "ambiguous coin-set fingerprint",
        // buildCurveLookups retains both exact addresses and the diagnostic
        // symbol fallback, but deletes the shared fingerprint as ambiguous.
        curvePoolMap: new Map([
          [`ethereum:${POOL_A}`, entry],
          [`ethereum:${POOL_B}`, { ...entry, A: 200 }],
          [symbolKey, entry],
        ]),
      },
    ];

    for (const testCase of cases) {
      const metrics = processPoolMetrics({
        pools: [
          makePool({
            pool: "4dbfda50-1111-2222-3333-444455556666",
            project: "curve-dex",
            symbol: "USDC-USDT",
            tvlUsd: 1_500_000,
            underlyingTokens: [USDC, USDT],
            count: 3,
          }),
        ],
        dexProjects: new Set(["curve-dex"]),
        symbolToChainScopedIds: symbolToChainScopedIds,
        chainAddressToId: chainAddressToId,
        curvePoolMap: testCase.curvePoolMap,
        uniV3PoolFees: new Map(),
        uniV3SymbolFees: new Map(),
      }).metrics;
      const retainedPools = metrics.get("usdc-circle")?.topPools ?? [];
      expect(retainedPools, testCase.name).toHaveLength(1);
      expect(retainedPools[0]?.extra, testCase.name).toMatchObject({
        executionCapabilityGate: {
          family: "curve-stableswap",
          reason: "exact-pool-join-unresolved",
        },
      });
      expect(retainedPools[0]?.extra?.ammExecutionModel, testCase.name).toBeUndefined();

      const routeResult = buildP4DexExitRouteObservations({
        stablecoinId: "usdc-circle",
        retainedPools,
        observedAt: 1_000,
      });
      expect(routeResult.coverage, testCase.name).toMatchObject({
        capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
        retainedPoolCount: 1,
        scoreEligiblePoolCount: 0,
        scoreEligibleCapabilityPoolCount: 1,
        unsupportedPoolCount: 1,
        unsupportedReasons: {
          "executionCapabilityGate:curve-stableswap:exact-pool-join-unresolved": 1,
        },
      });
    }
  });

  it("keeps DL TVL and volume while measuring the negative-indexed thUSD exact pool", () => {
    // Initialize block 24974199 / Graph block 26088668, captured 2026-09-30:
    // https://etherscan.io/tx/0xdbfd03418344a5db0e0910874e6b15da64bd8edff032253e20de67e709918d7c
    const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const thusd = "0xa3fe5c7596024e6811e14f029937d5bd8ae485b3";
    const poolId = "0xb30bf32e26a35328286df33c17dd01e1051b5e3a0ec55a4a211e6957594b5a0d";
    const candidate: UniswapV4ExecutionCandidate = {
      chain: "ethereum", poolId, feePips: 100, tickSpacing: 1,
      hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS, activeLiquidity: "1215742317323",
      tvlUsd: -222031.942086, token0Price: 0.9988856322499521, token1Price: 1.0011156109509132,
      tokens: [{ address: usdc, symbol: "USDC", decimals: 6 },
        { address: thusd, symbol: "thUSD", decimals: 6 }],
    };
    const key = buildUniswapV4ExecutionCandidateKey("ethereum", [usdc, thusd], 100)!;
    const run = (candidates: UniswapV4ExecutionCandidate[]) => processPoolMetrics({
      pools: [makePool({ pool: poolId, project: "uniswap-v4", symbol: "USDC-THUSD",
        tvlUsd: 5_561_855, volumeUsd1d: 10_000, volumeUsd7d: 70_000,
        underlyingTokens: [usdc, thusd], poolMeta: "0.01%" })],
      dexProjects: new Set(["uniswap-v4"]), symbolToChainScopedIds: new Map(),
      chainAddressToId: new Map([[`ethereum:${usdc}`, "usdc-circle"], [`ethereum:${thusd}`, "thusd-theo"]]),
      curvePoolMap: new Map(), uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(),
      stablecoinPriceById: new Map([["usdc-circle", 1], ["thusd-theo", 1]]),
      measuredTargetCapturedAt: 1_790_748_609,
      uniswapV4ExecutionCandidates: new Map([[key, candidates]]),
    }).metrics.get("thusd-theo")!;
    const measured = run([candidate]);
    const unresolved = run([]);
    expect(measured.topPools).toHaveLength(1);
    expect(measured.topPools[0]).toMatchObject({ poolId: `ethereum:${poolId}`,
      tvlUsd: 5_561_855, volumeUsd1d: 10_000, volumeUsd7d: 70_000,
      extra: { measuredExecutionTarget: { poolId: `ethereum:${poolId}`,
        tokenIn: { trackedAssetId: "thusd-theo" } } } });
    expect(rebuildMetricsFromPools(measured.topPools)).toMatchObject({
      totalTvlUsd: 5_561_855, poolCount: 1,
    });
    expect(unresolved.topPools[0]).toMatchObject({
      tvlUsd: 5_561_855, volumeUsd1d: 10_000, volumeUsd7d: 70_000,
    });
    expect(unresolved.topPools).toHaveLength(1);
    expect(unresolved.topPools[0]?.extra?.executionCapabilityGate?.reason).toBe("target-unresolved");
  });

  it("attaches V4 targets only for one exact hook-free candidate", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const poolId = computeUniswapV4PoolId({
      currency0: USDC,
      currency1: USDT,
      feePips: 100,
      tickSpacing: 1,
      hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    });
    const candidate: UniswapV4ExecutionCandidate = {
      chain: "ethereum",
      poolId,
      feePips: 100,
      tickSpacing: 1,
      hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
      activeLiquidity: "1000000",
      tvlUsd: 2_000_000,
      token0Price: 1,
      token1Price: 1,
      tokens: [
        { address: USDC, symbol: "USDC", decimals: 6 },
        { address: USDT, symbol: "USDT", decimals: 6 },
      ],
    };
    const addressToId = new Map([
      [USDC, "usdc-circle"],
      [USDT, "usdt-tether"],
    ]);
    const chainAddressToId = buildChainAddressToId(addressToId, ["ethereum"]);
    const symbolToIds = new Map<string, string[]>([
      ["USDC", ["usdc-circle"]],
      ["USDT", ["usdt-tether"]],
    ]);
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(
      symbolToIds,
      ["ethereum"],
    );
    const key = buildUniswapV4ExecutionCandidateKey(
      "ethereum",
      [USDC, USDT],
      100,
    )!;
    const run = (candidates: UniswapV4ExecutionCandidate[], retainedId = "4dbfda50-1111-2222-3333-444455556666", retainedTokens = [USDC, USDT], poolMeta: string | null = "Uniswap V4 0.01%") =>
      processPoolMetrics({
        pools: [
          makePool({
            pool: retainedId,
            project: "uniswap-v4-ethereum",
            poolMeta,
            symbol: "USDC-USDT",
            tvlUsd: 2_000_000,
            underlyingTokens: retainedTokens,
          }),
        ],
        dexProjects: new Set(["uniswap-v4-ethereum"]),
        symbolToChainScopedIds: symbolToChainScopedIds,
        chainAddressToId: chainAddressToId,
        curvePoolMap: new Map(),
        uniV3PoolFees: new Map(),
        uniV3SymbolFees: new Map(),
        uniV3ExecutionCandidates: new Map(),
        stablecoinPriceById: new Map([
          ["usdc-circle", 1],
          ["usdt-tether", 1],
        ]),
        measuredTargetCapturedAt: 1_785_000_000,
        validationReferences: undefined,
        curvePoolCandidatesByFingerprint: new Map(),
        uniswapV4ExecutionCandidates: new Map([[key, candidates]]),
      }).metrics.get("usdc-circle")?.topPools[0];

    expect(run([candidate])?.extra?.measuredExecutionTarget).toMatchObject({
      adapterProfileId: "uniswap-v4-hook-free-quoter-v1",
      poolId: `ethereum:${poolId}`,
      hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    });
    expect(run([candidate])?.extra?.executionCapabilityGate).toBeUndefined();

    expect(run([candidate], poolId, [USDT.toUpperCase().replace("0X", "0x"), USDC], null)?.extra?.measuredExecutionTarget).toBeDefined();
    expect(run([candidate], poolId, [USDC, "0x0000000000000000000000000000000000000001"])?.extra).toMatchObject({
      executionCapabilityGate: { family: "measured-execution", reason: "target-unresolved" },
    });

    expect(run([{ ...candidate, activeLiquidity: "0" }])?.extra).toMatchObject({
      executionCapabilityGate: {
        family: "measured-execution",
        reason: "target-unresolved",
      },
    });

    const hookedCollision: UniswapV4ExecutionCandidate = {
      ...candidate,
      poolId: `0x${"1".repeat(64)}`,
      hookAddress: "0x0000000000000000000000000000000000000001",
    };
    expect(run([candidate, hookedCollision])?.extra).toMatchObject({
      executionCapabilityGate: {
        family: "measured-execution",
        reason: "target-unresolved",
      },
    });
    expect(
      run([candidate, hookedCollision])?.extra?.measuredExecutionTarget,
    ).toBeUndefined();
  });
});
