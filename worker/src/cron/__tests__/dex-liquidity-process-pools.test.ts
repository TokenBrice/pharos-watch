import { afterEach, describe, expect, it, vi } from "vitest";
import { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-capacity";
import type { CurvePoolEntry, LlamaPool } from "../dex-liquidity/types";
import { processPoolMetrics } from "../dex-liquidity/process-pools";
import { buildPoolFingerprint } from "../dex-liquidity/pool-helpers";
import { buildEvmV2ExecutionCandidate } from "../dex-liquidity/constant-product-v2";
import { buildChainAddressToId, buildSymbolToChainScopedIds } from "./dex-liquidity-fixtures";
import {
  buildUniswapV4ExecutionCandidateKey,
  type UniswapV4ExecutionCandidate,
} from "../measured-execution/inventory";
import {
  UNISWAP_V4_HOOK_FREE_ADDRESS,
  computeUniswapV4PoolId,
} from "../measured-execution/uniswap-v4";

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

  it("skips a malformed upstream pool and keeps processing later pools", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const symbolToIds = new Map<string, string[]>([["USDC", ["usdc-circle"]]]);
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, ["ethereum"]);

    const metrics = processPoolMetrics(
      [
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
      new Set(["curve"]),
      symbolToIds,
      symbolToChainScopedIds,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(errorSpy).toHaveBeenCalledWith(
      "[dex-liquidity] Pool processing failed for pool=0xmalformed chain=null:",
      expect.any(TypeError),
    );
    expect(metrics.get("usdc-circle")?.topPools).toHaveLength(1);
    expect(metrics.get("usdc-circle")?.topPools[0]?.poolId).toBe("ethereum:0xvalid");
    expect(logSpy).toHaveBeenCalledWith("[dex-liquidity] Matched 1 stablecoins with DEX liquidity");
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

    const metrics = processPoolMetrics(
      [
        makePool({
          pool: "uuid-uniswap-v3",
          project: "uniswap-v3",
          symbol: "USDT-USDC",
          tvlUsd: 500_000,
          volumeUsd1d: 25_000,
          underlyingTokens: ["0xusdt", "0xusdc"],
        }),
      ],
      new Set(["uniswap-v3"]),
      symbolToIds,
      buildSymbolToChainScopedIds(symbolToIds, ["ethereum"]),
      new Map(),
      chainAddressToId,
      curvePoolMap,
      new Map(),
      new Map(),
      new Map(),
    );

    const usdt = metrics.get("usdt-tether");
    const pool = usdt?.topPools[0];
    expect(pool?.poolType).toBe("uniswap-v3-5bp");
    expect(pool?.extra?.amplificationCoefficient).toBeUndefined();
    expect(pool?.extra?.registryId).toBeUndefined();
    expect(pool?.extra?.measurement?.balanceMeasured).toBe(false);
    expect(usdt?.totalTvlForBalance).toBe(0);
  });

  it("attaches classic Aerodrome execution only to the exact volatile census pool", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const weth = "0x4200000000000000000000000000000000000006";
    const volatilePool = "0xcdac0d6c6c59727a65f871236188350531885c43";
    const stablePool = "0x1111111111111111111111111111111111111111";
    const candidate = buildEvmV2ExecutionCandidate({
      chain: "base",
      protocol: "aerodrome",
      poolType: "aerodrome-volatile",
      poolAddress: volatilePool,
      tokenAddresses: [usdc, weth],
      tokenSymbols: ["USDC", "WETH"],
      confirmedStable: false,
    })!;
    const symbolToIds = new Map<string, string[]>([["USDC", ["usdc-circle"]]]);

    const metrics = processPoolMetrics(
      [
        makePool({
          pool: volatilePool,
          chain: "Base",
          project: "aerodrome",
          symbol: "USDC-WETH",
          underlyingTokens: [usdc, weth],
        }),
        makePool({
          pool: stablePool,
          chain: "Base",
          project: "aerodrome",
          symbol: "USDC-WETH",
          underlyingTokens: [usdc, weth],
        }),
      ],
      new Set(["aerodrome"]),
      symbolToIds,
      buildSymbolToChainScopedIds(symbolToIds, ["base"]),
      new Map(),
      new Map([[`base:${usdc}`, "usdc-circle"]]),
      new Map(),
      new Map(),
      new Map(),
      new Map([
        [`base:${volatilePool}`, false],
        [`base:${stablePool}`, true],
      ]),
      new Map(),
      new Map([["usdc-circle", 1]]),
      1_752_560_000,
      undefined,
      new Map([[`base:${volatilePool}`, candidate]]),
    );

    const pools = metrics.get("usdc-circle")!.topPools;
    expect(pools.find((pool) => pool.poolId === `base:${volatilePool}`)?.extra?.evmV2ExecutionCandidate).toEqual(
      candidate,
    );
    expect(pools.find((pool) => pool.poolId === `base:${stablePool}`)?.poolType).toBe("aerodrome-stable");
    expect(pools.find((pool) => pool.poolId === `base:${stablePool}`)?.extra?.evmV2ExecutionCandidate).toBeUndefined();
  });

  it("attaches a unique classic Aerodrome candidate to a DeFiLlama UUID row", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const usdz = "0x04d5ddf5f3a8939889f11e97f8c4bb48317f1938";
    const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const exactPool = "0x6d0b9c9e92a3de30081563c3657b5258b3ffa38b";
    const candidate = buildEvmV2ExecutionCandidate({
      chain: "base",
      protocol: "aerodrome",
      poolType: "aerodrome-volatile",
      poolAddress: exactPool,
      tokenAddresses: [usdz, usdc],
      tokenSymbols: ["USDz", "USDC"],
      confirmedStable: false,
    })!;
    const symbolToIds = new Map<string, string[]>([["USDZ", ["usdz-anzen"]]]);

    const metrics = processPoolMetrics(
      [
        makePool({
          pool: "b31a754f-7e3e-4c1a-838f-9a5071f2d622",
          chain: "Base",
          project: "aerodrome",
          symbol: "USDz-USDC",
          underlyingTokens: [usdz, usdc],
        }),
      ],
      new Set(["aerodrome"]),
      symbolToIds,
      buildSymbolToChainScopedIds(symbolToIds, ["base"]),
      new Map(),
      new Map([[`base:${usdz}`, "usdz-anzen"]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map([["usdz-anzen", 1]]),
      1_752_560_000,
      undefined,
      new Map([[`base:${exactPool}`, candidate]]),
    );

    const retained = metrics.get("usdz-anzen")?.topPools[0];
    expect(retained?.poolId).toBe(buildPoolFingerprint("base", "aerodrome", [usdz, usdc]));
    expect(retained?.extra?.evmV2ExecutionCandidate).toEqual(candidate);
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
    const aerodromeIsStable = new Map<string, boolean>([["base:0xaero", true]]);

    const metrics = processPoolMetrics(
      [
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
      dexProjects,
      symbolToIds,
      symbolToChainScopedIds,
      addressToId,
      chainAddressToId,
      curvePoolMap,
      uniV3PoolFees,
      uniV3SymbolFees,
      aerodromeIsStable,
    );

    expect(chainAddressToId.get("ethereum:0xusdc-new")).toBeUndefined();
    expect(metrics.has("cusd-cap")).toBe(false);
    expect(metrics.has("cusd-celo")).toBe(false);

    const usdt = metrics.get("usdt-tether");
    expect(usdt).toBeDefined();
    expect(usdt?.totalTvlUsd).toBe(2_650_000);
    expect(usdt?.poolCount).toBe(5);
    expect(usdt?.protocolTvl).toEqual({
      curve: 1_650_000,
      "uniswap-v3": 500_000,
      aerodrome: 300_000,
      sushiswap: 200_000,
    });
    expect(usdt?.chainTvl).toEqual({
      Ethereum: 2_350_000,
      Base: 300_000,
    });
    expect(usdt?.totalTvlForBalance).toBe(1_750_000);
    expect(usdt?.organicTvlWeightedSum).toBe(900_000);
    expect(usdt?.totalTvlForOrganic).toBe(1_500_000);
    expect(usdt?.oldestPoolDays).toBe(200);

    const curveAddressPool = usdt?.topPools.find((pool) => pool.poolId === "fp:ethereum:curve:0xusdc-new:0xusdt");
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

    const curveFallbackPool = usdt?.topPools.find((pool) => pool.poolId === "ethereum:0xcurve2");
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

    const uniAddressPool = usdt?.topPools.find((pool) => pool.poolId === "ethereum:0xuni1");
    expect(uniAddressPool).toMatchObject({
      poolType: "uniswap-v3-1bp",
      extra: {
        feeTier: 1,
        organicFraction: 1,
        maturityDays: 45,
      },
    });

    const usdc = metrics.get("usdc-circle");
    expect(usdc?.poolCount).toBe(3);
    expect(usdc?.totalTvlUsd).toBe(1_450_000);

    const uniSymbolPool = usdc?.topPools.find((pool) => pool.poolId === "ethereum:0xuni2");
    expect(uniSymbolPool).toMatchObject({
      poolType: "uniswap-v3-30bp",
      extra: {
        feeTier: 30,
        organicFraction: 0,
        maturityDays: 20,
      },
    });

    const aerodromePool = usdc?.topPools.find((pool) => pool.poolId === "base:0xaero");
    expect(aerodromePool?.poolType).toBe("aerodrome-stable");

    const usde = metrics.get("usde-ethena");
    expect(usde?.poolCount).toBe(1);
    expect(usde?.topPools[0]?.poolType).toBe("uniswap-v3-30bp");
  });

  it("does not learn wrapper addresses from positional DeFiLlama symbols", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const symbolToIds = new Map<string, string[]>([["USR", ["usr-resolv"]]]);
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, ["base"]);
    const chainAddressToId = new Map<string, string>([["base:0xusr", "usr-resolv"]]);

    const metrics = processPoolMetrics(
      [
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
      new Set(["curve"]),
      symbolToIds,
      symbolToChainScopedIds,
      new Map(),
      chainAddressToId,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(chainAddressToId.get("base:0xwabasgho")).toBeUndefined();
    expect(metrics.get("usr-resolv")?.poolCount).toBe(1);
    expect(metrics.get("usr-resolv")?.totalTvlUsd).toBe(200_000);
  });

  it("disables the DEX whitelist filter when the project index is empty", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const metrics = processPoolMetrics(
      [
        makePool({
          pool: "0xfree",
          project: "unknown-dex",
          symbol: "USDT-USDC",
          tvlUsd: 75_000,
          volumeUsd1d: 9_000,
        }),
      ],
      new Set(),
      new Map([
        ["USDT", ["usdt-tether"]],
        ["USDC", ["usdc-circle"]],
      ]),
      buildSymbolToChainScopedIds(
        new Map([
          ["USDT", ["usdt-tether"]],
          ["USDC", ["usdc-circle"]],
        ]),
        ["ethereum"],
      ),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      "[dex-liquidity] DEX project index is empty — project whitelist filter disabled for this run",
    );
    expect(metrics.get("usdt-tether")?.poolCount).toBe(1);
    expect(metrics.get("usdc-circle")?.poolCount).toBe(1);
  });

  it("skips blocked dead DEX variants including bunni", () => {
    const metrics = processPoolMetrics(
      [
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
      new Set(["bunni", "bunni-ethereum"]),
      new Map([
        ["USDT", ["usdt-tether"]],
        ["USDC", ["usdc-circle"]],
      ]),
      buildSymbolToChainScopedIds(
        new Map([
          ["USDT", ["usdt-tether"]],
          ["USDC", ["usdc-circle"]],
        ]),
        ["ethereum"],
      ),
      new Map(),
      new Map([
        ["ethereum:0xusdt", "usdt-tether"],
        ["ethereum:0xusdc", "usdc-circle"],
      ]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(metrics.size).toBe(0);
  });

  it("ignores organicFraction when apyBase is NaN", () => {
    const pool = makePool({ apyBase: NaN, apy: 5, symbol: "USDT-USDC" });
    const metrics = processPoolMetrics(
      [pool],
      new Set(["curve"]),
      new Map([
        ["USDT", ["usdt-tether"]],
        ["USDC", ["usdc-circle"]],
      ]),
      buildSymbolToChainScopedIds(
        new Map([
          ["USDT", ["usdt-tether"]],
          ["USDC", ["usdc-circle"]],
        ]),
        ["ethereum"],
      ),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
    const m = metrics.get("usdt-tether");
    expect(m).toBeDefined();
    // NaN apyBase should not mark organic fraction as measured
    expect(m!.totalTvlForOrganic).toBe(0);
  });

  it("uses apyBase fallback when apy is Infinity (avoids NaN from division)", () => {
    const pool = makePool({ apyBase: 3, apy: Infinity, symbol: "USDT-USDC" });
    const metrics = processPoolMetrics(
      [pool],
      new Set(["curve"]),
      new Map([
        ["USDT", ["usdt-tether"]],
        ["USDC", ["usdc-circle"]],
      ]),
      buildSymbolToChainScopedIds(
        new Map([
          ["USDT", ["usdt-tether"]],
          ["USDC", ["usdc-circle"]],
        ]),
        ["ethereum"],
      ),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
    const m = metrics.get("usdt-tether");
    expect(m).toBeDefined();
    // apyBase is finite and positive → else-if branch sets organicFraction=1.0
    expect(m!.totalTvlForOrganic).toBe(100_000);
  });

  it("normalizes top-pool project labels for DeFiLlama Orca rows", () => {
    const metrics = processPoolMetrics(
      [
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
      new Set(["orca-dex"]),
      new Map([
        ["USDC", ["usdc-circle"]],
        ["USDT", ["usdt-tether"]],
      ]),
      buildSymbolToChainScopedIds(
        new Map([
          ["USDC", ["usdc-circle"]],
          ["USDT", ["usdt-tether"]],
        ]),
        ["solana"],
      ),
      new Map(),
      new Map([
        ["solana:EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", "usdc-circle"],
        ["solana:Es9vMFrzaCERmJfrF4H2FY6q2JvE4YJzS83p2wM8wus", "usdt-tether"],
      ]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

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

    const metrics = processPoolMetrics(
      [
        makePool({
          pool: "0xmetapool",
          project: "curve",
          symbol: "USDC-USDT",
          tvlUsd: 100_000_000, // DL raw usdTotal includes base-pool TVL
          underlyingTokens: ["0xusdc", "0xusdt"],
          count: 5,
        }),
      ],
      new Set(["curve"]),
      symbolToIds,
      symbolToChainScopedIds,
      new Map(),
      chainAddressToId,
      curvePoolMap,
      new Map(),
      new Map(),
      new Map(),
    );

    const usdc = metrics.get("usdc-circle");
    expect(usdc).toBeDefined();
    // totalTvlUsd (and protocolTvl) rebuilt from metapoolAdjustedTvl, not raw 100M
    expect(usdc?.totalTvlUsd).toBe(60_000_000);
    expect(usdc?.protocolTvl.curve).toBe(60_000_000);
    // Top-pool row mirrors the metapool-adjusted TVL — not the raw $100M DL number
    expect(usdc?.topPools[0]?.tvlUsd).toBe(60_000_000);
    // Score parity guard: pool quality intentionally keeps the raw DL TVL
    // base, while effective TVL uses Curve's base-pool-adjusted row value.
    expect(usdc?.qualityAdjustedTvl).toBe(85_000_000);
    expect(usdc?.effectiveTvl).toBe(51_000_000);
    expect(usdc?.topPools[0]?.extra?.qualityAdjustedTvl).toBe(85_000_000);
    expect(usdc?.topPools[0]?.extra?.effectiveTvl).toBe(51_000_000);
  });

  it("F18 balance ratio: pathological >1.0 ratio does not inflate quality via Math.pow", () => {
    // Direct API balance ratios are normalized to [0, 1] before pow(1.5).
    // This regression guards against a pool surfacing an out-of-range ratio
    // that, via Math.pow(ratio, 1.5), would inflate qualityAdjustedTvl.
    vi.spyOn(console, "log").mockImplementation(() => {});

    const symbolToIds = new Map<string, string[]>([["USDC", ["usdc-circle"]]]);
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, ["ethereum"]);
    const chainAddressToId = new Map<string, string>([["ethereum:0xusdc", "usdc-circle"]]);

    // Curve entry with balance ratio clamped at 1.0 (canonical). Same TVL both branches.
    const curvePoolMap = new Map<string, CurvePoolEntry>([
      [
        "ethereum:0xclamped",
        makeCurveEntry({
          balanceRatio: 1.0,
          tvl: 1_000_000,
          metapoolAdjustedTvl: 1_000_000,
          balanceDetails: [{ symbol: "USDC", balancePct: 100, isTracked: true }],
        }),
      ],
    ]);

    const metrics = processPoolMetrics(
      [
        makePool({
          pool: "0xclamped",
          project: "curve",
          symbol: "USDC-USDC",
          tvlUsd: 1_000_000,
          underlyingTokens: ["0xusdc"],
          count: 3,
        }),
      ],
      new Set(["curve"]),
      symbolToIds,
      symbolToChainScopedIds,
      new Map(),
      chainAddressToId,
      curvePoolMap,
      new Map(),
      new Map(),
      new Map(),
    );

    const usdc = metrics.get("usdc-circle");
    expect(usdc).toBeDefined();
    // With ratio clamped to 1, balanceHealth = 1^1.5 = 1, so qualityAdjustedTvl
    // cannot exceed the underlying poolTvl * mechanism multiplier.
    // Curve stableswap A<500 mechanism = 0.85x, so qualityAdjustedTvl ≤ 850K.
    expect(usdc?.qualityAdjustedTvl).toBeLessThanOrEqual(1_000_000);
    expect(usdc?.effectiveTvl).toBeLessThanOrEqual(1_000_000);
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

    const metrics = processPoolMetrics(
      [uuidRow],
      new Set(["curve-dex"]),
      symbolToIds,
      symbolToChainScopedIds,
      new Map(),
      chainAddressToId,
      curvePoolMap,
      new Map(),
      new Map(),
      new Map(),
    );

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

    const metrics = processPoolMetrics(
      [
        makePool({
          pool: "4dbfda50-1111-2222-3333-444455556666",
          project: "curve-dex",
          symbol: "USDC-WETH",
          tvlUsd: 10_000_000,
          underlyingTokens: [USDC, WETH],
          count: 3,
        }),
      ],
      new Set(["curve-dex"]),
      symbolToIds,
      symbolToChainScopedIds,
      new Map(),
      chainAddressToId,
      curvePoolMap,
      new Map(),
      new Map(),
      new Map(),
    );

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
      processPoolMetrics(
        [retainedPool],
        new Set(["curve-dex"]),
        symbolToIds,
        symbolToChainScopedIds,
        new Map(),
        chainAddressToId,
        new Map([[`ethereum:${ACTIVE_POOL}`, candidate], [`ethereum:${ACTIVE_SIBLING}`, sibling]]),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map([["crvusd-curve", 0.9998]]),
        1_752_500_000,
        undefined,
        new Map(),
        candidateMap,
      ).get("crvusd-curve")?.topPools[0];

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
      const metrics = processPoolMetrics(
        [
          makePool({
            pool: "4dbfda50-1111-2222-3333-444455556666",
            project: "curve-dex",
            symbol: "USDC-USDT",
            tvlUsd: 1_500_000,
            underlyingTokens: [USDC, USDT],
            count: 3,
          }),
        ],
        new Set(["curve-dex"]),
        symbolToIds,
        symbolToChainScopedIds,
        new Map(),
        chainAddressToId,
        testCase.curvePoolMap,
        new Map(),
        new Map(),
        new Map(),
      );
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
        capabilityMatrixVersion: "p4a.8",
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

  it("attaches V4 shadow targets only for one exact hook-free candidate", () => {
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
    const run = (candidates: UniswapV4ExecutionCandidate[]) =>
      processPoolMetrics(
        [
          makePool({
            pool: "4dbfda50-1111-2222-3333-444455556666",
            project: "uniswap-v4-ethereum",
            poolMeta: "Uniswap V4 0.01%",
            symbol: "USDC-USDT",
            tvlUsd: 2_000_000,
            underlyingTokens: [USDC, USDT],
          }),
        ],
        new Set(["uniswap-v4-ethereum"]),
        symbolToIds,
        symbolToChainScopedIds,
        addressToId,
        chainAddressToId,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map([
          ["usdc-circle", 1],
          ["usdt-tether", 1],
        ]),
        1_785_000_000,
        undefined,
        new Map(),
        new Map(),
        new Map([[key, candidates]]),
      ).get("usdc-circle")?.topPools[0];

    expect(run([candidate])?.extra?.measuredExecutionTarget).toMatchObject({
      adapterProfileId: "uniswap-v4-hook-free-quoter-v1",
      poolId: `ethereum:${poolId}`,
      hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    });
    expect(run([candidate])?.extra?.executionCapabilityGate).toBeUndefined();

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
