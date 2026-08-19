import { logWorkerEventArgs } from "../../lib/structured-log";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { clamp, clampScore } from "@shared/lib/math";
import { DURABILITY_COMPONENT_WEIGHTS } from "@shared/lib/liquidity-score-weights";
import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
  canonicalExitRouteScopedId,
} from "@shared/lib/exit-route-identity";
import type { ContractDeployment, StablecoinMeta } from "@shared/types/core";
import {
  QUALITY_MULTIPLIERS,
  GT_DEX_QUALITY,
  COMPOSITE_POOL_NAMES,
  normalizeDexSymbol,
} from "../../lib/dex-cron-constants";
import type { LiquidityFallbackCounters, LiquidityMetrics, ScoreComponents, SymbolLookups } from "./types";
import { VOLATILE_PAIR_QUALITY, SYMBOL_GOVERNANCE } from "./constants";
import { LIQUIDITY_COMPONENT_WEIGHTS } from "./score-weights";
import { buildChainAddressKey } from "./token-resolution";

/**
 * Pool Quality scoring thresholds (methodology v5.0+).
 * Quality retention = qualityAdjustedTvl / totalTvlUsd, linearly rescaled
 * from [15%, 80%] to [0, 100]. See docs/dex-liquidity.md#pool-quality-formula.
 */
const POOL_QUALITY_FLOOR_RATIO = 0.15;
const POOL_QUALITY_WINDOW = 0.65; // 0.80 - 0.15
const TVL_DEPTH_SLOPE = 35;
const TVL_DEPTH_ANCHOR_RATIO = 0.0007;
const TVL_DEPTH_FALLBACK_MCAP_USD = 1_000_000_000;

function computeTvlDepthScore(depthRatio: number): number {
  return clampScore(TVL_DEPTH_SLOPE * Math.log10(depthRatio / TVL_DEPTH_ANCHOR_RATIO));
}

