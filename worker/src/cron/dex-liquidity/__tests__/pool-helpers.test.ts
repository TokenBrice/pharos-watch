import { afterEach, describe, it, expect, vi } from "vitest";
import {
  buildSymbolLookups,
  buildPoolFingerprint,
  getGtDexQuality,
  getTrackedContracts,
  getPairQuality,
  getQualityMultiplier,
  isCryptoSwap,
  parsePoolSymbols,
  classifyPoolType,
  computeDurabilityScore,
  computeLiquidityScore,
  computePoolPairQuality,
  computePoolQualityContribution,
  computePoolStress,
  normalizeProtocol,
} from "../pool-helpers";
import { trackedSideBalanceRatio } from "../../../lib/dex-cron-constants";
import { CG_CHAIN_MAP, GT_CHAIN_MAP, GT_ONLY_CHAIN_MAP } from "../../../lib/chain-registry";
import { initMetrics, withCompleteVolume } from "./scoring-test-builders";
import { rebuildMetricsFromPools } from "../scoring-helpers";

function makeMetrics(
  overrides: Partial<ReturnType<typeof initMetrics>> = {},
  id = "test",
  symbol = "TEST",
) {
  return Object.assign(initMetrics(id, symbol), overrides);
}

describe("normalizeProtocol and classifyPoolType", () => {
  it("normalizes protocol variants without capturing lookalikes", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["pancake-swap-v3", "pancakeswap"],
      ["pancakeswap-v3", "pancakeswap"],
      ["pancake_swap_v3", "pancakeswap"],
      ["PancakeSwap v3", "pancakeswap"],
      ["uni-v3", "uniswap-v3"],
      ["uniswap-v3", "uniswap-v3"],
      ["Uniswap-v3", "uniswap-v3"],
      ["Uniswap-v2", "uniswap-v2"],
      ["uniswap-v4-ethereum", "uniswap-v4"],
      ["Curve Finance", "curve"],
      ["Fluid DEX", "fluid"],
      ["Balancer V2", "balancer"],
      ["Aerodrome Slipstream", "aerodrome"],
      ["aerodrome-slipstream", "aerodrome"],
      ["Velodrome", "velodrome"],
      ["Sushi", "sushiswap"],
      ["carbon-defi-ethereum", "carbon-defi"],
      ["TraderJoe", "trader-joe"],
      ["Raydium CLMM", "raydium"],
      ["Orca Whirlpool", "orca"],
      ["QuickSwap", "quickswap"],
      ["Alien Base", "Alien Base"],
      ["aero", "aero"],
      ["aero-slipstream", "aero"],
      ["aero-basic", "aero"],
      ["aero-slipstream-ethereum", "aero"],
      ["Aero Slipstream", "aero"],
      ["iaero-protocol", "iaero-protocol"],
      ["aerostrategy", "aerostrategy"],
    ];
    for (const [input, expected] of cases) {
      expect(normalizeProtocol(input)).toBe(expected);
    }
  });

  it("classifies pool types, quality multipliers, and GT DEX quality across supported protocols", () => {
    const poolTypes: ReadonlyArray<readonly [string, string | undefined, string]> = [
      ["aerodrome-slipstream", undefined, "aerodrome-slipstream-5bp"],
      ["aerodrome-slipstream-base", undefined, "aerodrome-slipstream-5bp"],
      ["velodrome-slipstream", undefined, "velodrome-slipstream-5bp"],
      ["aerodrome", undefined, "aerodrome-volatile"],
      ["aero-slipstream", undefined, "aero-slipstream-5bp"],
      ["aero-slipstream-ethereum", undefined, "aero-slipstream-5bp"],
      ["aero-basic", undefined, "aero-volatile"],
      ["curve", undefined, "curve-stableswap"],
      ["fluid-dex", undefined, "fluid-dex"],
      ["balancer-stable-pool", undefined, "balancer-stable"],
      ["balancer-v2", undefined, "balancer-weighted"],
      ["uniswap-v3", undefined, "uniswap-v3-5bp"],
      ["raydium", undefined, "raydium-amm"],
      ["raydium-amm", undefined, "raydium-amm"],
      ["raydium-amm", "Standard - 0.25%", "raydium-amm"],
      ["raydium-amm", "Concentrated - 0.01%", "raydium-clmm"],
      ["Raydium CLMM", undefined, "raydium-clmm"],
      ["orca-whirlpool", undefined, "orca-whirlpool"],
      ["mystery-dex", undefined, "generic"],
    ];
    for (const [project, meta, expected] of poolTypes) {
      expect(classifyPoolType(project, meta)).toBe(expected);
    }
    for (const malformed of [123, {}, [], true]) {
      expect(classifyPoolType("raydium-amm", malformed as unknown as string)).toBe("raydium-amm");
    }

    const multipliers: ReadonlyArray<readonly [string, number | undefined, number]> = [
      ["raydium-clmm", undefined, 0.85],
      ["raydium-amm", undefined, 0.4],
      ["orca-whirlpool", undefined, 0.85],
      ["curve-stableswap", 700, 1],
      ["curve-stableswap", 100, 0.85],
      ["uniswap-v3-30bp", undefined, 0.4],
      ["unknown-type", undefined, 0.3],
    ];
    for (const [poolType, amp, expected] of multipliers) {
      expect(getQualityMultiplier(poolType, amp)).toBe(expected);
    }

    expect(getGtDexQuality("balancer-v2")).toBe(0.7);
    expect(getGtDexQuality("pancakeswap-v3-arbitrum")).toBe(0.5);
    expect(getGtDexQuality("unknown-dex")).toBe(0.3);
  });
});

