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
import { CG_CHAIN_MAP, GT_CHAIN_MAP, GT_ONLY_CHAIN_MAP } from "../../../lib/chain-registry";
import { initMetrics, withCompleteVolume } from "./scoring-test-builders";
import { rebuildMetricsFromPools } from "../scoring-helpers";

describe("normalizeProtocol", () => {
  it("collapses hyphenated PancakeSwap variants", () => {
    expect(normalizeProtocol("pancake-swap-v3")).toBe("pancakeswap");
    expect(normalizeProtocol("pancakeswap-v3")).toBe("pancakeswap");
    expect(normalizeProtocol("pancake_swap_v3")).toBe("pancakeswap");
  });
  it("collapses hyphenated Uniswap variants", () => {
    expect(normalizeProtocol("uni-v3")).toBe("uniswap-v3");
    expect(normalizeProtocol("uniswap-v3")).toBe("uniswap-v3");
  });
});

describe("classifyPoolType ordering", () => {
  it("classifies aerodrome-slipstream before the generic aerodrome branch", () => {
    expect(classifyPoolType("aerodrome-slipstream")).toBe("aerodrome-slipstream-5bp");
    expect(classifyPoolType("aerodrome-slipstream-base")).toBe("aerodrome-slipstream-5bp");
    expect(classifyPoolType("velodrome-slipstream")).toBe("velodrome-slipstream-5bp");
    expect(classifyPoolType("aerodrome")).toBe("aerodrome-volatile");
  });

  it("classifies Aero listings without falling into the Aerodrome or generic branches", () => {
    expect(classifyPoolType("aero-slipstream")).toBe("aero-slipstream-5bp");
    expect(classifyPoolType("aero-slipstream-ethereum")).toBe("aero-slipstream-5bp");
    expect(classifyPoolType("aero-basic")).toBe("aero-volatile");
  });
});

describe("normalizeProtocol Aero", () => {
  it("groups DefiLlama, GeckoTerminal and DexScreener Aero ids without capturing Aerodrome or lookalikes", () => {
    for (const id of ["aero", "aero-slipstream", "aero-basic", "aero-slipstream-ethereum", "Aero Slipstream"]) {
      expect(normalizeProtocol(id)).toBe("aero");
    }
    expect(normalizeProtocol("aerodrome-slipstream")).toBe("aerodrome");
    expect(normalizeProtocol("iaero-protocol")).toBe("iaero-protocol");
    expect(normalizeProtocol("aerostrategy")).toBe("aerostrategy");
  });
});

describe("computePoolQualityContribution", () => {
  it("uses retained base-pool-excluded TVL for both Curve quality and effective contributions", () => {
    const contribution = computePoolQualityContribution({
      qualityTvlUsd: 60_000_000,
      effectiveTvlUsd: 60_000_000,
      qualityMultiplier: 0.85,
      balanceRatio: 1,
      pairQuality: 1,
    });

    expect(contribution).toEqual({
      balanceHealth: 1,
      combinedQuality: 0.85,
      qualityAdjustedTvl: 51_000_000,
      effectiveTvl: 51_000_000,
    });
  });

  it("uses neutral balance health when balance is unmeasured", () => {
    const contribution = computePoolQualityContribution({
      qualityTvlUsd: 100_000,
      effectiveTvlUsd: 100_000,
      qualityMultiplier: 0.85,
      balanceRatio: 0.5,
      pairQuality: 0.8,
      hasMeasuredBalance: false,
    });

    expect(contribution.balanceHealth).toBe(1);
    expect(contribution.qualityAdjustedTvl).toBe(85_000);
    expect(contribution.effectiveTvl).toBe(68_000);
  });

  it("clamps a non-finite or negative balanceRatio instead of propagating NaN", () => {
    for (const balanceRatio of [NaN, -0.5]) {
      const contribution = computePoolQualityContribution({
        qualityTvlUsd: 100_000,
        effectiveTvlUsd: 100_000,
        qualityMultiplier: 0.85,
        balanceRatio,
        pairQuality: 0.8,
      });

      // clamp(NaN|-0.5, 0, 1) === 0 → balanceHealth = 0 ** 1.5 = 0, never NaN.
      expect(contribution.balanceHealth).toBe(0);
      expect(contribution.qualityAdjustedTvl).toBe(0);
      expect(contribution.effectiveTvl).toBe(0);
    }
  });
});