/** Zero-initialized report-only fallback/default counters (Liquidity v6 Phase 0.2). */
export function initLiquidityFallbackCounters(): LiquidityFallbackCounters {
  return {
    unmeasuredBalanceOptimistic: 0,
    stagedOrganicFractionDefault: 0,
    stagedBalanceRatioFallback: 0,
    fluidVolumeCoercedToZero: 0,
    fluidFeeRateUnmeasured: 0,
    fluidBalancesUnmeasured: 0,
    directApiMaturityDefaulted: 0,
    directApiBalanceUnmeasured: 0,
    directApiPriceUnmeasured: 0,
    durabilityOrganicFractionDefault: 0,
    durabilityTvlStabilityDefault: 0,
    durabilityVolumeConsistencyDefault: 0,
    tvlDepthMcapFallback: 0,
    tvlDepthRelative: 0,
    rebuildQualityAdjustedTvlFallback: 0,
    rebuildEffectiveTvlFallback: 0,
    retainedExclusionBlockedDex: 0,
    retainedExclusionVolTvlRatio: 0,
    retainedExclusionLargePoolLowVolume: 0,
  };
}

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
export function classifyPoolType(project: string, poolMeta?: string | null): string {
  const proj = project.toLowerCase();
  if (proj.includes("aerodrome-slipstream")) return "aerodrome-slipstream-5bp";
  if (proj.includes("velodrome-slipstream")) return "velodrome-slipstream-5bp";
  if (proj.includes("curve")) return "curve-stableswap"; // refined later via registryId
  if (proj.includes("fluid")) return "fluid-dex";
  if (proj.includes("meteora")) return "meteora-dlmm";
  if (proj.includes("aerodrome")) return "aerodrome-volatile"; // refined to aerodrome-stable via subgraph isStable flag
  if (proj.includes("balancer") && proj.includes("stable")) return "balancer-stable";
  if (proj.includes("balancer")) return "balancer-weighted";
  // DL lists every Raydium pool under the raydium-amm slug; the CLMM signal
  // lives in poolMeta ("Concentrated - 0.01%" vs "Standard - 0.25%").
  // Collapsing CLMM rows to raydium-amm diverges the pool-shape identity from
  // the direct fetcher's raydium-clmm classification, so the cross-source
  // dedupe never fires and the same physical pool is admitted twice.
  if (proj.includes("raydium")) {
    const meta = (poolMeta ?? "").toLowerCase();
    return proj.includes("clmm") || meta.includes("concentrated") ? "raydium-clmm" : "raydium-amm";
  }
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

export interface PoolQualityContributionInput {
  qualityTvlUsd: number;
  effectiveTvlUsd: number;
  qualityMultiplier: number;
  balanceRatio: number;
  pairQuality: number;
  hasMeasuredBalance?: boolean;
}

export interface PoolQualityContribution {
  balanceHealth: number;
  combinedQuality: number;
  qualityAdjustedTvl: number;
  effectiveTvl: number;
}

export function computePoolQualityContribution({
  qualityTvlUsd,
  effectiveTvlUsd,
  qualityMultiplier,
  balanceRatio,
  pairQuality,
  hasMeasuredBalance = true,
}: PoolQualityContributionInput): PoolQualityContribution {
  // Clamp to [0,1] so a stray NaN/negative balanceRatio can't propagate NaN into the score.
  const balanceHealth = hasMeasuredBalance ? Math.pow(clamp(balanceRatio, 0, 1), 1.5) : 1;
  const combinedQuality = qualityMultiplier * balanceHealth * pairQuality;
  return {
    balanceHealth,
    combinedQuality,
    qualityAdjustedTvl: qualityTvlUsd * qualityMultiplier * balanceHealth,
    effectiveTvl: effectiveTvlUsd * combinedQuality,
  };
}

/**
 * Compute durability score for a stablecoin (0-100).
 * 15% organic fraction (sqrt curve), 35% TVL stability, 25% volume consistency, 25% maturity.
 */
export function computeDurabilityScore(
  m: LiquidityMetrics,
  tvlStability: number | null,
  volumeStability: number | null,
  counters?: LiquidityFallbackCounters,
): number {
  // Organic fraction sub-score (sqrt curve — less punishing at low end)
  if (counters && !(m.totalTvlForOrganic > 0)) counters.durabilityOrganicFractionDefault++;
  const organicFraction = m.totalTvlForOrganic > 0 ? m.organicTvlWeightedSum / m.totalTvlForOrganic : 0.5;
  const organicScore = Math.min(100, Math.sqrt(organicFraction) * 100);

  // TVL stability sub-score (from depth_stability, 0-1)
  if (counters && tvlStability == null) counters.durabilityTvlStabilityDefault++;
  const tvlStabilityScore = tvlStability != null ? tvlStability * 100 : 50;

  // Volume consistency sub-score
  if (counters && volumeStability == null) counters.durabilityVolumeConsistencyDefault++;
  const volumeConsistencyScore = volumeStability != null ? volumeStability * 100 : 50;

  // Maturity sub-score
  const maturityScore = Math.min(100, (m.oldestPoolDays / 365) * 100);

  return clampScore(
    Math.round(
      organicScore * DURABILITY_COMPONENT_WEIGHTS.organicFraction +
        tvlStabilityScore * DURABILITY_COMPONENT_WEIGHTS.tvlStability +
        volumeConsistencyScore * DURABILITY_COMPONENT_WEIGHTS.volumeConsistency +
        maturityScore * DURABILITY_COMPONENT_WEIGHTS.maturity,
    ),
  );
}

export function computeLiquidityScore(
  m: LiquidityMetrics,
  durabilityScore: number,
  circulatingUsd?: number,
  counters?: LiquidityFallbackCounters,
): { score: number; components: ScoreComponents } {
  // Component 1: TVL depth (30%) — uses effectiveTvl
  const tvlInput = m.effectiveTvl > 0 ? m.effectiveTvl : m.totalTvlUsd;
  let tvlDepth: number;
  if (circulatingUsd != null && circulatingUsd > 0) {
    if (counters) counters.tvlDepthRelative++;
    // Size-aware relative formula: depth ratio vs circulating supply
    const depthRatio = tvlInput / circulatingUsd;
    tvlDepth = computeTvlDepthScore(depthRatio);
  } else {
    if (counters) counters.tvlDepthMcapFallback++;
    // v5.5 absolute fallback: uses a $1B implied reference mcap to reuse the
    // ratio formula's anchor (0.07% depth = score 0). Equivalent to running
    // the ratio branch with depthRatio = tvl / 1_000_000_000.
    // Yields: $700K → 0, $5M → 30, $140M → 80, ~$500M → clamps at 100.
    tvlDepth = computeTvlDepthScore(Math.max(tvlInput, 1) / TVL_DEPTH_FALLBACK_MCAP_USD);
  }

  // Component 2: Volume activity (20%) — log-scale
  const vtRatio = m.totalTvlUsd > 0 ? m.totalVolume24hUsd / m.totalTvlUsd : 0;
  const volumeActivity = vtRatio <= 0 ? 0 : clampScore(38 * (Math.log10(vtRatio) + 3));

  // Component 3: Pool quality (20%) — quality retention ratio
  const qualityRetention = m.totalTvlUsd > 0 ? m.qualityAdjustedTvl / m.totalTvlUsd : 0;
  const poolQuality = clampScore(((qualityRetention - POOL_QUALITY_FLOOR_RATIO) / POOL_QUALITY_WINDOW) * 100);

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
    score: clampScore(Math.round(raw)),
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
    totalVolume7dMeasured: true,
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
  if (p.includes("carbondefi")) return "carbon-defi";
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
  const canonicalChain = canonicalExitRouteChain(chain);
  const normalized = tokenAddresses
    .map((token) => canonicalExitRouteScopedId(canonicalChain, token))
    .filter(Boolean)
    .sort();
  if (normalized.length < 2) return null;
  return `fp:${canonicalChain}:${normalizeProtocol(protocol)}:${normalized.join(":")}`;
}

function getCompositePoolSymbols(symbol: string): string[] | null {
  const normalized = normalizeDexSymbol(symbol);
  for (const [name, symbols] of Object.entries(COMPOSITE_POOL_NAMES)) {
    if (normalizeDexSymbol(name) === normalized) return symbols;
  }
  return null;
}

/**
 * Get pairing quality score for a token symbol.
 * Uses Pharos classification for tracked stablecoins, static map for known volatile assets.
 */
export function getPairQuality(symbol: string): number {
  const normalized = normalizeDexSymbol(symbol);
  const compositeSymbols = getCompositePoolSymbols(normalized);
  if (compositeSymbols) {
    return Math.max(...compositeSymbols.map((sym) => getPairQuality(sym)));
  }
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
    const key = canonicalExitRouteAssetKey(contract.chain, contract.address);
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
  return clampScore(Math.round(raw));
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
      const chain = canonicalExitRouteChain(contract.chain);
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
    logWorkerEventArgs("handler", "info", `[dex-liquidity] Symbol collisions detected: ${[...collidingSymbols].join(", ")}`);
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
  const addAddressOwner = (chain: string, address: string, id: string) => {
    const canonicalAddress = canonicalExitRouteScopedId(chain, address);
    const owners = globalAddressOwners.get(canonicalAddress) ?? new Set<string>();
    owners.add(id);
    globalAddressOwners.set(canonicalAddress, owners);
  };
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
      addAddressOwner(contract.chain, contract.address, meta.id);
    }
    for (const contract of meta.tradedContracts ?? []) {
      const key = buildChainAddressKey(contract.chain, contract.address);
      if (!chainAddressToId.has(key)) chainAddressToId.set(key, meta.id);
      if (!contractMetaByChainAddress.has(key)) {
        contractMetaByChainAddress.set(key, {
          stablecoinId: meta.id,
          symbol: meta.symbol,
          decimals:
            typeof contract.decimals === "number" && Number.isFinite(contract.decimals) ? contract.decimals : null,
          source: "tradedContract",
        });
      }
      addAddressOwner(contract.chain, contract.address, meta.id);
    }
  }

  for (const [address, owners] of globalAddressOwners) {
    if (owners.size === 1) addressToId.set(address, [...owners][0]);
  }

  return {
    symbolToIds,
    symbolToChainScopedIds,
    addressToId,
    chainAddressToId,
    contractMetaByChainAddress,
  };
}