describe("computePoolQualityContribution and trackedSideBalanceRatio", () => {
  it.each([
    {
      label: "single retained TVL",
      input: { qualityTvlUsd: 60_000_000, effectiveTvlUsd: 60_000_000, qualityMultiplier: 0.85, balanceRatio: 1, pairQuality: 1 },
      expected: { balanceHealth: 1, combinedQuality: 0.85, qualityAdjustedTvl: 51_000_000, effectiveTvl: 51_000_000 },
    },
    {
      label: "unmeasured balance defaults to neutral health",
      input: { qualityTvlUsd: 100_000, effectiveTvlUsd: 100_000, qualityMultiplier: 0.85, balanceRatio: 0.5, pairQuality: 0.8, hasMeasuredBalance: false },
      expected: { balanceHealth: 1, qualityAdjustedTvl: 85_000, effectiveTvl: 68_000 },
    },
    {
      label: "out-of-range balance ratio > 1",
      input: { qualityTvlUsd: 1_000_000, effectiveTvlUsd: 800_000, qualityMultiplier: 0.85, balanceRatio: 2, pairQuality: 1 },
      expected: { balanceHealth: 1, combinedQuality: 0.85, qualityAdjustedTvl: 850_000, effectiveTvl: 680_000 },
    },
    {
      label: "NaN balance ratio",
      input: { qualityTvlUsd: 100_000, effectiveTvlUsd: 100_000, qualityMultiplier: 0.85, balanceRatio: NaN, pairQuality: 0.8 },
      expected: { balanceHealth: 0, qualityAdjustedTvl: 0, effectiveTvl: 0 },
    },
    {
      label: "negative balance ratio",
      input: { qualityTvlUsd: 100_000, effectiveTvlUsd: 100_000, qualityMultiplier: 0.85, balanceRatio: -0.5, pairQuality: 0.8 },
      expected: { balanceHealth: 0, qualityAdjustedTvl: 0, effectiveTvl: 0 },
    },
  ])("computes pool quality contribution ($label)", ({ input, expected }) => {
    expect(computePoolQualityContribution(input)).toMatchObject(expected);
  });

  it.each([
    [0.33, 0.5, 1],
    [0.5, 0.5, 1],
    [0.75, 0.5, 1 / 3],
    [1, 0.5, 0],
    [0.5, 1 / 3, 0.5],
    [0.9, 0.8, 4 / 9],
    [NaN, 0.5, null],
    [1.1, 0.5, null],
    [0.5, 1, null],
  ])("trackedSideBalanceRatio(%s, %s) -> %s", (share, target, ratio) => {
    const result = trackedSideBalanceRatio(share, target);
    if (ratio == null) expect(result).toBeNull();
    else expect(result).toBeCloseTo(ratio, 10);
  });
});