describe("computePoolPairQuality", () => {
  it("scores Curve composite quote tokens from their underlying stablecoin basket", () => {
    expect(computePoolPairQuality(["LUSD", "3CRV"], "LUSD")).toBe(1);
    expect(computePoolPairQuality(["LUSD", "3pool"], "LUSD")).toBe(1);
    expect(computePoolPairQuality(["LUSD", "FRAXBP"], "LUSD")).toBe(1);
  });
});

describe("computeLiquidityScore", () => {
  it.each([100_000_000, undefined])("preserves measured zero effective depth through rebuild and scoring (mcap %s)", (circulatingUsd) => {
    const contribution = computePoolQualityContribution({
      qualityTvlUsd: 10_000_000, effectiveTvlUsd: 10_000_000,
      qualityMultiplier: 0.85, balanceRatio: 0, pairQuality: 1,
    });
    const rebuilt = rebuildMetricsFromPools([{
      poolId: "ethereum:depleted", project: "curve", chain: "ethereum", symbol: "USDC-USDT",
      tvlUsd: 10_000_000, volumeUsd1d: 0, source: "dl", poolType: "curve",
      extra: { qualityAdjustedTvl: contribution.qualityAdjustedTvl, effectiveTvl: contribution.effectiveTvl },
    }]);
    const metrics = Object.assign(initMetrics("test", "TEST"), rebuilt);
    expect(contribution.effectiveTvl).toBe(0);
    expect(rebuilt.effectiveTvl).toBe(0);
    expect(computeLiquidityScore(withCompleteVolume(metrics), 50, circulatingUsd).components.tvlDepth).toBe(0);
  });

  it("depthRatio ≈ 0.5% → tvlDepth ≈ 30", () => {
    // depthRatio = 5_000_000 / 1_000_000_000 = 0.005
    // tvlDepth = 35 * log10(0.005 / 0.0007) = 35 * log10(7.143) ≈ 35 * 0.854 ≈ 29.9 → 30
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 5_000_000;
    m.totalTvlUsd = 5_000_000;
    m.qualityAdjustedTvl = 5_000_000;
    m.poolCount = 1;
    const { components } = computeLiquidityScore(m, 0, 1_000_000_000);
    expect(components.tvlDepth).toBeCloseTo(30, 0);
  });

  it("fallback TVL Depth at $5M tracks the ratio formula at 0.5% of $1B", () => {
    // v5.5 calibration: absolute fallback (no circulatingUsd) shares the
    // ratio formula's anchor via a $1B implied reference mcap.
    // At $5M TVL both branches should yield ~30.
    const metricsBase = () => {
      const m = initMetrics("test", "TEST");
      m.effectiveTvl = 5_000_000;
      m.totalTvlUsd = 5_000_000;
      m.qualityAdjustedTvl = 5_000_000;
      m.poolCount = 1;
      return m;
    };
    const ratioBranch = computeLiquidityScore(metricsBase(), 50, 1_000_000_000);
    const fallbackBranch = computeLiquidityScore(metricsBase(), 50, undefined);
    expect(
      Math.abs(ratioBranch.components.tvlDepth - fallbackBranch.components.tvlDepth),
    ).toBeLessThan(2);
  });

  it("zero volume → volumeActivity = 0", () => {
    // vtRatio = 0 / totalTvlUsd → volumeActivity = 0
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 1_000_000;
    m.totalTvlUsd = 1_000_000;
    m.totalVolume24hUsd = 0;
    m.qualityAdjustedTvl = 1_000_000;
    m.poolCount = 5;
    const { components } = computeLiquidityScore(withCompleteVolume(m), 50, 10_000_000);
    expect(components.volumeActivity).toBe(0);
  });

  it("qualityAdjustedTvl = 0.5 * totalTvlUsd → poolQuality ≈ 54", () => {
    // qualityRetention = 0.5
    // poolQuality = (0.5 - 0.15) / 0.65 * 100 = 0.35 / 0.65 * 100 ≈ 53.8 → 54
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 10_000_000;
    m.totalTvlUsd = 10_000_000;
    m.qualityAdjustedTvl = 5_000_000;
    m.poolCount = 5;
    const { components } = computeLiquidityScore(m, 50, 100_000_000);
    expect(components.poolQuality).toBeCloseTo(54, 0);
  });

  it("poolCount = 20 → pairDiversity = 100 (capped)", () => {
    // pairDiversity = min(100, 20 * 5) = 100
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 1_000_000;
    m.totalTvlUsd = 1_000_000;
    m.qualityAdjustedTvl = 1_000_000;
    m.poolCount = 20;
    const { components } = computeLiquidityScore(m, 50, 10_000_000);
    expect(components.pairDiversity).toBe(100);
  });

  it("extreme inputs → score capped at 100", () => {
    // Very high TVL, volume, quality, many pools → raw > 100, must clamp to 100
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 1_000_000_000;
    m.totalTvlUsd = 1_000_000_000;
    m.totalVolume24hUsd = 1_000_000_000;
    m.qualityAdjustedTvl = 1_000_000_000;
    m.poolCount = 1000;
    const { score } = computeLiquidityScore(withCompleteVolume(m), 100, 1_000_000);
    expect(score).toBe(100);
  });

  it("zero inputs (no circulatingUsd) → NR with no retained pools", () => {
    // effectiveTvl=0 and poolCount=0 is an unobserved market, not a rated zero.
    const m = initMetrics("test", "TEST");
    const { score, unavailableReason } = computeLiquidityScore(withCompleteVolume(m), 0);
    expect(score).toBeNull();
    expect(unavailableReason).toBe("no-retained-pools");
  });

  it("names the volume-activity outcome that makes the composite NR", () => {
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 1_000_000;
    m.totalTvlUsd = 1_000_000;
    m.poolCount = 5;
    const { score, unavailableReason } = computeLiquidityScore(m, 50, 10_000_000);
    expect(score).toBeNull();
    expect(unavailableReason).toBe("activity-completeness-unknown");
  });
});

