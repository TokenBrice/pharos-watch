import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { ContractDeployment, StablecoinMeta } from "@shared/types";
import {
  QUALITY_MULTIPLIERS, GT_DEX_QUALITY, COMPOSITE_POOL_NAMES, normalizeDexSymbol,
} from "../../lib/dex-constants";
import type { LiquidityMetrics, ScoreComponents, SymbolLookups } from "./types";
import { VOLATILE_PAIR_QUALITY, SYMBOL_GOVERNANCE } from "./constants";

/** Parse pool symbol string into constituent token symbols */
export function parsePoolSymbols(symbol: string): string[] {
  // Handle known composite names first
  for (const [name, symbols] of Object.entries(COMPOSITE_POOL_NAMES)) {
    if (symbol === name || symbol.startsWith(`${name}-`)) {
      return symbols.map((sym) => normalizeDexSymbol(sym));
    }
  }
  // Split on common delimiters: "-", "/", "+", " "
  return symbol
    .split(/[-/+ ]+/)
    .map((s) => normalizeDexSymbol(s))
    .filter(Boolean);
}

/** Classify a DeFiLlama pool into a pool type for quality weighting */
export function classifyPoolType(project: string): string {
  const proj = project.toLowerCase();
  if (proj.includes("curve")) return "curve-stableswap"; // refined later via registryId
  if (proj.includes("fluid")) return "fluid-dex";
  if (proj.includes("aerodrome")) return "aerodrome-volatile"; // refined to aerodrome-stable via subgraph isStable flag
  if (proj.includes("balancer") && proj.includes("stable")) return "balancer-stable";
  if (proj.includes("balancer")) return "balancer-weighted";
  if (proj.includes("uniswap-v3") || proj === "uniswap-v3") return "uniswap-v3-5bp";
  return "generic";
}

/** Get quality multiplier for a pool type, with Curve A-factor override */
export function getQualityMultiplier(poolType: string, curveA?: number): number {
  if (poolType === "curve-stableswap" && curveA != null) {
    return curveA >= 500 ? QUALITY_MULTIPLIERS["curve-stableswap-high-a"]! : QUALITY_MULTIPLIERS["curve-stableswap"]!;
  }
  return QUALITY_MULTIPLIERS[poolType] ?? QUALITY_MULTIPLIERS["generic"]!;
}

/** Resolve quality multiplier for a GeckoTerminal pool based on DEX ID */
export function getGtDexQuality(dexId: string): number {
  for (const [prefix, quality] of GT_DEX_QUALITY) {
    if (dexId.startsWith(prefix)) return quality;
  }
  return QUALITY_MULTIPLIERS["generic"]!;
}

/**
 * Compute durability score for a stablecoin (0-100).
 * 35% organic fraction, 25% TVL stability, 20% volume consistency, 15% maturity, 5% locked liquidity.
 */
export function computeDurabilityScore(
  m: LiquidityMetrics,
  tvlStability: number | null,
  volumeStability: number | null,
): number {
  // Organic fraction sub-score
  const organicFraction = m.totalTvlForOrganic > 0
    ? m.organicTvlWeightedSum / m.totalTvlForOrganic
    : 0.5;
  const organicScore = Math.min(100, organicFraction * 125);

  // TVL stability sub-score (from depth_stability, 0-1)
  const tvlStabilityScore = tvlStability != null ? tvlStability * 100 : 50;

  // Volume consistency sub-score
  const volumeConsistencyScore = volumeStability != null ? volumeStability * 100 : 50;

  // Maturity sub-score
  const maturityScore = Math.min(100, (m.oldestPoolDays / 365) * 100);

  // Locked liquidity sub-score (0-100)
  const lockedLiqFraction = m.totalTvlForLocked > 0
    ? m.lockedLiqWeightedSum / m.totalTvlForLocked
    : 0;
  const lockedLiqScore = Math.min(100, lockedLiqFraction * 125);

  return Math.max(0, Math.min(100, Math.round(
    organicScore * 0.35 +
    tvlStabilityScore * 0.25 +
    volumeConsistencyScore * 0.20 +
    maturityScore * 0.15 +
    lockedLiqScore * 0.05
  )));
}

