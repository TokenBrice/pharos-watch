import { afterEach, describe, expect, it, vi } from "vitest";
import { GT_CHAIN_MAP, GT_ONLY_CHAIN_MAP } from "../../lib/chain-registry";
import { QUALITY_MULTIPLIERS } from "../../lib/dex-constants";
import {
  buildSymbolLookups,
  classifyPoolType,
  computeDurabilityScore,
  computeLiquidityScore,
  computePoolPairQuality,
  computePoolStress,
  getGtDexQuality,
  getPairQuality,
  getQualityMultiplier,
  initMetrics,
  isCryptoSwap,
  normalizeProtocol,
  parsePoolSymbols,
} from "../dex-liquidity/pool-helpers";

describe("dex-liquidity pool helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(classifyPoolType("Raydium CLMM")).toBe("raydium-amm");
    expect(classifyPoolType("orca-whirlpool")).toBe("orca-whirlpool");
    expect(classifyPoolType("mystery-dex")).toBe("generic");

    expect(getQualityMultiplier("raydium-clmm")).toBe(QUALITY_MULTIPLIERS["raydium-clmm"]);
    expect(getQualityMultiplier("raydium-amm")).toBe(QUALITY_MULTIPLIERS["raydium-amm"]);
    expect(getQualityMultiplier("orca-whirlpool")).toBe(QUALITY_MULTIPLIERS["orca-whirlpool"]);
    expect(getQualityMultiplier("curve-stableswap", 700)).toBe(QUALITY_MULTIPLIERS["curve-stableswap-high-a"]);
    expect(getQualityMultiplier("curve-stableswap", 100)).toBe(QUALITY_MULTIPLIERS["curve-stableswap"]);
    expect(getQualityMultiplier("uniswap-v3-30bp")).toBe(QUALITY_MULTIPLIERS["uniswap-v3-30bp"]);
    expect(getQualityMultiplier("unknown-type")).toBe(QUALITY_MULTIPLIERS.generic);

    expect(getGtDexQuality("balancer-v2")).toBe(0.7);
    expect(getGtDexQuality("pancakeswap-v3-arbitrum")).toBe(0.5);
    expect(getGtDexQuality("unknown-dex")).toBe(QUALITY_MULTIPLIERS.generic);
  });

  it("keeps provider-specific GT chain slugs separate from canonical chain ids", () => {
    expect(GT_CHAIN_MAP.bob).toBe("bob-network");
    expect(GT_CHAIN_MAP.manta).toBe("manta-pacific");
    expect(GT_CHAIN_MAP.plume).toBe("plume-network");
    expect(GT_CHAIN_MAP.sei).toBe("sei-network");
    expect(GT_CHAIN_MAP.worldchain).toBe("world-chain");
    expect(GT_ONLY_CHAIN_MAP.plasma).toBe("plasma");
    expect(GT_ONLY_CHAIN_MAP.mantle).toBe("mantle");
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

    const zeroLiquidity = computeLiquidityScore(empty, 41);
    expect(zeroLiquidity.score).toBe(6);
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

    // V/T = 1M/5M = 0.2 -> log-scale: 33.3*log10(0.2/0.005) = 33.3*log10(40) = 33.3*1.602 = 53.3
    const healthyLiquidity = computeLiquidityScore(rich, 90);
    expect(healthyLiquidity.score).toBeGreaterThan(60);
    expect(healthyLiquidity.components.pairDiversity).toBe(40);
    // crossChain should not be present
    expect("crossChain" in healthyLiquidity.components).toBe(false);
  });

  it("normalizes protocols and computes pair-quality and stress helpers", () => {
    expect(normalizeProtocol("Curve Finance")).toBe("curve");
    expect(normalizeProtocol("Uniswap-v3")).toBe("uniswap-v3");
    expect(normalizeProtocol("Uniswap-v2")).toBe("uniswap");
    expect(normalizeProtocol("Fluid DEX")).toBe("fluid");
    expect(normalizeProtocol("Balancer V2")).toBe("balancer");
    expect(normalizeProtocol("Aerodrome Slipstream")).toBe("aerodrome");
    expect(normalizeProtocol("Velodrome")).toBe("velodrome");
    expect(normalizeProtocol("PancakeSwap v3")).toBe("pancakeswap");
    expect(normalizeProtocol("Sushi")).toBe("sushiswap");
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { symbolToIds, addressToId } = buildSymbolLookups();

    expect(symbolToIds.get("USDT")).toEqual(["usdt-tether"]);
    expect(symbolToIds.get("CUSD")).toEqual(expect.arrayContaining(["cusd-cap", "cusd-celo"]));
    expect(addressToId.get("0xdac17f958d2ee523a2206206994597c13d831ec7")).toBe("usdt-tether");
    expect(addressToId.get("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe("usdc-circle");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Symbol collisions detected"));
  });
});