describe("computePoolStress", () => {
  it("returns 100 for the worst measured pool", () => {
    expect(computePoolStress(0, 0, 0, 0)).toBe(100);
  });

  it("scores a mid-range pool from the documented component weights", () => {
    // 35*(1-0.8) + 25*(1-0.5) + 20*(1-182.5/365) + 20*(1-0.75) = 34.5 -> 35
    expect(computePoolStress(0.8, 0.5, 182.5, 0.75)).toBe(35);
  });
});

describe("computeDurabilityScore", () => {
  it("oldestPoolDays = 365 → maturityScore = 100", () => {
    // maturityScore = min(100, (365/365)*100) = 100
    const m = initMetrics("test", "TEST");
    m.organicTvlWeightedSum = 0;
    m.totalTvlForOrganic = 0; // organicFraction fallback = 0.5 → sqrt(0.5)*100 ≈ 70.7
    m.oldestPoolDays = 365;
    // raw = 70.7*0.15 + 50*0.35 + 50*0.25 + 100*0.25 = 10.6+17.5+12.5+25 = 65.6 → 66
    const score = computeDurabilityScore(m, null, null);
    expect(score).toBe(66);
  });

  it("full weighted combination: verifies the math end-to-end", () => {
    // organicFraction = 0.25 → sqrt(0.25)*100 = 50, *0.15 = 7.5
    // tvlStability = 0.8 → 80, *0.35 = 28
    // volumeStability = 0.6 → 60, *0.25 = 15
    // oldestPoolDays = 180 → (180/365)*100 ≈ 49.3, *0.25 ≈ 12.3
    // raw ≈ 7.5+28+15+12.3 = 62.8 → round → 63
    const m = initMetrics("test", "TEST");
    m.organicTvlWeightedSum = 250_000;
    m.totalTvlForOrganic = 1_000_000;
    m.oldestPoolDays = 180;
    const score = computeDurabilityScore(m, 0.8, 0.6);
    expect(score).toBe(63);
  });
});

