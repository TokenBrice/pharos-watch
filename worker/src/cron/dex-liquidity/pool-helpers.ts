import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { ContractDeployment, StablecoinMeta } from "@shared/types/core";
import { QUALITY_MULTIPLIERS, GT_DEX_QUALITY, COMPOSITE_POOL_NAMES, normalizeDexSymbol } from "../../lib/dex-constants";
import type { LiquidityMetrics, ScoreComponents, SymbolLookups } from "./types";
import { VOLATILE_PAIR_QUALITY, SYMBOL_GOVERNANCE } from "./constants";
import { DURABILITY_COMPONENT_WEIGHTS, LIQUIDITY_COMPONENT_WEIGHTS } from "./score-weights";
import { buildChainAddressKey } from "./token-resolution";

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
  if (proj.includes("aerodrome-slipstream")) return "aerodrome-slipstream-5bp";
  if (proj.includes("velodrome-slipstream")) return "velodrome-slipstream-5bp";
  if (proj.includes("curve")) return "curve-stableswap"; // refined later via registryId
  if (proj.includes("fluid")) return "fluid-dex";
  if (proj.includes("meteora")) return "meteora-dlmm";
  if (proj.includes("aerodrome")) return "aerodrome-volatile"; // refined to aerodrome-stable via subgraph isStable flag
  if (proj.includes("balancer") && proj.includes("stable")) return "balancer-stable";
  if (proj.includes("balancer")) return "balancer-weighted";
  if (proj.includes("raydium")) return "raydium-amm";
  if (proj.includes("orca")) return "orca-whirlpool";
  if (proj.includes("pancakeswap")) return "pancakeswap-v3-5bp";
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
 * 15% organic fraction (sqrt curve), 35% TVL stability, 25% volume consistency, 25% maturity.
 */
export function computeDurabilityScore(
  m: LiquidityMetrics,
  tvlStability: number | null,
  volumeStability: number | null,
): number {
  // Organic fraction sub-score (sqrt curve — less punishing at low end)
  const organicFraction = m.totalTvlForOrganic > 0 ? m.organicTvlWeightedSum / m.totalTvlForOrganic : 0.5;
  const organicScore = Math.min(100, Math.sqrt(organicFraction) * 100);

  // TVL stability sub-score (from depth_stability, 0-1)
  const tvlStabilityScore = tvlStability != null ? tvlStability * 100 : 50;

  // Volume consistency sub-score
  const volumeConsistencyScore = volumeStability != null ? volumeStability * 100 : 50;

  // Maturity sub-score
  const maturityScore = Math.min(100, (m.oldestPoolDays / 365) * 100);

  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        organicScore * DURABILITY_COMPONENT_WEIGHTS.organicFraction +
          tvlStabilityScore * DURABILITY_COMPONENT_WEIGHTS.tvlStability +
          volumeConsistencyScore * DURABILITY_COMPONENT_WEIGHTS.volumeConsistency +
          maturityScore * DURABILITY_COMPONENT_WEIGHTS.maturity,
      ),
    ),
  );
}