export function computeLiquidityScore(
  m: LiquidityMetrics,
  durabilityScore: number,
): { score: number; components: ScoreComponents } {
  // Component 1: TVL depth (30%) — now uses effectiveTvl
  const tvlInput = m.effectiveTvl > 0 ? m.effectiveTvl : m.totalTvlUsd;
  const tvlDepth = Math.min(
    100,
    Math.max(0, 20 * Math.log10(Math.max(tvlInput, 1) / 100_000) + 20),
  );

  // Component 2: Volume activity (20%)
  const vtRatio = m.totalTvlUsd > 0 ? m.totalVolume24hUsd / m.totalTvlUsd : 0;
  const volumeActivity = Math.min(100, vtRatio * 200);

  // Component 3: Pool quality (20%) — quality-adjusted TVL on same log scale
  const poolQuality = Math.min(
    100,
    Math.max(0, 20 * Math.log10(Math.max(m.qualityAdjustedTvl, 1) / 100_000) + 20),
  );

  // Component 4: Durability (15%) — passed in from durability computation
  const durability = durabilityScore;

  // Component 5: Pair diversity (7.5%)
  const pairDiversity = Math.min(100, m.poolCount * 5);

  // Component 6: Cross-chain presence (7.5%)
  const chainCount = m.chains.size;
  const crossChain = chainCount <= 1
    ? 15
    : Math.min(100, 15 + (chainCount - 1) * 12);

  const raw =
    tvlDepth * 0.30 +
    volumeActivity * 0.20 +
    poolQuality * 0.20 +
    durability * 0.15 +
    pairDiversity * 0.075 +
    crossChain * 0.075;

  const components: ScoreComponents = {
    tvlDepth: Math.round(tvlDepth),
    volumeActivity: Math.round(volumeActivity),
    poolQuality: Math.round(poolQuality),
    durability: Math.round(durability),
    pairDiversity: Math.round(pairDiversity),
    crossChain: Math.round(crossChain),
  };

  return {
    score: Math.max(0, Math.min(100, Math.round(raw))),
    components,
  };
}

export function initMetrics(id: string, symbol: string): LiquidityMetrics {
  return {
    stablecoinId: id,
    symbol,
    totalTvlUsd: 0,
    totalVolume24hUsd: 0,
    totalVolume7dUsd: 0,
    poolCount: 0,
    chains: new Set(),
    pairs: new Set(),
    protocolTvl: {},
    chainTvl: {},
    qualityAdjustedTvl: 0,
    topPools: [],
    effectiveTvl: 0,
    organicTvlWeightedSum: 0,
    totalTvlForOrganic: 0,
    balanceRatioWeightedSum: 0,
    totalTvlForBalance: 0,
    stressWeightedSum: 0,
    oldestPoolDays: 0,
    lockedLiqWeightedSum: 0,
    totalTvlForLocked: 0,
  };
}

/** Normalize protocol names for grouping (merge variants, pass through the rest) */
export function normalizeProtocol(project: string): string {
  const p = project.toLowerCase();
  if (p.includes("curve")) return "curve";
  if (p.includes("uniswap-v3") || p === "uniswap-v3") return "uniswap-v3";
  if (p.includes("uniswap")) return "uniswap";
  if (p.includes("fluid")) return "fluid";
  if (p.includes("balancer")) return "balancer";
  if (p.includes("aerodrome")) return "aerodrome";
  if (p.includes("velodrome")) return "velodrome";
  if (p.includes("pancakeswap")) return "pancakeswap";
  if (p.includes("sushiswap") || p === "sushi") return "sushiswap";
  if (p.includes("trader-joe") || p.includes("traderjoe")) return "trader-joe";
  if (p.includes("raydium")) return "raydium";
  if (p.includes("orca")) return "orca";
  if (p.includes("quickswap")) return "quickswap";
  // Pass through actual project name (frontend groups small ones into "Other")
  return project;
}