describe("computeLiquidityScore, durability, and stress", () => {
  it.each([100_000_000, undefined])(
    "preserves measured zero effective depth through rebuild and scoring (mcap %s)",
    (circulatingUsd) => {
      const contribution = computePoolQualityContribution({
        qualityTvlUsd: 10_000_000,
        effectiveTvlUsd: 10_000_000,
        qualityMultiplier: 0.85,
        balanceRatio: 0,
        pairQuality: 1,
      });
      const rebuilt = rebuildMetricsFromPools([{
        poolId: "ethereum:depleted",
        project: "curve",
        chain: "ethereum",
        symbol: "USDC-USDT",
        tvlUsd: 10_000_000,
        volumeUsd1d: 0,
        source: "dl",
        poolType: "curve",
        extra: { qualityAdjustedTvl: contribution.qualityAdjustedTvl, effectiveTvl: contribution.effectiveTvl },
      }]);
      const metrics = makeMetrics(rebuilt);
      expect(contribution.effectiveTvl).toBe(0);
      expect(rebuilt.effectiveTvl).toBe(0);
      expect(computeLiquidityScore(withCompleteVolume(metrics), 50, circulatingUsd).components.tvlDepth).toBe(0);
    },
  );

  it("scores component anchors, caps, clamps, and NR reasons across liquidity score inputs", () => {
    const depthMetrics = () => makeMetrics({ effectiveTvl: 5_000_000, totalTvlUsd: 5_000_000, qualityAdjustedTvl: 5_000_000, poolCount: 1 });
    const ratioDepth = computeLiquidityScore(depthMetrics(), 0, 1_000_000_000);
    expect(ratioDepth.components.tvlDepth).toBeCloseTo(30, 0);
    const fallbackDepth = computeLiquidityScore(depthMetrics(), 50, undefined);
    expect(Math.abs(computeLiquidityScore(depthMetrics(), 50, 1_000_000_000).components.tvlDepth - fallbackDepth.components.tvlDepth)).toBeLessThan(2);

    const zeroVol = computeLiquidityScore(
      withCompleteVolume(makeMetrics({ effectiveTvl: 1_000_000, totalTvlUsd: 1_000_000, totalVolume24hUsd: 0, qualityAdjustedTvl: 1_000_000, poolCount: 5 })),
      50,
      10_000_000,
    );
    expect(zeroVol.components.volumeActivity).toBe(0);

    const halfQuality = computeLiquidityScore(
      makeMetrics({ effectiveTvl: 10_000_000, totalTvlUsd: 10_000_000, qualityAdjustedTvl: 5_000_000, poolCount: 5 }),
      50,
      100_000_000,
    );
    expect(halfQuality.components.poolQuality).toBeCloseTo(54, 0);

    const cappedDiv = computeLiquidityScore(
      makeMetrics({ effectiveTvl: 1_000_000, totalTvlUsd: 1_000_000, qualityAdjustedTvl: 1_000_000, poolCount: 20 }),
      50,
      10_000_000,
    );
    expect(cappedDiv.components.pairDiversity).toBe(100);

    const extreme = computeLiquidityScore(
      withCompleteVolume(makeMetrics({
        effectiveTvl: 1_000_000_000,
        totalTvlUsd: 1_000_000_000,
        totalVolume24hUsd: 1_000_000_000,
        qualityAdjustedTvl: 1_000_000_000,
        poolCount: 1000,
      })),
      100,
      1_000_000,
    );
    expect(extreme.score).toBe(100);

    const noPools = computeLiquidityScore(withCompleteVolume(makeMetrics()), 0);
    expect(noPools).toMatchObject({ score: null, unavailableReason: "no-retained-pools" });

    const unknownActivity = computeLiquidityScore(
      makeMetrics({ effectiveTvl: 1_000_000, totalTvlUsd: 1_000_000, poolCount: 5 }),
      50,
      10_000_000,
    );
    expect(unknownActivity).toMatchObject({ score: null, unavailableReason: "activity-completeness-unknown" });

    const sizeAware = computeLiquidityScore(
      withCompleteVolume(makeMetrics({
        effectiveTvl: 10_000_000,
        totalTvlUsd: 20_000_000,
        totalVolume24hUsd: 1_000_000,
        qualityAdjustedTvl: 12_000_000,
        poolCount: 8,
      })),
      70,
      100_000_000,
    );
    expect(sizeAware.components).toEqual({
      tvlDepth: 75,
      volumeActivity: 65,
      poolQuality: 69,
      durability: 70,
      pairDiversity: 40,
    });
    expect(sizeAware.score).toBe(67);

    expect(computeLiquidityScore(
      makeMetrics({ effectiveTvl: 500_000, totalTvlUsd: 10_000_000, totalVolume24hUsd: 50_000, qualityAdjustedTvl: 1_000_000, poolCount: 3 }),
      50,
      50_000_000,
    ).components.poolQuality).toBe(0);
    expect(computeLiquidityScore(
      makeMetrics({ effectiveTvl: 8_000_000, totalTvlUsd: 10_000_000, totalVolume24hUsd: 500_000, qualityAdjustedTvl: 9_000_000, poolCount: 10 }),
      80,
      50_000_000,
    ).components.poolQuality).toBe(100);
  });

  it("computes durability, pool stress, and default/healthy score invariants", () => {
    expect(computePoolStress(0, 0, 0, 0)).toBe(100);
    expect(computePoolStress(0.8, 0.5, 182.5, 0.75)).toBe(35);
    expect(computePoolStress(1, 1, 365, 1)).toBe(0);
    expect(computePoolStress(0.4, 0.2, 30, 0.3)).toBeGreaterThan(60);

    expect(computeDurabilityScore(makeMetrics({ oldestPoolDays: 365 }), null, null)).toBe(66);
    expect(computeDurabilityScore(
      makeMetrics({ organicTvlWeightedSum: 250_000, totalTvlForOrganic: 1_000_000, oldestPoolDays: 180 }),
      0.8,
      0.6,
    )).toBe(63);

    const empty = makeMetrics({}, "usdt-tether", "USDT");
    expect(computeDurabilityScore(empty, null, null)).toBe(41);
    const rich = makeMetrics({
      organicTvlWeightedSum: 80,
      totalTvlForOrganic: 100,
      oldestPoolDays: 730,
      lockedLiqWeightedSum: 60,
      totalTvlForLocked: 100,
    }, "usdc-circle", "USDC");
    expect(computeDurabilityScore(rich, 0.9, 0.8)).toBe(90);

    const zeroLiquidity = computeLiquidityScore(withCompleteVolume(empty), 41);
    expect(zeroLiquidity).toMatchObject({
      score: null,
      unavailableReason: "no-retained-pools",
      components: { tvlDepth: 0, volumeActivity: 0, poolQuality: 0, durability: 41, pairDiversity: 0 },
    });

    Object.assign(rich, {
      effectiveTvl: 10_000_000,
      totalTvlUsd: 5_000_000,
      totalVolume24hUsd: 1_000_000,
      qualityAdjustedTvl: 8_000_000,
      poolCount: 8,
      chains: new Set(["Ethereum", "Base", "Arbitrum"]),
    });
    const healthy = computeLiquidityScore(withCompleteVolume(rich), 90);
    expect(healthy.score).toBeGreaterThan(60);
    expect(healthy.components.pairDiversity).toBe(40);
    expect("crossChain" in healthy.components).toBe(false);
  });
});