export function computeLiquidityScore(
  m: LiquidityMetrics,
  durabilityScore: number,
  circulatingUsd?: number,
): { score: number; components: ScoreComponents } {
  // Component 1: TVL depth (30%) — uses effectiveTvl
  const tvlInput = m.effectiveTvl > 0 ? m.effectiveTvl : m.totalTvlUsd;
  let tvlDepth: number;
  if (circulatingUsd != null && circulatingUsd > 0) {
    // Size-aware relative formula: depth ratio vs circulating supply
    const depthRatio = tvlInput / circulatingUsd;
    tvlDepth = Math.min(100, Math.max(0, 35 * Math.log10(depthRatio / 0.0007)));
  } else {
    // Absolute fallback when market cap is unavailable
    tvlDepth = Math.min(100, Math.max(0, 20 * Math.log10(Math.max(tvlInput, 1) / 100_000) + 20));
  }

  // Component 2: Volume activity (20%) — log-scale
  const vtRatio = m.totalTvlUsd > 0 ? m.totalVolume24hUsd / m.totalTvlUsd : 0;
  const volumeActivity = vtRatio <= 0 ? 0 : Math.min(100, Math.max(0, 38 * (Math.log10(vtRatio) + 3)));

  // Component 3: Pool quality (20%) — quality retention ratio
  const qualityRetention = m.totalTvlUsd > 0 ? m.qualityAdjustedTvl / m.totalTvlUsd : 0;
  const poolQuality = Math.min(100, Math.max(0, ((qualityRetention - 0.15) / 0.65) * 100));

  // Component 4: Durability (20%) — passed in from durability computation
  const durability = durabilityScore;

  // Component 5: Pair diversity (10%)
  const pairDiversity = Math.min(100, m.poolCount * 5);

  const raw =
    tvlDepth * LIQUIDITY_COMPONENT_WEIGHTS.tvlDepth +
    volumeActivity * LIQUIDITY_COMPONENT_WEIGHTS.volumeActivity +
    poolQuality * LIQUIDITY_COMPONENT_WEIGHTS.poolQuality +
    durability * LIQUIDITY_COMPONENT_WEIGHTS.durability +
    pairDiversity * LIQUIDITY_COMPONENT_WEIGHTS.pairDiversity;

  const components: ScoreComponents = {
    tvlDepth: Math.round(tvlDepth),
    volumeActivity: Math.round(volumeActivity),
    poolQuality: Math.round(poolQuality),
    durability: Math.round(durability),
    pairDiversity: Math.round(pairDiversity),
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
  const p = project.toLowerCase().replace(/[-_]/g, "");
  if (p.includes("curve")) return "curve";
  if (p.includes("uniswapv3") || p === "univ3") return "uniswap-v3";
  if (p.includes("uniswapv4")) return "uniswap-v4";
  if (p.includes("uniswap")) return "uniswap-v2";
  if (p.includes("fluid")) return "fluid";
  if (p.includes("meteora")) return "meteora";
  if (p.includes("balancer")) return "balancer";
  if (p.includes("aerodrome")) return "aerodrome";
  if (p.includes("velodrome")) return "velodrome";
  if (p.includes("pancakeswap") || p.includes("pcsv")) return "pancakeswap";
  if (p.includes("sushiswap") || p === "sushi") return "sushiswap";
  if (p.includes("traderjoe")) return "trader-joe";
  if (p.includes("raydium")) return "raydium";
  if (p.includes("orca")) return "orca";
  if (p.includes("quickswap")) return "quickswap";
  if (p.includes("ekubo")) return "ekubo";
  // Pass through actual project name (frontend groups small ones into "Other")
  return project;
}

/** Build the canonical cross-source pool fingerprint for token-pair dedup. */
export function buildPoolFingerprint(chain: string, protocol: string, tokenAddresses: string[]): string | null {
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
  const raw = 35 * (1 - balanceRatio) + 25 * (1 - organicFraction) + 20 * immaturityPenalty + 20 * (1 - pairQuality);
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
  const symbolToChainScopedIds = new Map<string, Map<string, string[]>>();
  const collidingSymbols = new Set<string>();
  for (const meta of ACTIVE_STABLECOINS) {
    const key = normalizeDexSymbol(meta.symbol);
    const existing = symbolToIds.get(key) ?? [];
    existing.push(meta.id);
    symbolToIds.set(key, existing);
    if (existing.length > 1) collidingSymbols.add(key);

    for (const contract of getTrackedContracts(meta)) {
      const chain = contract.chain.toLowerCase();
      const scopedByChain = symbolToChainScopedIds.get(key) ?? new Map<string, string[]>();
      const scopedIds = scopedByChain.get(chain) ?? [];
      if (!scopedIds.includes(meta.id)) {
        scopedIds.push(meta.id);
      }
      scopedByChain.set(chain, scopedIds);
      symbolToChainScopedIds.set(key, scopedByChain);
    }
  }
  if (collidingSymbols.size > 0) {
    console.log(`[dex-liquidity] Symbol collisions detected: ${[...collidingSymbols].join(", ")}`);
  }

  const addressToId = new Map<string, string>();
  const chainAddressToId = new Map<string, string>();
  const contractMetaByChainAddress = new Map<
    string,
    {
      stablecoinId: string;
      symbol: string;
      decimals: number | null;
      source: "contract" | "tradedContract";
    }
  >();
  const globalAddressOwners = new Map<string, Set<string>>();
  for (const meta of ACTIVE_STABLECOINS) {
    for (const contract of meta.contracts ?? []) {
      const key = buildChainAddressKey(contract.chain, contract.address);
      chainAddressToId.set(key, meta.id);
      contractMetaByChainAddress.set(key, {
        stablecoinId: meta.id,
        symbol: meta.symbol,
        decimals:
          typeof contract.decimals === "number" && Number.isFinite(contract.decimals) ? contract.decimals : null,
        source: "contract",
      });
      const owners = globalAddressOwners.get(contract.address.toLowerCase()) ?? new Set<string>();
      owners.add(meta.id);
      globalAddressOwners.set(contract.address.toLowerCase(), owners);
    }
    for (const contract of meta.tradedContracts ?? []) {
      const key = buildChainAddressKey(contract.chain, contract.address);
      chainAddressToId.set(key, meta.id);
      if (!contractMetaByChainAddress.has(key)) {
        contractMetaByChainAddress.set(key, {
          stablecoinId: meta.id,
          symbol: meta.symbol,
          decimals:
            typeof contract.decimals === "number" && Number.isFinite(contract.decimals) ? contract.decimals : null,
          source: "tradedContract",
        });
      }
      const owners = globalAddressOwners.get(contract.address.toLowerCase()) ?? new Set<string>();
      owners.add(meta.id);
      globalAddressOwners.set(contract.address.toLowerCase(), owners);
    }
  }

  for (const meta of ACTIVE_STABLECOINS) {
    for (const contract of getTrackedContracts(meta)) {
      const owners = globalAddressOwners.get(contract.address.toLowerCase());
      if (owners && owners.size === 1) {
        addressToId.set(contract.address.toLowerCase(), meta.id);
      }
    }
  }

  return {
    symbolToIds,
    symbolToChainScopedIds,
    addressToId,
    chainAddressToId,
    contractMetaByChainAddress,
  };
}