describe("dex-liquidity pool helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bounds an out-of-range balance ratio before computing monetary contributions", () => {
    const input = { qualityTvlUsd: 1_000_000, effectiveTvlUsd: 800_000, qualityMultiplier: 0.85, pairQuality: 1 };
    const balanced = computePoolQualityContribution({ ...input, balanceRatio: 1 });
    const pathological = computePoolQualityContribution({ ...input, balanceRatio: 2 });
    expect(pathological).toEqual(balanced);
    expect(pathological).toEqual({
      balanceHealth: 1, combinedQuality: 0.85, qualityAdjustedTvl: 850_000, effectiveTvl: 680_000,
    });
  });

  it("parses composite pool names and generic delimiters", () => {
    expect(parsePoolSymbols("3pool")).toEqual(["DAI", "USDC", "USDT"]);
    expect(parsePoolSymbols("fraxbp-base")).toEqual(["FRAX", "USDC"]);
    expect(parsePoolSymbols("USDT/USDC+DAI ETH")).toEqual(["USDT", "USDC", "DAI", "ETH"]);
  });

  it("classifies pool types and quality multipliers across supported protocols", () => {
    expect(classifyPoolType("curve")).toBe("curve-stableswap");
    expect(classifyPoolType("fluid-dex")).toBe("fluid-dex");
    expect(classifyPoolType("aerodrome")).toBe("aerodrome-volatile");
    expect(classifyPoolType("balancer-stable-pool")).toBe("balancer-stable");
    expect(classifyPoolType("balancer-v2")).toBe("balancer-weighted");
    expect(classifyPoolType("uniswap-v3")).toBe("uniswap-v3-5bp");
    expect(classifyPoolType("raydium")).toBe("raydium-amm");
    expect(classifyPoolType("raydium-amm")).toBe("raydium-amm");
    expect(classifyPoolType("raydium-amm", "Standard - 0.25%")).toBe("raydium-amm");
    expect(classifyPoolType("raydium-amm", "Concentrated - 0.01%")).toBe("raydium-clmm");
    expect(classifyPoolType("Raydium CLMM")).toBe("raydium-clmm");
    for (const malformed of [123, {}, [], true]) {
      expect(classifyPoolType("raydium-amm", malformed as unknown as string)).toBe("raydium-amm");
    }
    expect(classifyPoolType("orca-whirlpool")).toBe("orca-whirlpool");
    expect(classifyPoolType("mystery-dex")).toBe("generic");

    expect(getQualityMultiplier("raydium-clmm")).toBe(0.85);
    expect(getQualityMultiplier("raydium-amm")).toBe(0.4);
    expect(getQualityMultiplier("orca-whirlpool")).toBe(0.85);
    expect(getQualityMultiplier("curve-stableswap", 700)).toBe(1);
    expect(getQualityMultiplier("curve-stableswap", 100)).toBe(0.85);
    expect(getQualityMultiplier("uniswap-v3-30bp")).toBe(0.4);
    expect(getQualityMultiplier("unknown-type")).toBe(0.3);

    expect(getGtDexQuality("balancer-v2")).toBe(0.7);
    expect(getGtDexQuality("pancakeswap-v3-arbitrum")).toBe(0.5);
    expect(getGtDexQuality("unknown-dex")).toBe(0.3);
  });

  it("keeps provider-specific GT chain slugs separate from canonical chain ids", () => {
    expect(GT_CHAIN_MAP.bob).toBe("bob-network");
    expect(GT_CHAIN_MAP.manta).toBe("manta-pacific");
    expect(GT_CHAIN_MAP.plume).toBe("plume-network");
    expect(GT_CHAIN_MAP.sei).toBe("sei-network");
    expect(GT_CHAIN_MAP.worldchain).toBe("world-chain");
    // plasma and mantle left the GT-only backfill set once their CoinGecko
    // onchain networks were verified; soneium remains GT-only.
    expect(CG_CHAIN_MAP.plasma).toBe("plasma");
    expect(CG_CHAIN_MAP.mantle).toBe("mantle");
    expect(GT_ONLY_CHAIN_MAP.soneium).toBe("soneium");
  });

  it("computes durability and liquidity scores for default and healthy cases", () => {
    // Default durability: organic defaults to 0.5 -> sqrt(0.5)*100=70.7,
    // tvlStab/volConsist default to 50 each, maturity=0, no locked liq
    // 70.7*0.15 + 50*0.35 + 50*0.25 + 0*0.25 = 10.6+17.5+12.5+0 = 41
    const empty = initMetrics("usdt-tether", "USDT");
    expect(computeDurabilityScore(empty, null, null)).toBe(41);

    const rich = initMetrics("usdc-circle", "USDC");
    rich.organicTvlWeightedSum = 80;
    rich.totalTvlForOrganic = 100;
    rich.oldestPoolDays = 730;
    // lockedLiq fields ignored now — set them to verify they don't affect score
    rich.lockedLiqWeightedSum = 60;
    rich.totalTvlForLocked = 100;

    // organic=0.8 -> sqrt(0.8)*100=89.4, tvlStab=0.9*100=90, volConsist=0.8*100=80, maturity=min(100,730/365*100)=100
    // 89.4*0.15 + 90*0.35 + 80*0.25 + 100*0.25 = 13.4+31.5+20+25 = 90
    expect(computeDurabilityScore(rich, 0.9, 0.8)).toBe(90);

    const zeroLiquidity = computeLiquidityScore(withCompleteVolume(empty), 41);
    expect(zeroLiquidity.score).toBeNull();
    expect(zeroLiquidity.unavailableReason).toBe("no-retained-pools");
    expect(zeroLiquidity.components).toEqual({
      tvlDepth: 0,
      volumeActivity: 0,
      poolQuality: 0,
      durability: 41,
      pairDiversity: 0,
    });

    rich.effectiveTvl = 10_000_000;
    rich.totalTvlUsd = 5_000_000;
    rich.totalVolume24hUsd = 1_000_000;
    rich.qualityAdjustedTvl = 8_000_000;
    rich.poolCount = 8;
    rich.chains = new Set(["Ethereum", "Base", "Arbitrum"]);

    // V/T = 1M/5M = 0.2 -> log-scale: 38*(log10(0.2)+3) = 38*2.301 = 87.4 → 87
    const healthyLiquidity = computeLiquidityScore(withCompleteVolume(rich), 90);
    expect(healthyLiquidity.score).toBeGreaterThan(60);
    expect(healthyLiquidity.components.pairDiversity).toBe(40);
    expect("crossChain" in healthyLiquidity.components).toBe(false);
  });

  it("computes size-aware liquidity scores with market cap (v5.0)", () => {
    const m = initMetrics("test-coin", "TEST");
    m.effectiveTvl = 10_000_000;
    m.totalTvlUsd = 20_000_000;
    m.totalVolume24hUsd = 1_000_000;
    m.qualityAdjustedTvl = 12_000_000;
    m.poolCount = 8;

    const circulatingUsd = 100_000_000;
    const durability = 70;

    const result = computeLiquidityScore(withCompleteVolume(m), durability, circulatingUsd);

    // TVL Depth: 35 * log10(0.10 / 0.0007) = 35 * log10(142.86) = 35 * 2.155 = 75.4 → 75
    expect(result.components.tvlDepth).toBe(75);
    // Volume: 38 * (log10(0.05) + 3) = 38 * 1.699 = 64.6 → 65
    expect(result.components.volumeActivity).toBe(65);
    // Pool Quality: (0.60 − 0.15) / 0.65 * 100 = 69.2 → 69
    expect(result.components.poolQuality).toBe(69);
    expect(result.components.durability).toBe(70);
    expect(result.components.pairDiversity).toBe(40);
    // Composite: 75*0.30 + 65*0.20 + 69*0.20 + 70*0.20 + 40*0.10 = 67.3 → 67
    expect(result.score).toBe(67);
  });

  it("clamps pool quality retention to 0-100 range", () => {
    const m = initMetrics("low-quality", "LOW");
    m.effectiveTvl = 500_000;
    m.totalTvlUsd = 10_000_000;
    m.totalVolume24hUsd = 50_000;
    m.qualityAdjustedTvl = 1_000_000; // 10% retention → below 15% floor
    m.poolCount = 3;

    const result = computeLiquidityScore(m, 50, 50_000_000);
    expect(result.components.poolQuality).toBe(0);

    const mHigh = initMetrics("high-quality", "HIGH");
    mHigh.effectiveTvl = 8_000_000;
    mHigh.totalTvlUsd = 10_000_000;
    mHigh.totalVolume24hUsd = 500_000;
    mHigh.qualityAdjustedTvl = 9_000_000; // 90% retention → above 80% cap
    mHigh.poolCount = 10;

    const resultHigh = computeLiquidityScore(mHigh, 80, 50_000_000);
    expect(resultHigh.components.poolQuality).toBe(100);
  });

  it("normalizes protocols and computes pair-quality and stress helpers", () => {
    expect(normalizeProtocol("Curve Finance")).toBe("curve");
    expect(normalizeProtocol("Uniswap-v3")).toBe("uniswap-v3");
    expect(normalizeProtocol("Uniswap-v2")).toBe("uniswap-v2");
    expect(normalizeProtocol("uniswap-v4-ethereum")).toBe("uniswap-v4");
    expect(normalizeProtocol("Fluid DEX")).toBe("fluid");
    expect(normalizeProtocol("Balancer V2")).toBe("balancer");
    expect(normalizeProtocol("Aerodrome Slipstream")).toBe("aerodrome");
    expect(normalizeProtocol("Velodrome")).toBe("velodrome");
    expect(normalizeProtocol("PancakeSwap v3")).toBe("pancakeswap");
    expect(normalizeProtocol("Sushi")).toBe("sushiswap");
    expect(normalizeProtocol("carbon-defi-ethereum")).toBe("carbon-defi");
    expect(normalizeProtocol("TraderJoe")).toBe("trader-joe");
    expect(normalizeProtocol("Raydium CLMM")).toBe("raydium");
    expect(normalizeProtocol("Orca Whirlpool")).toBe("orca");
    expect(normalizeProtocol("QuickSwap")).toBe("quickswap");
    expect(normalizeProtocol("Alien Base")).toBe("Alien Base");

    expect(getPairQuality("USDT")).toBe(1);
    expect(getPairQuality("USDe")).toBe(0.8);
    expect(getPairQuality("WETH")).toBe(0.65);
    expect(getPairQuality("UNKNOWN")).toBe(0.3);

    expect(computePoolPairQuality(["USDT", "USDe", "WETH"], "USDT")).toBe(0.8);
    expect(computePoolPairQuality(["USDT"], "USDT")).toBe(0.3);

    expect(computePoolStress(1, 1, 365, 1)).toBe(0);
    expect(computePoolStress(0.4, 0.2, 30, 0.3)).toBeGreaterThan(60);

    expect(isCryptoSwap("factory-crypto")).toBe(true);
    expect(isCryptoSwap("tricrypto")).toBe(true);
    expect(isCryptoSwap("stableswap")).toBe(false);
  });

  it("builds symbol and address lookups and reports collisions", () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { symbolToIds, chainAddressToId } = buildSymbolLookups();

    expect(symbolToIds.get("USDT")).toEqual(["usdt-tether"]);
    expect(symbolToIds.get("CUSD")).toEqual(["cusd-cap"]);
    expect(chainAddressToId.get("ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7")).toBe("usdt-tether");
    expect(chainAddressToId.get("solana:HQMYCZTDq9g3oZejDRUeQsFtLKgyfvBpD3yHaTnain3L")).toBe("eusd-telcoin");
    expect(chainAddressToId.get("solana:hqmycztdq9g3ozejdrueqsftlkgyfvbpd3yhatnain3l")).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Symbol collisions detected"));
  });

  it("canonicalizes fingerprints and tracked deployments by chain type", () => {
    expect(buildPoolFingerprint("solana", "Raydium", ["MintCase", "QuoteCase"])).toBe(
      "fp:solana:raydium:MintCase:QuoteCase",
    );
    expect(buildPoolFingerprint("solana", "Raydium", ["mintCase", "QuoteCase"])).not.toBe(
      buildPoolFingerprint("solana", "Raydium", ["MintCase", "QuoteCase"]),
    );
    expect(buildPoolFingerprint("ethereum", "Uniswap-v3", ["0xAbC", "0xDeF"])).toBe(
      "fp:ethereum:uniswap-v3:0xabc:0xdef",
    );

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