/** Build the canonical cross-source pool fingerprint for token-pair dedup. */
export function buildPoolFingerprint(
  chain: string,
  protocol: string,
  tokenAddresses: string[],
): string | null {
  if (tokenAddresses.length < 2) return null;
  const normalized = tokenAddresses
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (normalized.length < 2) return null;
  return `fp:${chain.toLowerCase()}:${normalizeProtocol(protocol)}:${normalized.join(":")}`;
}

/**
 * Get pairing quality score for a token symbol.
 * Uses Pharos classification for tracked stablecoins, static map for known volatile assets.
 */
export function getPairQuality(symbol: string): number {
  const normalized = normalizeDexSymbol(symbol);
  const gov = SYMBOL_GOVERNANCE.get(normalized);
  if (gov) {
    if (gov === "centralized") return 1.0;
    if (gov === "decentralized") return 0.9;
    if (gov === "centralized-dependent") return 0.8;
    return 0.7;
  }
  return VOLATILE_PAIR_QUALITY[normalized] ?? 0.3;
}

/**
 * Compute pair quality for a stablecoin in a multi-asset pool.
 * Returns the best quality among co-tokens (one good exit route suffices).
 */
export function computePoolPairQuality(poolSymbols: string[], stablecoinSymbol: string): number {
  const stablecoinKey = normalizeDexSymbol(stablecoinSymbol);
  let best = 0;
  for (const sym of poolSymbols) {
    if (normalizeDexSymbol(sym) === stablecoinKey) continue;
    best = Math.max(best, getPairQuality(sym));
  }
  return best || 0.3;
}

export function getTrackedContracts(meta: Pick<StablecoinMeta, "contracts" | "tradedContracts">): ContractDeployment[] {
  const result: ContractDeployment[] = [];
  const seen = new Set<string>();
  for (const contract of [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])]) {
    const key = `${contract.chain}:${contract.address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(contract);
  }
  return result;
}

/**
 * Compute pool stress index (0-100, higher = more stressed).
 */
export function computePoolStress(
  balanceRatio: number,
  organicFraction: number,
  maturityDays: number,
  pairQuality: number,
): number {
  const immaturityPenalty = Math.max(0, 1 - maturityDays / 365);
  const raw =
    35 * (1 - balanceRatio) +
    25 * (1 - organicFraction) +
    20 * immaturityPenalty +
    20 * (1 - pairQuality);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** Check if a Curve registryId indicates a CryptoSwap pool */
export function isCryptoSwap(registryId: string): boolean {
  const r = registryId.toLowerCase();
  return r.includes("crypto") || r.includes("twocrypto") || r.includes("tricrypto");
}

/** Build symbol → stablecoinId and address → stablecoinId lookup maps. */
export function buildSymbolLookups(): SymbolLookups {
  const symbolToIds = new Map<string, string[]>();
  const collidingSymbols = new Set<string>();
  for (const meta of TRACKED_STABLECOINS) {
    const key = normalizeDexSymbol(meta.symbol);
    const existing = symbolToIds.get(key) ?? [];
    existing.push(meta.id);
    symbolToIds.set(key, existing);
    if (existing.length > 1) collidingSymbols.add(key);
  }
  if (collidingSymbols.size > 0) {
    console.log(`[dex-liquidity] Symbol collisions detected: ${[...collidingSymbols].join(", ")}`);
  }

  // Auto-seed from all contract addresses — resolves symbol collisions automatically
  const addressToId = new Map<string, string>();
  for (const meta of TRACKED_STABLECOINS) {
    for (const c of getTrackedContracts(meta)) {
      addressToId.set(c.address.toLowerCase(), meta.id);
    }
  }

  return { symbolToIds, addressToId };
}