describe("dex-liquidity pool identity and lookup helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scores pair quality, composite symbols, CryptoSwap detection, and GT chain slugs", () => {
    expect(computePoolPairQuality(["LUSD", "3CRV"], "LUSD")).toBe(1);
    expect(computePoolPairQuality(["LUSD", "3pool"], "LUSD")).toBe(1);
    expect(computePoolPairQuality(["LUSD", "FRAXBP"], "LUSD")).toBe(1);
    expect(computePoolPairQuality(["USDT", "USDe", "WETH"], "USDT")).toBe(0.8);
    expect(computePoolPairQuality(["USDT"], "USDT")).toBe(0.3);

    expect(getPairQuality("USDT")).toBe(1);
    expect(getPairQuality("USDe")).toBe(0.8);
    expect(getPairQuality("WETH")).toBe(0.65);
    expect(getPairQuality("UNKNOWN")).toBe(0.3);

    expect(parsePoolSymbols("3pool")).toEqual(["DAI", "USDC", "USDT"]);
    expect(parsePoolSymbols("fraxbp-base")).toEqual(["FRAX", "USDC"]);
    expect(parsePoolSymbols("USDT/USDC+DAI ETH")).toEqual(["USDT", "USDC", "DAI", "ETH"]);

    expect(isCryptoSwap("factory-crypto")).toBe(true);
    expect(isCryptoSwap("tricrypto")).toBe(true);
    expect(isCryptoSwap("stableswap")).toBe(false);

    expect(GT_CHAIN_MAP).toMatchObject({
      bob: "bob-network",
      manta: "manta-pacific",
      plume: "plume-network",
      sei: "sei-network",
      worldchain: "world-chain",
    });
    expect(CG_CHAIN_MAP.plasma).toBe("plasma");
    expect(CG_CHAIN_MAP.mantle).toBe("mantle");
    expect(GT_ONLY_CHAIN_MAP.soneium).toBe("soneium");
  });

  it("builds symbol and address lookups, fingerprints, and tracked deployments by chain type", () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { symbolToIds, chainAddressToId } = buildSymbolLookups();
    expect(symbolToIds.get("USDT")).toEqual(["usdt-tether"]);
    expect(symbolToIds.get("CUSD")).toEqual(["cusd-cap"]);
    expect(chainAddressToId.get("ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7")).toBe("usdt-tether");
    expect(chainAddressToId.get("solana:HQMYCZTDq9g3oZejDRUeQsFtLKgyfvBpD3yHaTnain3L")).toBe("eusd-telcoin");
    expect(chainAddressToId.get("solana:hqmycztdq9g3ozejdrueqsftlkgyfvbpd3yhatnain3l")).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Symbol collisions detected"));

    expect(buildPoolFingerprint("solana", "Raydium", ["MintCase", "QuoteCase"])).toBe("fp:solana:raydium:MintCase:QuoteCase");
    expect(buildPoolFingerprint("solana", "Raydium", ["mintCase", "QuoteCase"]))
      .not.toBe(buildPoolFingerprint("solana", "Raydium", ["MintCase", "QuoteCase"]));
    expect(buildPoolFingerprint("ethereum", "Uniswap-v3", ["0xAbC", "0xDeF"])).toBe("fp:ethereum:uniswap-v3:0xabc:0xdef");

    expect(
      getTrackedContracts({
        contracts: [
          { chain: "solana", address: "MintCase", decimals: 6 },
          { chain: "solana", address: "mintCase", decimals: 6 },
          { chain: "ethereum", address: "0xAbC", decimals: 6 },
          { chain: "ethereum", address: "0xabc", decimals: 6 },
        ],
      }).map(({ chain, address }) => `${chain}:${address}`),
    ).toEqual(["solana:MintCase", "solana:mintCase", "ethereum:0xAbC"]);
  });
});
