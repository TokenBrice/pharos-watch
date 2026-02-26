import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { fetchWithRetry } from "../lib/fetch-retry";
import { getCache, batchExecute } from "../lib/db";
import { USER_AGENT } from "../lib/constants";
import {
  isOnchainAvailable, initOnchainAvailability,
  CG_CHAIN_MAP, CG_CHAIN_REVERSE,
  fetchCgTokenPools, fetchCgTokensBatch,
  onchainRateLimit, parseCgPoolVolume,
} from "../lib/coingecko-onchain";

const DEFILLAMA_YIELDS_URL = "https://yields.llama.fi/pools";
const DEFILLAMA_PROTOCOLS_URL = "https://api.llama.fi/protocols";
const CURVE_API_BASE = "https://api.curve.finance/v1/getPools/all";
const CURVE_CHAINS = ["ethereum", "base", "arbitrum", "polygon"] as const;

// Uniswap V3 subgraph IDs per chain
const UNIV3_SUBGRAPHS: Record<string, string> = {
  ethereum: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
  base: "FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS",
  arbitrum: "FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM",
  polygon: "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm",
};

const UNIV3_POOL_QUERY = `{
  pools(
    first: 1000,
    orderBy: totalValueLockedUSD,
    orderDirection: desc,
    where: { totalValueLockedUSD_gt: "10000" }
  ) {
    id
    token0 { id symbol }
    token1 { id symbol }
    feeTier
    totalValueLockedUSD
    volumeUSD
    token0Price
    token1Price
    totalValueLockedToken0
    totalValueLockedToken1
  }
}`;

/** Well-known USD-pegged tokens used as reference prices in Uni V3 pool observations */
const USD_REFERENCE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "BUSD", "TUSD", "USDP", "GUSD", "LUSD", "FRAX"]);

// Well-known composite pool names → constituent symbols
const COMPOSITE_POOL_NAMES: Record<string, string[]> = {
  "3pool": ["DAI", "USDC", "USDT"],
  "3crv": ["DAI", "USDC", "USDT"],
  "3CRV": ["DAI", "USDC", "USDT"],
  "fraxbp": ["FRAX", "USDC"],
  "FRAXBP": ["FRAX", "USDC"],
};

// Explicitly blocked DEX slugs (dead/deprecated protocols not yet flagged by DeFiLlama)
const BLOCKED_DEX_IDS = new Set(["retro", "retro-finance", "retro-finance-v3"]);

// Quality multipliers for pool-type-adjusted TVL
const QUALITY_MULTIPLIERS: Record<string, number> = {
  "curve-stableswap-high-a": 1.0,
  "curve-stableswap": 0.85,
  "curve-cryptoswap": 0.5,
  "uniswap-v3-1bp": 1.1,
  "uniswap-v3-5bp": 0.85,
  "uniswap-v3-30bp": 0.4,
  "fluid-dex": 0.85,
  "aerodrome-stable": 0.85,
  "aerodrome-volatile": 0.4,
  "balancer-stable": 0.85,
  "balancer-weighted": 0.4,
  "generic": 0.3,
};

// GeckoTerminal API
const GT_API_BASE = "https://api.geckoterminal.com/api/v2";
const GT_RATE_LIMIT_MS = 2000; // 30 req/min = 1 every 2s
const GT_CRAWL_BUDGET_MS = 7 * 60 * 1000; // Max wall time for pool crawl (7 min of ~15 min cron)

/** Map our chain names (from stablecoins.ts contracts) to GT network IDs */
const GT_CHAIN_MAP: Record<string, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  bsc: "bsc",
  avalanche: "avax",
  optimism: "optimism",
  celo: "celo",
  gnosis: "xdai",
  fantom: "ftm",
};

/** Reverse map: GT network ID → our chain name */
const GT_CHAIN_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(GT_CHAIN_MAP).map(([k, v]) => [v, k])
);

/** Quality multipliers for GT-only pools, keyed by DEX ID prefix */
const GT_DEX_QUALITY: [string, number][] = [
  ["balancer", 0.7],
  ["velodrome", 0.7],
  ["pancakeswap-v3", 0.5],
  ["trader-joe", 0.5],
  ["sushiswap-v3", 0.5],
  ["camelot-v3", 0.5],
  ["maverick", 0.5],
  ["ambient", 0.5],
  ["pancakeswap-v2", 0.3],
  ["sushiswap", 0.3],
];

interface LlamaPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  volumeUsd1d: number | null;
  volumeUsd7d: number | null;
  stablecoin: boolean;
  underlyingTokens: string[] | null;
  // v2 fields
  apyBase: number | null;
  apyReward: number | null;
  apy: number;
  sigma: number;
  exposure: string;
  count: number;
}

interface CurvePool {
  address: string;
  name: string;
  amplificationCoefficient: string;
  coins: {
    symbol: string;
    address: string;
    poolBalance: string;
    usdPrice: number;
    decimals: string;
    isBasePoolLpToken?: boolean;
  }[];
  usdTotal: number;
  isMetaPool: boolean;
  assetTypeName: string;
  totalSupply: number;
  // v2 fields
  registryId: string;
  isBroken: boolean;
  virtualPrice: string;
  usdTotalExcludingBasePool: number;
  creationTs: number;
  basePoolAddress: string | null;
  gaugeCrvApy: [number, number] | null;
}

interface LiquidityMetrics {
  stablecoinId: string;
  symbol: string;
  totalTvlUsd: number;
  totalVolume24hUsd: number;
  totalVolume7dUsd: number;
  poolCount: number;
  chains: Set<string>;
  pairs: Set<string>;
  protocolTvl: Record<string, number>;
  chainTvl: Record<string, number>;
  qualityAdjustedTvl: number;
  topPools: PoolEntry[];
  // v2 fields
  effectiveTvl: number;
  organicTvlWeightedSum: number;
  totalTvlForOrganic: number;
  balanceRatioWeightedSum: number;
  totalTvlForBalance: number;
  stressWeightedSum: number;
  oldestPoolDays: number;
  lockedLiqWeightedSum: number;
  totalTvlForLocked: number;
}

interface PoolEntry {
  project: string;
  chain: string;
  tvlUsd: number;
  symbol: string;
  volumeUsd1d: number;
  poolType: string;
  extra?: {
    amplificationCoefficient?: number;
    balanceRatio?: number;
    feeTier?: number;
    effectiveTvl?: number;
    organicFraction?: number;
    pairQuality?: number;
    stressIndex?: number;
    isMetaPool?: boolean;
    maturityDays?: number;
    registryId?: string;
    balanceDetails?: {
      symbol: string;
      balancePct: number;
      isTracked: boolean;
    }[];
  };
}

interface DexPriceObs {
  price: number;
  tvl: number;
  chain: string;
  protocol: string;
}

// GeckoTerminal response types
interface GtPoolAttributes {
  address: string;
  name: string;
  pool_created_at: string | null;
  base_token_price_usd: string | null;
  quote_token_price_usd: string | null;
  reserve_in_usd: string | null;
  volume_usd: { h24: string | null } | null;
}

interface GtPool {
  id: string;
  type: string;
  attributes: GtPoolAttributes;
  relationships: {
    base_token: { data: { id: string; type: string } };
    quote_token: { data: { id: string; type: string } };
    dex: { data: { id: string; type: string } };
  };
}

interface GtTokenAttributes {
  address: string;
  name: string;
  symbol: string;
  coingecko_coin_id: string | null;
  price_usd: string | null;
  total_reserve_in_usd: string | null;
  volume_usd: { h24: string | null } | null;
}

interface GtToken {
  id: string;
  type: string;
  attributes: GtTokenAttributes;
}

/** Parse pool symbol string into constituent token symbols */
function parsePoolSymbols(symbol: string): string[] {
  // Handle known composite names first
  for (const [name, symbols] of Object.entries(COMPOSITE_POOL_NAMES)) {
    if (symbol === name || symbol.startsWith(`${name}-`)) {
      return symbols;
    }
  }
  // Split on common delimiters: "-", "/", "+", " "
  return symbol
    .split(/[-/+ ]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Classify a DeFiLlama pool into a pool type for quality weighting */
function classifyPoolType(project: string): string {
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
function getQualityMultiplier(poolType: string, curveA?: number): number {
  if (poolType === "curve-stableswap" && curveA != null) {
    return curveA >= 500 ? QUALITY_MULTIPLIERS["curve-stableswap-high-a"]! : QUALITY_MULTIPLIERS["curve-stableswap"]!;
  }
  return QUALITY_MULTIPLIERS[poolType] ?? QUALITY_MULTIPLIERS["generic"]!;
}

/** Resolve quality multiplier for a GeckoTerminal pool based on DEX ID */
function getGtDexQuality(dexId: string): number {
  for (const [prefix, quality] of GT_DEX_QUALITY) {
    if (dexId.startsWith(prefix)) return quality;
  }
  return QUALITY_MULTIPLIERS["generic"]!;
}

/** Get the active chain map — CG onchain when available, GT fallback otherwise */
function getActiveChainMap(): Record<string, string> {
  return isOnchainAvailable() ? CG_CHAIN_MAP : GT_CHAIN_MAP;
}
function getActiveChainReverse(): Record<string, string> {
  return isOnchainAvailable() ? CG_CHAIN_REVERSE : GT_CHAIN_REVERSE;
}

interface ScoreComponents {
  tvlDepth: number;
  volumeActivity: number;
  poolQuality: number;
  durability: number;
  pairDiversity: number;
  crossChain: number;
}

/**
 * Compute durability score for a stablecoin (0-100).
 * 40% organic fraction, 25% TVL stability, 20% volume consistency, 15% maturity.
 */
function computeDurabilityScore(
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

function computeLiquidityScore(
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

function initMetrics(id: string, symbol: string): LiquidityMetrics {
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
function normalizeProtocol(project: string): string {
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
  // Pass through actual project name (frontend groups small ones into "Other")
  return project;
}

/** Quality score for non-stablecoin pairing assets */
const VOLATILE_PAIR_QUALITY: Record<string, number> = {
  WETH: 0.65, ETH: 0.65, STETH: 0.65, WSTETH: 0.65, RETH: 0.65,
  WBTC: 0.6, TBTC: 0.55, CBBTC: 0.6,
};

/** Symbol → governance type lookup from TRACKED_STABLECOINS */
const SYMBOL_GOVERNANCE = new Map<string, string>();
for (const meta of TRACKED_STABLECOINS) {
  SYMBOL_GOVERNANCE.set(meta.symbol.toUpperCase(), meta.flags.governance);
}

/**
 * Get pairing quality score for a token symbol.
 * Uses Pharos classification for tracked stablecoins, static map for known volatile assets.
 */
function getPairQuality(symbol: string): number {
  const gov = SYMBOL_GOVERNANCE.get(symbol.toUpperCase());
  if (gov) {
    if (gov === "centralized") return 1.0;
    if (gov === "decentralized") return 0.9;
    if (gov === "centralized-dependent") return 0.8;
    return 0.7;
  }
  return VOLATILE_PAIR_QUALITY[symbol.toUpperCase()] ?? 0.3;
}

/**
 * Compute pair quality for a stablecoin in a multi-asset pool.
 * Returns the best quality among co-tokens (one good exit route suffices).
 */
function computePoolPairQuality(poolSymbols: string[], stablecoinSymbol: string): number {
  let best = 0;
  for (const sym of poolSymbols) {
    if (sym.toUpperCase() === stablecoinSymbol.toUpperCase()) continue;
    best = Math.max(best, getPairQuality(sym));
  }
  return best || 0.3;
}

/**
 * Compute pool stress index (0-100, higher = more stressed).
 */
function computePoolStress(
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
function isCryptoSwap(registryId: string): boolean {
  const r = registryId.toLowerCase();
  return r.includes("crypto") || r.includes("twocrypto") || r.includes("tricrypto");
}

// ---------------------------------------------------------------------------
// Intermediate types for data passed between orchestrator steps
// ---------------------------------------------------------------------------

interface CurvePoolEntry {
  A: number;
  balanceRatio: number;
  tvl: number;
  registryId: string;
  isMetaPool: boolean;
  metapoolAdjustedTvl: number;
  creationTs: number;
  balanceDetails: { symbol: string; balancePct: number; isTracked: boolean }[];
}

interface SymbolLookups {
  symbolToIds: Map<string, string[]>;
  addressToId: Map<string, string>;
}

interface DataSources {
  pools: LlamaPool[];
  dexProjects: Set<string>;
  curveResponses: (Response | null)[];
  graphApiKey: string | null;
}

interface CurveLookups {
  curvePoolMap: Map<string, CurvePoolEntry>;
  priceObservations: Map<string, DexPriceObs[]>;
}

interface UniV3Lookups {
  uniV3PoolFees: Map<string, number>;
  uniV3SymbolFees: Map<string, number>;
  uniV3PriceObs: Map<string, DexPriceObs[]>;
}

interface ScoreResult {
  tvl: number;
  vol24h: number;
  score: number;
}

// ---------------------------------------------------------------------------
// Extracted sub-functions
// ---------------------------------------------------------------------------

/** Fetch DeFiLlama Yields, Protocols list, and Curve API data. Returns null on critical failure. */
async function fetchDataSources(graphApiKey: string | null): Promise<DataSources | null> {
  const [llamaRes, protocolsRes, ...curveResponses] = await Promise.all([
    fetchWithRetry(DEFILLAMA_YIELDS_URL, {
      headers: { "User-Agent": USER_AGENT },
    }),
    fetchWithRetry(DEFILLAMA_PROTOCOLS_URL, {
      headers: { "User-Agent": USER_AGENT },
    }),
    ...CURVE_CHAINS.map((chain) =>
      fetchWithRetry(`${CURVE_API_BASE}/${chain}`, {
        headers: { "User-Agent": USER_AGENT },
      })
    ),
  ]);

  if (!llamaRes?.ok) {
    console.error("[dex-liquidity] DeFiLlama yields fetch failed");
    return null;
  }

  // Build set of project slugs categorized as "Dexs" by DeFiLlama
  const dexProjects = new Set<string>();
  if (protocolsRes?.ok) {
    const protocols = (await protocolsRes.json()) as {
      slug: string;
      category?: string;
      deadFrom?: number | null;
      rugged?: boolean | null;
      deprecated?: boolean | null;
    }[];
    for (const p of protocols) {
      if (p.category !== "Dexs") continue;
      // v2: skip dead, rugged, or deprecated protocols
      if (p.deadFrom || p.rugged || p.deprecated) continue;
      dexProjects.add(p.slug);
    }
    console.log(`[dex-liquidity] Indexed ${dexProjects.size} active DEX projects from DeFiLlama protocols`);
  } else {
    console.error("[dex-liquidity] DeFiLlama protocols fetch failed — cannot filter DEX pools, aborting");
    return null;
  }

  const llamaData = (await llamaRes.json()) as { data: LlamaPool[] };
  const pools = llamaData.data;
  if (!pools || pools.length < 100) {
    console.error(`[dex-liquidity] DeFiLlama returned only ${pools?.length ?? 0} pools, skipping`);
    return null;
  }
  console.log(`[dex-liquidity] Got ${pools.length} pools from DeFiLlama yields`);

  return { pools, dexProjects, curveResponses, graphApiKey };
}

/** Build symbol → stablecoinId and address → stablecoinId lookup maps. */
function buildSymbolLookups(): SymbolLookups {
  const symbolToIds = new Map<string, string[]>();
  const collidingSymbols = new Set<string>();
  for (const meta of TRACKED_STABLECOINS) {
    const key = meta.symbol.toUpperCase();
    const existing = symbolToIds.get(key) ?? [];
    existing.push(meta.id);
    symbolToIds.set(key, existing);
    if (existing.length > 1) collidingSymbols.add(key);
  }
  if (collidingSymbols.size > 0) {
    console.log(`[dex-liquidity] Symbol collisions detected: ${[...collidingSymbols].join(", ")}`);
  }

  // Seed with known addresses for colliding symbols (e.g. reUSD vs REUSD)
  const addressToId = new Map<string, string>([
    ["0x5086bf358635b81d8c47c66d1c8b9e567db70c72", "339"], // Re Protocol reUSD
    ["0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a", "256"], // Resupply REUSD
  ]);

  return { symbolToIds, addressToId };
}

/** Parse Curve API responses into pool lookup maps and per-token price observations. */
async function buildCurveLookups(
  curveResponses: (Response | null)[],
  symbolToIds: Map<string, string[]>,
  addressToId: Map<string, string>,
): Promise<CurveLookups> {
  const curvePoolMap = new Map<string, CurvePoolEntry>();
  const priceObservations = new Map<string, DexPriceObs[]>();

  for (let i = 0; i < CURVE_CHAINS.length; i++) {
    const res = curveResponses[i];
    if (!res?.ok) continue;
    try {
      const json = (await res.json()) as { data?: { poolData?: CurvePool[] } };
      const curvePools = json.data?.poolData ?? [];
      for (const pool of curvePools) {
        if (!pool.coins || pool.coins.length < 2) continue;
        // v2: skip broken/deprecated pools
        if (pool.isBroken) continue;
        const A = parseInt(pool.amplificationCoefficient, 10);
        if (isNaN(A)) continue;

        // Compute balance ratio (min/max) — 1.0 = perfectly balanced
        const totalUsd = pool.coins.reduce((sum, c) => {
          const raw = parseFloat(c.poolBalance);
          const decimals = parseInt(c.decimals, 10);
          return sum + (isNaN(raw) || isNaN(decimals) ? 0 : raw / 10 ** decimals * (c.usdPrice || 1));
        }, 0);

        const balances = pool.coins.map((c) => {
          const raw = parseFloat(c.poolBalance);
          const decimals = parseInt(c.decimals, 10);
          return isNaN(raw) || isNaN(decimals) ? 0 : raw / 10 ** decimals * (c.usdPrice || 1);
        }).filter((b) => b > 0);

        let balanceRatio = 1;
        if (balances.length >= 2) {
          const minBal = Math.min(...balances);
          const maxBal = Math.max(...balances);
          balanceRatio = maxBal > 0 ? minBal / maxBal : 0;
        }

        // v2: Per-token balance details + learn addresses for disambiguation
        const balanceDetails = pool.coins.map((c) => {
          const raw = parseFloat(c.poolBalance);
          const decimals = parseInt(c.decimals, 10);
          const usdBal = isNaN(raw) || isNaN(decimals) ? 0 : raw / 10 ** decimals * (c.usdPrice || 1);
          // Learn address→stablecoinId from unambiguous symbol matches
          if (c.address) {
            const sym = c.symbol.toUpperCase();
            const ids = symbolToIds.get(sym);
            if (ids && ids.length === 1) {
              addressToId.set(c.address.toLowerCase(), ids[0]);
            }
          }
          return {
            symbol: c.symbol,
            balancePct: totalUsd > 0 ? Math.round((usdBal / totalUsd) * 1000) / 10 : 0,
            isTracked: symbolToIds.has(c.symbol.toUpperCase()),
          };
        });

        // v2: Use metapool-adjusted TVL when available
        const metapoolAdjustedTvl =
          pool.basePoolAddress && pool.usdTotalExcludingBasePool > 0
            ? pool.usdTotalExcludingBasePool
            : pool.usdTotal;

        // Build a key from pool coins for matching
        const coinSymbols = pool.coins
          .map((c) => c.symbol.toUpperCase())
          .sort()
          .join("-");
        const entry: CurvePoolEntry = {
          A,
          balanceRatio,
          tvl: pool.usdTotal,
          registryId: pool.registryId ?? "",
          isMetaPool: pool.isMetaPool ?? false,
          metapoolAdjustedTvl,
          creationTs: pool.creationTs ?? 0,
          balanceDetails,
        };
        curvePoolMap.set(
          `${CURVE_CHAINS[i]}:${pool.address.toLowerCase()}`,
          entry,
        );
        // Also store by symbol combo for fallback matching
        curvePoolMap.set(
          `${CURVE_CHAINS[i]}:${coinSymbols}`,
          entry,
        );

        // Extract per-token price observations for DEX cross-validation
        // Filter: pool TVL >= $50K, balance ratio >= 0.3, coin has valid usdPrice
        if (metapoolAdjustedTvl >= 50_000 && balanceRatio >= 0.3) {
          for (const coin of pool.coins) {
            if (!coin.usdPrice || coin.usdPrice <= 0) continue;
            // Resolve stablecoin ID: prefer address match, fall back to symbol
            let resolvedIds: string[] | undefined;
            if (coin.address) {
              const addrId = addressToId.get(coin.address.toLowerCase());
              if (addrId) resolvedIds = [addrId];
            }
            if (!resolvedIds) {
              const sym = coin.symbol.toUpperCase();
              resolvedIds = symbolToIds.get(sym);
            }
            if (!resolvedIds) continue;
            for (const id of resolvedIds) {
              const obs = priceObservations.get(id) ?? [];
              obs.push({
                price: coin.usdPrice,
                tvl: metapoolAdjustedTvl,
                chain: CURVE_CHAINS[i],
                protocol: "curve",
              });
              priceObservations.set(id, obs);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[dex-liquidity] Failed to parse Curve ${CURVE_CHAINS[i]}:`, err);
    }
  }
  console.log(`[dex-liquidity] Indexed ${curvePoolMap.size} Curve pools, ${priceObservations.size} coins with Curve price obs`);

  return { curvePoolMap, priceObservations };
}

/** Fetch Uniswap V3 subgraph data for fee tier enrichment + price observations. Mutates addressToId with learned addresses. */
async function fetchUniV3Data(
  graphApiKey: string | null,
  symbolToIds: Map<string, string[]>,
  addressToId: Map<string, string>,
): Promise<UniV3Lookups> {
  const uniV3PoolFees = new Map<string, number>(); // "chain:address" → feeTier
  const uniV3SymbolFees = new Map<string, number>(); // "chain:SYM0:SYM1" → lowest feeTier
  const uniV3PriceObs = new Map<string, DexPriceObs[]>();

  if (!graphApiKey) {
    console.log("[dex-liquidity] No GRAPH_API_KEY, skipping Uni V3 subgraph enrichment");
    return { uniV3PoolFees, uniV3SymbolFees, uniV3PriceObs };
  }

  for (const [chain, subgraphId] of Object.entries(UNIV3_SUBGRAPHS)) {
    try {
      const url = `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`;
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query: UNIV3_POOL_QUERY }),
      });
      if (!res?.ok) {
        console.warn(`[dex-liquidity] Uni V3 subgraph failed for ${chain}: ${res?.status}`);
        continue;
      }
      const json = (await res.json()) as {
        data?: {
          pools?: {
            id: string;
            token0: { id: string; symbol: string };
            token1: { id: string; symbol: string };
            feeTier: string;
            totalValueLockedUSD: string;
            volumeUSD: string;
            token0Price: string;
            token1Price: string;
            totalValueLockedToken0: string;
            totalValueLockedToken1: string;
          }[];
        };
        errors?: { message: string }[];
      };
      if (json.errors?.length) {
        console.warn(`[dex-liquidity] Uni V3 subgraph GraphQL errors for ${chain}:`, json.errors.map((e) => e.message).join("; "));
        if (!json.data?.pools?.length) continue;
      }
      const subPools = json.data?.pools ?? [];
      let priceObsCount = 0;
      for (const p of subPools) {
        const feeTier = parseInt(p.feeTier, 10);
        if (isNaN(feeTier)) continue;
        const tvl = parseFloat(p.totalValueLockedUSD);
        // Address-based lookup
        uniV3PoolFees.set(`${chain}:${p.id.toLowerCase()}`, feeTier);
        // Symbol-based fallback (keep lowest fee tier per pair = most optimized for stables)
        const syms = [p.token0.symbol.toUpperCase(), p.token1.symbol.toUpperCase()].sort().join(":");
        const symKey = `${chain}:${syms}`;
        const existing = uniV3SymbolFees.get(symKey);
        if (existing == null || feeTier < existing) {
          uniV3SymbolFees.set(symKey, feeTier);
        }
        // Learn addresses for disambiguation from Uni V3 token data
        for (const tok of [p.token0, p.token1]) {
          const sym = tok.symbol.toUpperCase();
          const ids = symbolToIds.get(sym);
          if (ids?.length === 1 && tok.id) {
            addressToId.set(tok.id.toLowerCase(), ids[0]);
          }
        }

        // --- Price observations from Uni V3 pools ---
        // Only for pools with TVL >= $50K
        if (isNaN(tvl) || tvl < 50_000) continue;

        const token0Price = parseFloat(p.token0Price); // token0 per token1
        const token1Price = parseFloat(p.token1Price); // token1 per token0
        if (isNaN(token0Price) || isNaN(token1Price) || token0Price <= 0 || token1Price <= 0) continue;

        const sym0 = p.token0.symbol.toUpperCase();
        const sym1 = p.token1.symbol.toUpperCase();
        const isRef0 = USD_REFERENCE_SYMBOLS.has(sym0);
        const isRef1 = USD_REFERENCE_SYMBOLS.has(sym1);

        // If neither side is a known USD reference, skip (can't derive USD price reliably)
        if (!isRef0 && !isRef1) continue;

        // Derive USD prices: if token1 is a USD ref (~$1), token0's USD price ≈ token1Price (units of token1 per token0) × $1
        // token0Price = how many token0 you get per token1
        // token1Price = how many token1 you get per token0
        // So: token0 USD price = token1Price × $1 (when token1 is USD ref)
        //     token1 USD price = token0Price × $1 (when token0 is USD ref)
        const pairs: { symbol: string; address: string; usdPrice: number }[] = [];
        if (isRef1) {
          // token1 is a USD reference, so token0's price = token1Price × ~$1
          pairs.push({ symbol: sym0, address: p.token0.id, usdPrice: token1Price });
        }
        if (isRef0) {
          // token0 is a USD reference, so token1's price = token0Price × ~$1
          pairs.push({ symbol: sym1, address: p.token1.id, usdPrice: token0Price });
        }

        for (const { symbol, address, usdPrice } of pairs) {
          // Resolve to tracked stablecoin ID
          let resolvedIds: string[] | undefined;
          const addrId = addressToId.get(address.toLowerCase());
          if (addrId) resolvedIds = [addrId];
          if (!resolvedIds) resolvedIds = symbolToIds.get(symbol);
          if (!resolvedIds) continue;

          // Basic sanity check: USD-pegged stablecoins should be near $1
          if (usdPrice < 0.5 || usdPrice > 2.0) continue;

          for (const id of resolvedIds) {
            const obs = uniV3PriceObs.get(id) ?? [];
            obs.push({ price: usdPrice, tvl, chain, protocol: "uniswap-v3" });
            uniV3PriceObs.set(id, obs);
            priceObsCount++;
          }
        }
      }
      console.log(`[dex-liquidity] Indexed ${subPools.length} Uni V3 pools from ${chain} subgraph (${priceObsCount} price obs)`);
    } catch (err) {
      console.warn(`[dex-liquidity] Uni V3 subgraph error for ${chain}:`, err);
    }
  }

  console.log(`[dex-liquidity] Collected ${uniV3PriceObs.size} coins with Uni V3 price observations`);
  return { uniV3PoolFees, uniV3SymbolFees, uniV3PriceObs };
}

// ---------------------------------------------------------------------------
// Aerodrome subgraph
// ---------------------------------------------------------------------------

const AERODROME_SUBGRAPHS: Record<string, string> = {
  base: "GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM",
};

const AERODROME_PAIR_QUERY = `{
  pairs(
    first: 500,
    orderBy: reserveUSD,
    orderDirection: desc,
    where: { reserveUSD_gt: "10000" }
  ) {
    id
    token0 { id symbol }
    token1 { id symbol }
    reserve0
    reserve1
    reserveUSD
    token0Price
    token1Price
    isStable
  }
}`;

interface AerodromeLookups {
  aerodromePriceObs: Map<string, DexPriceObs[]>;
  aerodromeIsStable: Map<string, boolean>; // "chain:poolAddress" → isStable
}

/** Fetch Aerodrome subgraph data for price observations and pool stability flags. */
async function fetchAerodromeData(
  graphApiKey: string | null,
  symbolToIds: Map<string, string[]>,
  addressToId: Map<string, string>,
): Promise<AerodromeLookups> {
  const priceObs = new Map<string, DexPriceObs[]>();
  const isStableMap = new Map<string, boolean>();

  if (!graphApiKey) return { aerodromePriceObs: priceObs, aerodromeIsStable: isStableMap };

  for (const [chain, subgraphId] of Object.entries(AERODROME_SUBGRAPHS)) {
    try {
      const url = `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`;
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query: AERODROME_PAIR_QUERY }),
      });
      if (!res?.ok) {
        console.warn(`[dex-liquidity] Aerodrome subgraph failed for ${chain}: ${res?.status}`);
        continue;
      }
      const json = (await res.json()) as {
        data?: {
          pairs?: {
            id: string;
            token0: { id: string; symbol: string };
            token1: { id: string; symbol: string };
            reserve0: string;
            reserve1: string;
            reserveUSD: string;
            token0Price: string;
            token1Price: string;
            isStable: boolean;
          }[];
        };
        errors?: { message: string }[];
      };
      if (json.errors?.length) {
        console.warn(`[dex-liquidity] Aerodrome subgraph GraphQL errors for ${chain}:`, json.errors.map((e) => e.message).join("; "));
        if (!json.data?.pairs?.length) continue;
      }
      const pairs = json.data?.pairs ?? [];
      let obsCount = 0;
      for (const pair of pairs) {
        const reserveUSD = parseFloat(pair.reserveUSD);
        if (isNaN(reserveUSD) || reserveUSD < 50_000) continue;

        // Store isStable flag for pool type refinement in processPoolMetrics
        isStableMap.set(`${chain}:${pair.id.toLowerCase()}`, pair.isStable);

        // Compute balance ratio from reserves in USD terms
        const reserve0 = parseFloat(pair.reserve0);
        const reserve1 = parseFloat(pair.reserve1);
        const token0Price = parseFloat(pair.token0Price); // token0 per token1
        const token1Price = parseFloat(pair.token1Price); // token1 per token0
        if (isNaN(reserve0) || isNaN(reserve1) || reserve0 <= 0 || reserve1 <= 0) continue;
        if (isNaN(token0Price) || isNaN(token1Price) || token0Price <= 0 || token1Price <= 0) continue;

        // Approximate USD values: each reserve is half of reserveUSD in a balanced pool
        // More precisely: reserveUSD = reserve0 × price0_usd + reserve1 × price1_usd
        // We can infer: price0_usd = token1Price × price1_usd, and reserveUSD = reserve0 × token1Price × price1_usd + reserve1 × price1_usd
        // => price1_usd = reserveUSD / (reserve0 × token1Price + reserve1)
        const denom = reserve0 * token1Price + reserve1;
        if (denom <= 0) continue;
        const price1Usd = reserveUSD / denom;
        const price0Usd = token1Price * price1Usd;
        const reserve0Usd = reserve0 * price0Usd;
        const reserve1Usd = reserve1 * price1Usd;

        // Balance ratio filter
        const minReserve = Math.min(reserve0Usd, reserve1Usd);
        const maxReserve = Math.max(reserve0Usd, reserve1Usd);
        const balanceRatio = maxReserve > 0 ? minReserve / maxReserve : 0;
        if (balanceRatio < 0.3) continue;

        const sym0 = pair.token0.symbol.toUpperCase();
        const sym1 = pair.token1.symbol.toUpperCase();

        // Extract price observations for tracked stablecoins
        const tokens = [
          { symbol: sym0, address: pair.token0.id, usdPrice: price0Usd },
          { symbol: sym1, address: pair.token1.id, usdPrice: price1Usd },
        ];
        for (const { symbol, address, usdPrice } of tokens) {
          if (usdPrice < 0.5 || usdPrice > 2.0) continue; // sanity for USD pegs
          let resolvedIds: string[] | undefined;
          const addrId = addressToId.get(address.toLowerCase());
          if (addrId) resolvedIds = [addrId];
          if (!resolvedIds) resolvedIds = symbolToIds.get(symbol);
          if (!resolvedIds) continue;

          for (const id of resolvedIds) {
            const obs = priceObs.get(id) ?? [];
            obs.push({ price: usdPrice, tvl: reserveUSD, chain, protocol: "aerodrome" });
            priceObs.set(id, obs);
            obsCount++;
          }
        }
      }
      console.log(`[dex-liquidity] Indexed ${pairs.length} Aerodrome pairs from ${chain} subgraph (${obsCount} price obs)`);
    } catch (err) {
      console.warn(`[dex-liquidity] Aerodrome subgraph error for ${chain}:`, err);
    }
  }

  console.log(`[dex-liquidity] Collected ${priceObs.size} coins with Aerodrome price observations, ${isStableMap.size} pool stability flags`);
  return { aerodromePriceObs: priceObs, aerodromeIsStable: isStableMap };
}

/** Collect all pool addresses from existing sources for dedup against GT */
function buildKnownPoolAddresses(
  pools: LlamaPool[],
  dexProjects: Set<string>,
  curvePoolMap: Map<string, CurvePoolEntry>,
  uniV3PoolFees: Map<string, number>,
  aerodromeIsStable: Map<string, boolean>,
): Set<string> {
  const known = new Set<string>();

  // DeFiLlama pools (all matched DEX pools)
  for (const pool of pools) {
    if (!pool.tvlUsd || pool.tvlUsd < 10_000) continue;
    if (!dexProjects.has(pool.project)) continue;
    if (pool.exposure === "single") continue;
    const key = `${pool.chain.toLowerCase()}:${pool.pool.toLowerCase()}`;
    known.add(key);
  }

  // Curve pools (keyed as chain:address in the map)
  for (const key of curvePoolMap.keys()) {
    // curvePoolMap keys are "chain:address" or "chain:SYMBOL-COMBO"
    // Only keep address-based keys (those containing 0x)
    if (key.includes("0x")) known.add(key);
  }

  // UniV3 pools (keyed as chain:address in the fees map)
  for (const key of uniV3PoolFees.keys()) {
    known.add(key);
  }

  // Aerodrome pools (keyed as chain:address in the isStable map)
  for (const key of aerodromeIsStable.keys()) {
    known.add(key);
  }

  console.log(`[dex-liquidity] Built known pool set: ${known.size} pool addresses from existing sources`);
  return known;
}

/** Build chain → addresses map from TRACKED_STABLECOINS contracts, filtered to supported chains */
function buildChainAddresses(): Map<string, { address: string; stablecoinId: string }[]> {
  const chainMap = getActiveChainMap();
  const result = new Map<string, { address: string; stablecoinId: string }[]>();
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts) continue;
    for (const c of meta.contracts) {
      const mappedChain = chainMap[c.chain.toLowerCase()];
      if (!mappedChain) continue;
      const list = result.get(mappedChain) ?? [];
      list.push({ address: c.address.toLowerCase(), stablecoinId: meta.id });
      result.set(mappedChain, list);
    }
  }
  return result;
}

/** Fetch token-level aggregate data from GT multi-token endpoint.
 *  Returns price observations (one per token per chain). */
async function fetchGtTokenBatch(
  addressToId: Map<string, string>,
): Promise<Map<string, DexPriceObs[]>> {
  const priceObs = new Map<string, DexPriceObs[]>();
  const chainAddresses = buildChainAddresses();
  let requestCount = 0;

  for (const [gtChain, tokens] of chainAddresses) {
    const ourChain = GT_CHAIN_REVERSE[gtChain] ?? gtChain;

    // Batch into groups of 30 (GT limit for multi endpoint)
    for (let i = 0; i < tokens.length; i += 30) {
      const batch = tokens.slice(i, i + 30);
      const addresses = batch.map((t) => t.address).join(",");

      if (requestCount > 0) {
        await new Promise((r) => setTimeout(r, GT_RATE_LIMIT_MS));
      }
      requestCount++;

      try {
        const url = `${GT_API_BASE}/networks/${gtChain}/tokens/multi/${addresses}`;
        const res = await fetchWithRetry(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        });
        if (!res?.ok) continue;

        const json = (await res.json()) as { data?: GtToken[] };
        if (!json.data) continue;

        for (const token of json.data) {
          const a = token.attributes;
          const addr = a.address.toLowerCase();
          const stablecoinId = batch.find((t) => t.address === addr)?.stablecoinId
            ?? addressToId.get(addr);
          if (!stablecoinId) continue;

          const price = parseFloat(a.price_usd ?? "");
          const tvl = parseFloat(a.total_reserve_in_usd ?? "");
          if (!price || price <= 0 || isNaN(price)) continue;
          if (price < 0.5 || price > 2.0) continue; // USD peg sanity
          if (!tvl || tvl < 50_000) continue;

          const obs = priceObs.get(stablecoinId) ?? [];
          obs.push({ price, tvl, chain: ourChain, protocol: "geckoterminal-aggregate" });
          priceObs.set(stablecoinId, obs);
        }
      } catch (err) {
        console.warn(`[dex-liquidity] GT token batch error for ${gtChain}:`, err);
      }
    }
  }

  console.log(`[dex-liquidity] GT token batch: ${priceObs.size} coins with price obs (${requestCount} requests)`);
  return priceObs;
}

/** Result of GT pool crawl: new pools to merge into metrics + price observations */
interface GtCrawlResult {
  /** New pools not found in existing sources, keyed by stablecoinId */
  newPools: Map<string, GtNewPool[]>;
  /** Price observations from all non-Curve GT pools */
  priceObs: Map<string, DexPriceObs[]>;
  /** Stats for logging */
  stats: { requests: number; poolsSeen: number; poolsNew: number; poolsSkippedCurve: number; poolsSkippedKnown: number };
}

interface GtNewPool {
  address: string;
  chain: string;
  dexId: string;
  name: string;
  tvlUsd: number;
  volume24hUsd: number;
  qualityMultiplier: number;
  maturityDays: number;
  poolType: string;
  /** The stablecoin's price in this pool */
  price: number;
  /** Pool symbol (e.g., "USDC / USDT") */
  symbol: string;
}

interface CgNewPool extends GtNewPool {
  /** Balance ratio computed from base/quote token balances (null if unavailable) */
  balanceRatio: number | null;
  /** Locked liquidity percentage (null if unavailable) */
  lockedLiquidityPct: number | null;
  /** Pool fee percentage from CG (null if unavailable) */
  feePercentage: number | null;
}

/** Fetch token-level aggregate data from CoinGecko onchain multi-token endpoint.
 *  Returns price observations (one per token per chain). */
async function fetchCgTokenBatchPrices(
  addressToId: Map<string, string>,
): Promise<Map<string, DexPriceObs[]>> {
  const priceObs = new Map<string, DexPriceObs[]>();
  const chainAddresses = buildChainAddresses();
  let requestCount = 0;

  for (const [cgChain, tokens] of chainAddresses) {
    const ourChain = getActiveChainReverse()[cgChain] ?? cgChain;

    // Batch into groups of 30 (CG limit for multi endpoint)
    for (let i = 0; i < tokens.length; i += 30) {
      const batch = tokens.slice(i, i + 30);
      const addresses = batch.map((t) => t.address);

      await onchainRateLimit(requestCount);
      requestCount++;

      try {
        const cgTokens = await fetchCgTokensBatch(cgChain, addresses);
        for (const token of cgTokens) {
          const a = token.attributes;
          const addr = a.address.toLowerCase();
          const stablecoinId = batch.find((t) => t.address === addr)?.stablecoinId
            ?? addressToId.get(addr);
          if (!stablecoinId) continue;

          const price = parseFloat(a.price_usd ?? "");
          const tvl = parseFloat(a.total_reserve_in_usd ?? "");
          if (!price || price <= 0 || isNaN(price)) continue;
          if (price < 0.5 || price > 2.0) continue; // USD peg sanity
          if (!tvl || tvl < 50_000) continue;

          const obs = priceObs.get(stablecoinId) ?? [];
          obs.push({ price, tvl, chain: ourChain, protocol: "coingecko-aggregate" });
          priceObs.set(stablecoinId, obs);
        }
      } catch (err) {
        console.warn(`[dex-liquidity] CG token batch error for ${cgChain}:`, err);
      }
    }
  }

  console.log(`[dex-liquidity] CG token batch: ${priceObs.size} coins with price obs (${requestCount} requests)`);
  return priceObs;
}

/** Crawl CG onchain pools for all tracked stablecoins.
 *  No time budget needed — CG paid API is ~8x faster than GT free. */
async function fetchCgPools(
  addressToId: Map<string, string>,
  knownPoolAddrs: Set<string>,
): Promise<{ newPools: Map<string, CgNewPool[]>; priceObs: Map<string, DexPriceObs[]>; stats: GtCrawlResult["stats"] }> {
  const newPools = new Map<string, CgNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const stats = { requests: 0, poolsSeen: 0, poolsNew: 0, poolsSkippedCurve: 0, poolsSkippedKnown: 0, poolsSkippedRatio: 0 };
  const chainAddresses = buildChainAddresses();
  const nowSec = Date.now() / 1000;

  // Flatten into single list — no shuffle needed (complete coverage every cycle)
  const allTokens: { cgChain: string; ourChain: string; address: string; stablecoinId: string }[] = [];
  for (const [cgChain, tokens] of chainAddresses) {
    const ourChain = getActiveChainReverse()[cgChain] ?? cgChain;
    for (const { address, stablecoinId } of tokens) {
      allTokens.push({ cgChain, ourChain, address, stablecoinId });
    }
  }

  for (const { cgChain, ourChain, address, stablecoinId } of allTokens) {
    await onchainRateLimit(stats.requests);
    stats.requests++;

    try {
      const pools = await fetchCgTokenPools(cgChain, address);
      for (const pool of pools) {
        stats.poolsSeen++;
        const a = pool.attributes;
        const dexId = pool.relationships.dex.data.id;
        const poolAddr = a.address.toLowerCase();
        const tvl = parseFloat(a.reserve_in_usd ?? "");
        if (!tvl || tvl < 10_000 || tvl > 1e12) continue;
        if (BLOCKED_DEX_IDS.has(dexId)) continue;

        // Skip Curve pools (already covered by Curve API with richer data)
        if (dexId.startsWith("curve")) {
          stats.poolsSkippedCurve++;
          continue;
        }

        // Resolve which token is our stablecoin
        const baseAddr = pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "";
        const quoteAddr = pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "";
        let isBase = baseAddr === address;
        let isQuote = quoteAddr === address;
        if (!isBase && !isQuote) {
          const baseId = addressToId.get(baseAddr);
          const quoteId = addressToId.get(quoteAddr);
          if (baseId === stablecoinId) isBase = true;
          else if (quoteId === stablecoinId) isQuote = true;
          else continue;
        }

        // Extract price
        const priceStr = isBase ? a.base_token_price_usd : a.quote_token_price_usd;
        const price = parseFloat(priceStr ?? "");

        // Price observation (from ALL non-Curve pools, even known ones)
        if (price >= 0.5 && price <= 2.0 && tvl >= 50_000) {
          const obs = priceObs.get(stablecoinId) ?? [];
          obs.push({ price, tvl, chain: ourChain, protocol: dexId });
          priceObs.set(stablecoinId, obs);
        }

        // Skip known pools for TVL/volume accounting
        const poolKey = `${ourChain}:${poolAddr}`;
        if (knownPoolAddrs.has(poolKey)) {
          stats.poolsSkippedKnown++;
          continue;
        }

        // Volume + sanity check
        const vol24h = parseCgPoolVolume(a);
        if (tvl > 0 && vol24h / tvl > 50) {
          stats.poolsSkippedRatio++;
          continue;
        }

        // Quality multiplier (use fee percentage if available, else DEX-based)
        const feePct = a.pool_fee_percentage != null ? parseFloat(a.pool_fee_percentage) : null;
        let qualMult: number;
        let poolType: string;
        if (feePct != null && !isNaN(feePct)) {
          // Fee-based classification (works for any concentrated liquidity DEX)
          if (feePct <= 0.01) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-1bp"]!; poolType = "cg-cl-1bp"; }
          else if (feePct <= 0.05) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-5bp"]!; poolType = "cg-cl-5bp"; }
          else if (feePct <= 0.30) { qualMult = QUALITY_MULTIPLIERS["uniswap-v3-30bp"]!; poolType = "cg-cl-30bp"; }
          else { qualMult = QUALITY_MULTIPLIERS["generic"]!; poolType = "cg-wide-fee"; }
        } else {
          qualMult = getGtDexQuality(dexId);
          poolType = dexId.includes("v3") || dexId.includes("v4")
            ? "cg-concentrated" : dexId.includes("stable") ? "cg-stable-amm" : "cg-amm";
        }

        // Balance ratio from token prices (NEW — not available in GT)
        let balanceRatio: number | null = null;
        const basePriceUsd = parseFloat(a.base_token_price_usd ?? "");
        const quotePriceUsd = parseFloat(a.quote_token_price_usd ?? "");
        if (basePriceUsd > 0 && quotePriceUsd > 0) {
          const priceRatio = Math.min(basePriceUsd, quotePriceUsd) / Math.max(basePriceUsd, quotePriceUsd);
          if (priceRatio > 0.5) { // Only meaningful for stable-ish pairs
            balanceRatio = priceRatio;
          }
        }

        // Locked liquidity (NEW — not available in GT)
        const lockedLiqPct = a.locked_liquidity_percentage != null
          ? parseFloat(a.locked_liquidity_percentage)
          : null;

        // Maturity
        let maturityDays = 0;
        if (a.pool_created_at) {
          const createdSec = new Date(a.pool_created_at).getTime() / 1000;
          if (createdSec > 0) maturityDays = Math.floor((nowSec - createdSec) / 86400);
        }

        const poolList = newPools.get(stablecoinId) ?? [];
        poolList.push({
          address: poolAddr,
          chain: ourChain,
          dexId,
          name: a.name,
          tvlUsd: tvl,
          volume24hUsd: vol24h,
          qualityMultiplier: qualMult,
          maturityDays,
          poolType,
          price,
          symbol: a.name,
          balanceRatio,
          lockedLiquidityPct: lockedLiqPct != null && !isNaN(lockedLiqPct) ? lockedLiqPct : null,
          feePercentage: feePct != null && !isNaN(feePct) ? feePct : null,
        });
        newPools.set(stablecoinId, poolList);
        stats.poolsNew++;
      }
    } catch (err) {
      console.warn(`[dex-liquidity] CG pool crawl error for ${ourChain}:${address}:`, err);
    }
  }

  console.log(
    `[dex-liquidity] CG pool crawl: ${stats.requests}/${allTokens.length} requests, ${stats.poolsSeen} pools seen, ` +
    `${stats.poolsNew} new, ${stats.poolsSkippedCurve} skipped (Curve), ${stats.poolsSkippedKnown} skipped (known), ${stats.poolsSkippedRatio} skipped (vol/TVL ratio)`
  );
  return { newPools, priceObs, stats };
}

/** Merge CG-discovered new pools into existing LiquidityMetrics.
 *  Unlike GT pools, CG pools can contribute real balance ratios and locked liquidity. */
function mergeCgPools(
  metrics: Map<string, LiquidityMetrics>,
  cgNewPools: Map<string, CgNewPool[]>,
): void {
  let merged = 0;
  let withBalance = 0;

  for (const [stablecoinId, pools] of cgNewPools) {
    const meta = TRACKED_STABLECOINS.find((s) => s.id === stablecoinId);
    if (!meta) continue;

    let m = metrics.get(stablecoinId);
    if (!m) {
      m = initMetrics(stablecoinId, meta.symbol);
      metrics.set(stablecoinId, m);
    }

    for (const pool of pools) {
      const balanceRatio = pool.balanceRatio ?? 1.0;
      const balanceHealth = Math.pow(balanceRatio, 1.5);
      const organicFraction = 0.5; // neutral default (no APY data from CG)
      const coinPairQuality = computePoolPairQuality(
        pool.symbol.split(/\s*\/\s*/).map((s) => s.trim()),
        meta.symbol,
      );
      const combinedQuality = pool.qualityMultiplier * balanceHealth * coinPairQuality;
      const poolEffTvl = pool.tvlUsd * combinedQuality;
      const stressIdx = computePoolStress(balanceRatio, organicFraction, pool.maturityDays, coinPairQuality);

      m.totalTvlUsd += pool.tvlUsd;
      m.totalVolume24hUsd += pool.volume24hUsd;
      m.poolCount++;
      m.chains.add(pool.chain);
      m.pairs.add(pool.symbol);
      m.qualityAdjustedTvl += pool.tvlUsd * pool.qualityMultiplier * balanceHealth;
      m.effectiveTvl += poolEffTvl;
      m.stressWeightedSum += pool.tvlUsd * stressIdx;
      m.oldestPoolDays = Math.max(m.oldestPoolDays, pool.maturityDays);

      // Locked liquidity tracking (CG pools only)
      if (pool.lockedLiquidityPct != null && pool.lockedLiquidityPct > 0) {
        m.lockedLiqWeightedSum += pool.tvlUsd * (pool.lockedLiquidityPct / 100);
        m.totalTvlForLocked += pool.tvlUsd;
      }

      // CG pools with real balance ratios contribute to balance tracking
      if (pool.balanceRatio != null) {
        m.balanceRatioWeightedSum += pool.tvlUsd * balanceRatio;
        m.totalTvlForBalance += pool.tvlUsd;
        withBalance++;
      }

      // Protocol and chain TVL
      const protocol = normalizeProtocol(pool.dexId);
      m.protocolTvl[protocol] = (m.protocolTvl[protocol] ?? 0) + pool.tvlUsd;
      m.chainTvl[pool.chain] = (m.chainTvl[pool.chain] ?? 0) + pool.tvlUsd;

      // Add to top pools
      m.topPools.push({
        project: pool.dexId,
        chain: pool.chain,
        tvlUsd: pool.tvlUsd,
        symbol: pool.symbol,
        volumeUsd1d: pool.volume24hUsd,
        poolType: pool.poolType,
        extra: {
          ...(pool.balanceRatio != null ? { balanceRatio: Math.round(pool.balanceRatio * 100) / 100 } : {}),
          ...(pool.feePercentage != null ? { feeTier: Math.round(pool.feePercentage * 10000) } : {}),
          effectiveTvl: Math.round(poolEffTvl),
          organicFraction,
          pairQuality: Math.round(coinPairQuality * 100) / 100,
          stressIndex: stressIdx,
          maturityDays: pool.maturityDays,
        },
      });

      merged++;
    }
  }

  if (merged > 0) {
    console.log(`[dex-liquidity] Merged ${merged} CG pools into ${cgNewPools.size} stablecoins (${withBalance} with balance data)`);
  }
}

/** Crawl GT pools for all tracked stablecoins, dedup against known pools.
 *  Returns new pool data and price observations. */
async function fetchGtPools(
  addressToId: Map<string, string>,
  knownPoolAddrs: Set<string>,
): Promise<GtCrawlResult> {
  const newPools = new Map<string, GtNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const stats = { requests: 0, poolsSeen: 0, poolsNew: 0, poolsSkippedCurve: 0, poolsSkippedKnown: 0, poolsSkippedRatio: 0 };
  const chainAddresses = buildChainAddresses();
  const nowSec = Date.now() / 1000;
  const startMs = Date.now();

  // Flatten into a single list and shuffle so coverage rotates across runs
  // (time budget means we can't always finish all 252 token-chain combos)
  const allTokens: { gtChain: string; ourChain: string; address: string; stablecoinId: string }[] = [];
  for (const [gtChain, tokens] of chainAddresses) {
    const ourChain = GT_CHAIN_REVERSE[gtChain] ?? gtChain;
    for (const { address, stablecoinId } of tokens) {
      allTokens.push({ gtChain, ourChain, address, stablecoinId });
    }
  }
  // Fisher-Yates shuffle
  for (let i = allTokens.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allTokens[i], allTokens[j]] = [allTokens[j], allTokens[i]];
  }

  for (const { gtChain, ourChain, address, stablecoinId } of allTokens) {
    // Time budget check — stop crawling to leave time for scoring + DB writes
    if (Date.now() - startMs > GT_CRAWL_BUDGET_MS) {
      console.log(
        `[dex-liquidity] GT pool crawl time budget exhausted after ${stats.requests}/${allTokens.length} requests ` +
        `(${Math.round((Date.now() - startMs) / 1000)}s), yielding partial results`
      );
      return { newPools, priceObs, stats };
    }

    if (stats.requests > 0) {
      await new Promise((r) => setTimeout(r, GT_RATE_LIMIT_MS));
    }
    stats.requests++;

    try {
      // maxRetries=0: single attempt per request to keep wall time predictable.
      // fetchWithRetry's internal 429 handling (5s+ delays) would make total time unbounded.
      const url = `${GT_API_BASE}/networks/${gtChain}/tokens/${address}/pools?page=1`;
      const res = await fetchWithRetry(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      }, 0);
      if (!res?.ok) continue;

        const json = (await res.json()) as { data?: GtPool[] };
        if (!json.data) continue;

        for (const pool of json.data) {
          stats.poolsSeen++;
          const a = pool.attributes;
          const dexId = pool.relationships.dex.data.id;
          const poolAddr = a.address.toLowerCase();
          const tvl = parseFloat(a.reserve_in_usd ?? "");
          if (!tvl || tvl < 10_000 || tvl > 1e12) continue; // Skip dust and corrupt values
          if (BLOCKED_DEX_IDS.has(dexId)) continue;

          // Rule 1: Skip Curve pools entirely
          if (dexId.startsWith("curve")) {
            stats.poolsSkippedCurve++;
            continue;
          }

          // Resolve which token in this pool is our stablecoin
          // GT pool relationship IDs are formatted as "{network}_{address}"
          const baseAddr = pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "";
          const quoteAddr = pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "";
          let isBase = baseAddr === address;
          let isQuote = quoteAddr === address;
          if (!isBase && !isQuote) {
            // Neither token matches directly — try addressToId fallback
            const baseId = addressToId.get(baseAddr);
            const quoteId = addressToId.get(quoteAddr);
            if (baseId === stablecoinId) isBase = true;
            else if (quoteId === stablecoinId) isQuote = true;
            else continue;
          }

          // Extract price for our stablecoin (use the side we resolved)
          const priceStr = isBase ? a.base_token_price_usd : a.quote_token_price_usd;
          const price = parseFloat(priceStr ?? "");

          // Price observation (from ALL non-Curve pools, even known ones)
          if (price >= 0.5 && price <= 2.0 && tvl >= 50_000) {
            const obs = priceObs.get(stablecoinId) ?? [];
            obs.push({ price, tvl, chain: ourChain, protocol: dexId });
            priceObs.set(stablecoinId, obs);
          }

          // Rule 2: Skip TVL/volume for known pools
          const poolKey = `${ourChain}:${poolAddr}`;
          if (knownPoolAddrs.has(poolKey)) {
            stats.poolsSkippedKnown++;
            continue;
          }

          // Rule 3: New pool — add with GT quality
          const vol24h = parseFloat(a.volume_usd?.h24 ?? "0");

          // Sanity check: volume/TVL ratio > 50x is garbage data
          // (legit concentrated AMMs like Maverick hit 15-25x)
          if (tvl > 0 && vol24h / tvl > 50) {
            stats.poolsSkippedRatio++;
            continue;
          }

          const qualMult = getGtDexQuality(dexId);

          let maturityDays = 0;
          if (a.pool_created_at) {
            const createdSec = new Date(a.pool_created_at).getTime() / 1000;
            if (createdSec > 0) {
              maturityDays = Math.floor((nowSec - createdSec) / 86400);
            }
          }

          // Classify pool type for display
          const poolType = dexId.includes("v3") || dexId.includes("v4")
            ? "concentrated" : dexId.includes("stable") ? "stable-amm" : "amm";

          const pools = newPools.get(stablecoinId) ?? [];
          pools.push({
            address: poolAddr,
            chain: ourChain,
            dexId,
            name: a.name,
            tvlUsd: tvl,
            volume24hUsd: vol24h,
            qualityMultiplier: qualMult,
            maturityDays,
            poolType: `gt-${poolType}`,
            price,
            symbol: a.name, // GT pool name is like "USDC / USDT"
          });
          newPools.set(stablecoinId, pools);
          stats.poolsNew++;
        }
      } catch (err) {
        console.warn(`[dex-liquidity] GT pool crawl error for ${ourChain}:${address}:`, err);
      }
  }

  console.log(
    `[dex-liquidity] GT pool crawl: ${stats.requests}/${allTokens.length} requests, ${stats.poolsSeen} pools seen, ` +
    `${stats.poolsNew} new, ${stats.poolsSkippedCurve} skipped (Curve), ${stats.poolsSkippedKnown} skipped (known), ${stats.poolsSkippedRatio} skipped (vol/TVL ratio)`
  );
  return { newPools, priceObs, stats };
}

/** Merge GT-discovered new pools into existing LiquidityMetrics. */
function mergeGtPools(
  metrics: Map<string, LiquidityMetrics>,
  gtNewPools: Map<string, GtNewPool[]>,
): void {
  let merged = 0;

  for (const [stablecoinId, pools] of gtNewPools) {
    const meta = TRACKED_STABLECOINS.find((s) => s.id === stablecoinId);
    if (!meta) continue;

    let m = metrics.get(stablecoinId);
    if (!m) {
      m = initMetrics(stablecoinId, meta.symbol);
      metrics.set(stablecoinId, m);
    }

    for (const pool of pools) {
      const organicFraction = 0.5; // neutral default for GT pools
      const balanceRatio = 1.0;    // no balance data from GT
      // Note: GT pools intentionally excluded from balanceRatioWeightedSum and
      // organicTvlWeightedSum to avoid diluting those signals with neutral defaults.
      // Only Curve (balance) and DeFiLlama-APY (organic) pools contribute real data.
      const coinPairQuality = computePoolPairQuality(
        pool.symbol.split(/\s*\/\s*/).map((s) => s.trim()),
        meta.symbol,
      );
      const combinedQuality = pool.qualityMultiplier * coinPairQuality;
      const poolEffTvl = pool.tvlUsd * combinedQuality;
      const stressIdx = computePoolStress(balanceRatio, organicFraction, pool.maturityDays, coinPairQuality);

      m.totalTvlUsd += pool.tvlUsd;
      m.totalVolume24hUsd += pool.volume24hUsd;
      m.poolCount++;
      m.chains.add(pool.chain);
      m.pairs.add(pool.symbol);
      m.qualityAdjustedTvl += pool.tvlUsd * pool.qualityMultiplier;
      m.effectiveTvl += poolEffTvl;
      m.stressWeightedSum += pool.tvlUsd * stressIdx;
      m.oldestPoolDays = Math.max(m.oldestPoolDays, pool.maturityDays);

      // Protocol and chain TVL (use same normalizer as processPoolMetrics)
      const protocol = normalizeProtocol(pool.dexId);
      m.protocolTvl[protocol] = (m.protocolTvl[protocol] ?? 0) + pool.tvlUsd;
      m.chainTvl[pool.chain] = (m.chainTvl[pool.chain] ?? 0) + pool.tvlUsd;

      // Add to top pools
      m.topPools.push({
        project: pool.dexId,
        chain: pool.chain,
        tvlUsd: pool.tvlUsd,
        symbol: pool.symbol,
        volumeUsd1d: pool.volume24hUsd,
        poolType: pool.poolType,
        extra: {
          effectiveTvl: Math.round(poolEffTvl),
          organicFraction,
          pairQuality: Math.round(coinPairQuality * 100) / 100,
          stressIndex: stressIdx,
          maturityDays: pool.maturityDays,
        },
      });

      merged++;
    }
  }

  if (merged > 0) {
    console.log(`[dex-liquidity] Merged ${merged} GT pools into ${gtNewPools.size} stablecoins`);
  }
}

/** Match DeFiLlama pools to tracked stablecoins and compute per-pool metrics. */
function processPoolMetrics(
  pools: LlamaPool[],
  dexProjects: Set<string>,
  symbolToIds: Map<string, string[]>,
  addressToId: Map<string, string>,
  curvePoolMap: Map<string, CurvePoolEntry>,
  uniV3PoolFees: Map<string, number>,
  uniV3SymbolFees: Map<string, number>,
  aerodromeIsStable: Map<string, boolean>,
): Map<string, LiquidityMetrics> {
  const metrics = new Map<string, LiquidityMetrics>();

  for (const pool of pools) {
    if (!pool.tvlUsd || pool.tvlUsd < 10_000 || pool.tvlUsd > 1e12) continue; // Skip dust and corrupt values
    if (!dexProjects.has(pool.project)) continue; // Only count DEX pools
    if (BLOCKED_DEX_IDS.has(pool.project)) continue; // Skip explicitly blocked dead DEXes
    // v2: skip lending pools (single-asset exposure, not DEX liquidity)
    if (pool.exposure === "single") continue;

    // Parse pool symbol into constituent tokens
    const poolSymbols = parsePoolSymbols(pool.symbol);
    const matchedIds = new Set<string>();

    // Step 1: Address-based matching from underlyingTokens (most reliable)
    if (pool.underlyingTokens?.length) {
      for (const addr of pool.underlyingTokens) {
        const id = addressToId.get(addr.toLowerCase());
        if (id) matchedIds.add(id);
      }
      // Learn addresses for unambiguous symbols (enrich addressToId for future pools)
      if (poolSymbols.length === pool.underlyingTokens.length) {
        // 1:1 correspondence possible — learn from unambiguous symbols
        for (let ti = 0; ti < poolSymbols.length; ti++) {
          const sym = poolSymbols[ti].toUpperCase();
          const ids = symbolToIds.get(sym);
          if (ids?.length === 1) {
            addressToId.set(pool.underlyingTokens[ti].toLowerCase(), ids[0]);
          }
        }
      }
    }

    // Step 2: Symbol-based fallback (with collision avoidance)
    for (const sym of poolSymbols) {
      const symKey = sym.toUpperCase();
      const ids = symbolToIds.get(symKey);
      if (!ids) continue;
      if (ids.length === 1) {
        // Unambiguous symbol → always safe to add
        matchedIds.add(ids[0]);
      } else {
        // Colliding symbol → only keep IDs already confirmed by address match
        // (if no address resolved any of these IDs, this symbol is skipped entirely)
      }
    }

    if (matchedIds.size === 0) continue;

    const poolType = classifyPoolType(pool.project);
    const protocol = normalizeProtocol(pool.project);
    const vol1d = pool.volumeUsd1d ?? 0;
    const vol7d = pool.volumeUsd7d ?? 0;

    // Try to find Curve enrichment data (address-based first, symbol-combo fallback)
    const chainNorm = pool.chain.toLowerCase();
    const curveData = curvePoolMap.get(`${chainNorm}:${pool.pool.toLowerCase()}`)
      ?? curvePoolMap.get(`${chainNorm}:${poolSymbols.map((s) => s.toUpperCase()).sort().join("-")}`);

    // --- v2: Enhanced quality resolution ---
    let qualMult: number;
    let resolvedPoolType = poolType;
    let feeTierForExtra: number | undefined;
    let balanceRatio = 1;
    let balanceHealth = 1;
    let poolMaturityDays = 0;
    let organicFraction = 0.5; // neutral default
    let effectivePoolTvl = pool.tvlUsd;
    let balanceDetails: { symbol: string; balancePct: number; isTracked: boolean }[] | undefined;

    if (curveData) {
      balanceRatio = curveData.balanceRatio;
      balanceHealth = Math.pow(balanceRatio, 1.5);
      balanceDetails = curveData.balanceDetails;
      // v2: CryptoSwap vs StableSwap
      if (isCryptoSwap(curveData.registryId)) {
        resolvedPoolType = "curve-cryptoswap";
        qualMult = QUALITY_MULTIPLIERS["curve-cryptoswap"]!;
      } else {
        resolvedPoolType = curveData.A >= 500 ? "curve-stableswap-high-a" : "curve-stableswap";
        qualMult = getQualityMultiplier(resolvedPoolType, curveData.A);
      }
      // Use metapool-adjusted TVL for effective calculation
      effectivePoolTvl = curveData.metapoolAdjustedTvl;
      // Pool maturity from Curve creation timestamp
      if (curveData.creationTs > 0) {
        poolMaturityDays = Math.floor((Date.now() / 1000 - curveData.creationTs) / 86400);
      }
    } else if (poolType === "uniswap-v3-5bp" && uniV3PoolFees.size > 0) {
      // Try to resolve exact fee tier from subgraph data
      const addrKey = `${chainNorm}:${pool.pool.toLowerCase()}`;
      let feeTier = uniV3PoolFees.get(addrKey);
      if (feeTier == null) {
        const symKey = `${chainNorm}:${poolSymbols.map((s) => s.toUpperCase()).sort().join(":")}`;
        feeTier = uniV3SymbolFees.get(symKey);
      }
      if (feeTier != null) {
        feeTierForExtra = feeTier;
        if (feeTier <= 100) resolvedPoolType = "uniswap-v3-1bp";
        else if (feeTier <= 500) resolvedPoolType = "uniswap-v3-5bp";
        else resolvedPoolType = "uniswap-v3-30bp";
      }
      qualMult = getQualityMultiplier(resolvedPoolType);
    } else if (poolType === "aerodrome-volatile" && aerodromeIsStable.size > 0) {
      // Refine Aerodrome pool type using isStable flag from subgraph
      const addrKey = `${chainNorm}:${pool.pool.toLowerCase()}`;
      const isStable = aerodromeIsStable.get(addrKey);
      if (isStable === true) {
        resolvedPoolType = "aerodrome-stable";
      }
      qualMult = getQualityMultiplier(resolvedPoolType);
    } else {
      qualMult = getQualityMultiplier(poolType);
    }

    // Organic fraction from DeFiLlama APY data
    if (pool.apyBase != null && pool.apy > 0.01) {
      organicFraction = Math.min(1, Math.max(0, pool.apyBase / pool.apy));
    } else if (pool.apyBase != null) {
      organicFraction = pool.apyBase > 0 ? 1.0 : 0;
    }

    // Pool maturity from DeFiLlama count (fallback for non-Curve)
    if (poolMaturityDays === 0 && pool.count > 0) {
      poolMaturityDays = pool.count; // ~1 data point per day
    }

    for (const id of matchedIds) {
      const meta = TRACKED_STABLECOINS.find((s) => s.id === id);
      if (!meta) continue;

      let m = metrics.get(id);
      if (!m) {
        m = initMetrics(id, meta.symbol);
        metrics.set(id, m);
      }

      // Per-stablecoin pair quality
      const coinPairQuality = computePoolPairQuality(poolSymbols, meta.symbol);

      // Combined pool quality (mechanism × balance × pair)
      const combinedQuality = qualMult * balanceHealth * coinPairQuality;
      const poolEffTvl = effectivePoolTvl * combinedQuality;

      // Pool stress for this pool
      const stressIdx = computePoolStress(balanceRatio, organicFraction, poolMaturityDays, coinPairQuality);

      m.totalTvlUsd += pool.tvlUsd;
      m.totalVolume24hUsd += vol1d;
      m.totalVolume7dUsd += vol7d;
      m.poolCount++;
      m.chains.add(pool.chain);
      m.pairs.add(pool.symbol);
      m.qualityAdjustedTvl += pool.tvlUsd * qualMult * balanceHealth;
      m.effectiveTvl += poolEffTvl;

      // Weighted balance ratio tracking (Curve pools only)
      if (curveData) {
        m.balanceRatioWeightedSum += pool.tvlUsd * balanceRatio;
        m.totalTvlForBalance += pool.tvlUsd;
      }

      // Weighted organic fraction tracking
      if (pool.apyBase != null) {
        m.organicTvlWeightedSum += pool.tvlUsd * organicFraction;
        m.totalTvlForOrganic += pool.tvlUsd;
      }

      // Stress tracking (TVL-weighted)
      m.stressWeightedSum += pool.tvlUsd * stressIdx;

      // Track oldest pool
      m.oldestPoolDays = Math.max(m.oldestPoolDays, poolMaturityDays);

      // Protocol and chain TVL
      m.protocolTvl[protocol] = (m.protocolTvl[protocol] ?? 0) + pool.tvlUsd;
      m.chainTvl[pool.chain] = (m.chainTvl[pool.chain] ?? 0) + pool.tvlUsd;

      // Pool entry with enriched extra
      m.topPools.push({
        project: pool.project,
        chain: pool.chain,
        tvlUsd: pool.tvlUsd,
        symbol: pool.symbol,
        volumeUsd1d: vol1d,
        poolType: resolvedPoolType,
        extra: {
          ...(curveData
            ? {
                amplificationCoefficient: curveData.A,
                balanceRatio: Math.round(balanceRatio * 100) / 100,
                registryId: curveData.registryId,
                isMetaPool: curveData.isMetaPool,
                balanceDetails,
              }
            : feeTierForExtra != null
              ? { feeTier: feeTierForExtra }
              : {}),
          effectiveTvl: Math.round(poolEffTvl),
          organicFraction: Math.round(organicFraction * 100) / 100,
          pairQuality: Math.round(coinPairQuality * 100) / 100,
          stressIndex: stressIdx,
          maturityDays: poolMaturityDays,
        },
      });
    }
  }

  console.log(`[dex-liquidity] Matched ${metrics.size} stablecoins with DEX liquidity`);
  return metrics;
}

/** Compute HHI, durability, and 6-component composite score per stablecoin. */
async function computeStablecoinScores(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
): Promise<Map<string, ScoreResult & { hhi: number; durability: number; components: ScoreComponents; weightedBalanceRatio: number | null; organicFrac: number | null; avgStress: number | null; lockedLiqPct: number | null }>> {
  // Pre-fetch depth stability for durability computation
  const stabilityMap = new Map<string, number>();
  try {
    const stabRows = await db
      .prepare("SELECT stablecoin_id, depth_stability FROM dex_liquidity WHERE depth_stability IS NOT NULL")
      .all<{ stablecoin_id: string; depth_stability: number }>();
    for (const row of stabRows.results ?? []) {
      stabilityMap.set(row.stablecoin_id, row.depth_stability);
    }
  } catch { /* first run has no data */ }

  // Pre-fetch volume history for volume consistency (CV of 30-day volumes)
  const volumeStabilityMap = new Map<string, number>();
  try {
    const todayMidnightForVol = Math.floor(Date.now() / 86_400_000) * 86_400;
    const thirtyDaysAgoVol = todayMidnightForVol - 30 * 86_400;
    const volRows = await db
      .prepare(
        `SELECT stablecoin_id, total_volume_24h_usd
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?
         ORDER BY stablecoin_id, snapshot_date`
      )
      .bind(thirtyDaysAgoVol)
      .all<{ stablecoin_id: string; total_volume_24h_usd: number }>();
    const volByCoin = new Map<string, number[]>();
    for (const row of volRows.results ?? []) {
      const arr = volByCoin.get(row.stablecoin_id) ?? [];
      arr.push(row.total_volume_24h_usd);
      volByCoin.set(row.stablecoin_id, arr);
    }
    for (const [coinId, vols] of volByCoin) {
      if (vols.length < 7) continue;
      const mean = vols.reduce((s, v) => s + v, 0) / vols.length;
      if (mean <= 0) continue;
      const variance = vols.reduce((s, v) => s + (v - mean) ** 2, 0) / vols.length;
      const cv = Math.sqrt(variance) / mean;
      volumeStabilityMap.set(coinId, Math.round((1 - Math.min(1, cv)) * 10000) / 10000);
    }
  } catch { /* first run has no data */ }

  const results = new Map<string, ScoreResult & { hhi: number; durability: number; components: ScoreComponents; weightedBalanceRatio: number | null; organicFrac: number | null; avgStress: number | null; lockedLiqPct: number | null }>();

  for (const [id, m] of metrics) {
    // Filter pools with absurd volume/TVL ratios (e.g. $183M vol on $52K TVL)
    // before sorting — bad data from any source (DL, GT) gets dropped.
    // 50x is generous: legit concentrated AMMs (Maverick, Uni V4) hit 15-25x.
    m.topPools = m.topPools.filter((p) => {
      const vol = p.volumeUsd1d || 0;
      return p.tvlUsd <= 0 || vol / p.tvlUsd <= 50;
    });

    // Sort and trim top pools to 10 BEFORE HHI so stored HHI matches displayed pools
    m.topPools.sort((a, b) => (b.volumeUsd1d || 0) - (a.volumeUsd1d || 0) || b.tvlUsd - a.tvlUsd);
    m.topPools.length = Math.min(m.topPools.length, 10);

    // Compute HHI from visible (truncated) pools
    let hhi = 0;
    const visibleTvl = m.topPools.reduce((s, p) => s + p.tvlUsd, 0);
    if (visibleTvl > 0) {
      for (const p of m.topPools) {
        const share = p.tvlUsd / visibleTvl;
        hhi += share * share;
      }
    }

    // v2: Compute durability score
    const tvlStab = stabilityMap.get(id) ?? null;
    const volStab = volumeStabilityMap.get(id) ?? null;
    const durability = computeDurabilityScore(m, tvlStab, volStab);

    // v2: Compute 6-component score
    const { score, components } = computeLiquidityScore(m, durability);

    // v2: Compute aggregate metrics
    const weightedBalanceRatio = m.totalTvlForBalance > 0
      ? Math.round((m.balanceRatioWeightedSum / m.totalTvlForBalance) * 10000) / 10000
      : null;
    const organicFrac = m.totalTvlForOrganic > 0
      ? Math.round((m.organicTvlWeightedSum / m.totalTvlForOrganic) * 10000) / 10000
      : null;
    const avgStress = m.totalTvlUsd > 0
      ? Math.round((m.stressWeightedSum / m.totalTvlUsd) * 100) / 100
      : null;
    const lockedLiqPct = m.totalTvlForLocked > 0
      ? Math.round((m.lockedLiqWeightedSum / m.totalTvlForLocked) * 10000) / 10000
      : null;

    results.set(id, {
      tvl: m.totalTvlUsd,
      vol24h: m.totalVolume24hUsd,
      score,
      hhi: Math.round(hhi * 10000) / 10000,
      durability,
      components,
      weightedBalanceRatio,
      organicFrac,
      avgStress,
      lockedLiqPct,
    });
  }

  return results;
}

/** Persist liquidity scores to D1 (both data rows and zero-score rows). */
async function persistScores(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  scoreResults: Map<string, ScoreResult & { hhi: number; durability: number; components: ScoreComponents; weightedBalanceRatio: number | null; organicFrac: number | null; avgStress: number | null; lockedLiqPct: number | null }>,
  nowSec: number,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  for (const [id, m] of metrics) {
    const sr = scoreResults.get(id);
    if (!sr) continue;

    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO dex_liquidity
            (stablecoin_id, symbol, total_tvl_usd, total_volume_24h_usd, total_volume_7d_usd,
             pool_count, pair_count, chain_count, protocol_tvl_json, chain_tvl_json,
             top_pools_json, liquidity_score, concentration_hhi,
             avg_pool_stress, weighted_balance_ratio, organic_fraction,
             effective_tvl_usd, durability_score, score_components_json,
             locked_liquidity_pct, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          m.symbol,
          m.totalTvlUsd,
          m.totalVolume24hUsd,
          m.totalVolume7dUsd,
          m.poolCount,
          m.pairs.size,
          m.chains.size,
          JSON.stringify(m.protocolTvl),
          JSON.stringify(m.chainTvl),
          JSON.stringify(m.topPools),
          sr.score,
          sr.hhi,
          sr.avgStress,
          sr.weightedBalanceRatio,
          sr.organicFrac,
          Math.round(m.effectiveTvl),
          sr.durability,
          JSON.stringify(sr.components),
          sr.lockedLiqPct,
          nowSec,
        ),
    );
  }

  // Write zero-score rows for tracked stablecoins with no DEX presence
  for (const meta of TRACKED_STABLECOINS) {
    if (!metrics.has(meta.id)) {
      stmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO dex_liquidity
              (stablecoin_id, symbol, total_tvl_usd, total_volume_24h_usd, total_volume_7d_usd,
               pool_count, pair_count, chain_count, protocol_tvl_json, chain_tvl_json,
               top_pools_json, liquidity_score, effective_tvl_usd, updated_at)
            VALUES (?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, 0, 0, ?)`
          )
          .bind(meta.id, meta.symbol, nowSec),
      );
    }
  }

  // D1 batch limit — chunk
  await batchExecute(db, stmts);

  console.log(`[dex-liquidity] Wrote ${stmts.length} rows (${metrics.size} with data, ${stmts.length - metrics.size} zero)`);
}

/** Write daily snapshot rows (first sync invocation after UTC midnight). */
async function writeHistoricalSnapshots(
  db: D1Database,
  scoreMap: Map<string, ScoreResult>,
): Promise<void> {
  const todayMidnight = Math.floor(Date.now() / 86_400_000) * 86_400; // epoch seconds at UTC midnight
  try {
    const lastSnap = await db
      .prepare("SELECT MAX(snapshot_date) as last_date FROM dex_liquidity_history")
      .first<{ last_date: number | null }>();

    if (!lastSnap?.last_date || lastSnap.last_date < todayMidnight) {
      const snapStmts: D1PreparedStatement[] = [];
      for (const [id, data] of scoreMap) {
        snapStmts.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO dex_liquidity_history
                (stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date)
              VALUES (?, ?, ?, ?, ?)`
            )
            .bind(id, data.tvl, data.vol24h, data.score, todayMidnight)
        );
      }
      // Also insert zero rows for coins without DEX presence
      for (const meta of TRACKED_STABLECOINS) {
        if (!scoreMap.has(meta.id)) {
          snapStmts.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO dex_liquidity_history
                  (stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date)
                VALUES (?, 0, 0, 0, ?)`
              )
              .bind(meta.id, todayMidnight)
          );
        }
      }
      await batchExecute(db, snapStmts);
      console.log(`[dex-liquidity] Wrote daily snapshot (${snapStmts.length} rows) for ${new Date(todayMidnight * 1000).toISOString().slice(0, 10)}`);
    }
  } catch (err) {
    console.warn("[dex-liquidity] Daily snapshot failed:", err);
  }
}

/** Compute depth stability (CV-based) from 30-day history and persist to D1. */
async function computeDepthStability(db: D1Database): Promise<void> {
  const todayMidnight = Math.floor(Date.now() / 86_400_000) * 86_400;
  try {
    const thirtyDaysAgo = todayMidnight - 30 * 86_400;
    const histRows = await db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?
         ORDER BY stablecoin_id, snapshot_date`
      )
      .bind(thirtyDaysAgo)
      .all<{ stablecoin_id: string; total_tvl_usd: number }>();

    // Group by stablecoin
    const histByCoin = new Map<string, number[]>();
    for (const row of histRows.results ?? []) {
      const arr = histByCoin.get(row.stablecoin_id) ?? [];
      arr.push(row.total_tvl_usd);
      histByCoin.set(row.stablecoin_id, arr);
    }

    const stabilityStmts: D1PreparedStatement[] = [];
    for (const [id, tvls] of histByCoin) {
      if (tvls.length < 7) continue; // Need at least 7 days for meaningful stability
      const mean = tvls.reduce((s, v) => s + v, 0) / tvls.length;
      if (mean <= 0) continue;
      const variance = tvls.reduce((s, v) => s + (v - mean) ** 2, 0) / tvls.length;
      const stddev = Math.sqrt(variance);
      const cv = stddev / mean;
      const stability = Math.round((1 - Math.min(1, cv)) * 10000) / 10000;
      stabilityStmts.push(
        db.prepare("UPDATE dex_liquidity SET depth_stability = ? WHERE stablecoin_id = ?").bind(stability, id)
      );
    }
    if (stabilityStmts.length > 0) {
      await batchExecute(db, stabilityStmts);
      console.log(`[dex-liquidity] Updated depth stability for ${stabilityStmts.length} coins`);
    }
  } catch (err) {
    console.warn("[dex-liquidity] Depth stability computation failed:", err);
  }
}

/** Compute DEX-implied prices from all observations (TVL-weighted median) and persist to dex_prices. */
async function computeDexPrices(
  db: D1Database,
  priceObservations: Map<string, DexPriceObs[]>,
  nowSec: number,
): Promise<void> {
  try {
    if (priceObservations.size === 0) return;

    // Load primary prices from stablecoins cache for comparison
    const primaryPrices = new Map<string, number>();
    const cached = await getCache(db, "stablecoins");
    if (cached) {
      try {
        const { peggedAssets } = JSON.parse(cached.value) as { peggedAssets: { id: string; price?: number | null }[] };
        for (const a of peggedAssets) {
          if (a.price != null && typeof a.price === "number" && a.price > 0) {
            primaryPrices.set(a.id, a.price);
          }
        }
      } catch { /* ignore malformed cache */ }
    }

    const priceStmts: D1PreparedStatement[] = [];
    for (const [id, observations] of priceObservations) {
      if (observations.length === 0) continue;

      // TVL-weighted median: sort by price, walk until cumulative TVL crosses 50%
      observations.sort((a, b) => a.price - b.price);
      const totalTvl = observations.reduce((s, o) => s + o.tvl, 0);
      const halfTvl = totalTvl / 2;
      let cumTvl = 0;
      let medianPrice = observations[0].price;
      for (const obs of observations) {
        cumTvl += obs.tvl;
        if (cumTvl >= halfTvl) {
          medianPrice = obs.price;
          break;
        }
      }

      // Compute deviation from primary price
      const primaryPrice = primaryPrices.get(id);
      let deviationBps: number | null = null;
      if (primaryPrice != null && primaryPrice > 0) {
        deviationBps = Math.round(((medianPrice / primaryPrice) - 1) * 10000);
      }

      // Top 5 sources by TVL for transparency (spread to avoid mutating price-sorted array)
      const topSources = [...observations]
        .sort((a, b) => b.tvl - a.tvl)
        .slice(0, 5)
        .map((o) => ({ protocol: o.protocol, chain: o.chain, price: o.price, tvl: o.tvl }));

      const meta = TRACKED_STABLECOINS.find((s) => s.id === id);
      const symbol = meta?.symbol ?? id;

      priceStmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO dex_prices
              (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
               deviation_from_primary_bps, primary_price_at_calc, price_sources_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            symbol,
            Math.round(medianPrice * 1e6) / 1e6, // 6 decimal places
            observations.length,
            Math.round(totalTvl),
            deviationBps,
            primaryPrice ?? null,
            JSON.stringify(topSources),
            nowSec
          )
      );
    }

    if (priceStmts.length > 0) {
      await batchExecute(db, priceStmts);
      console.log(`[dex-liquidity] Wrote ${priceStmts.length} DEX price observations to dex_prices`);
    }
  } catch (err) {
    console.warn("[dex-liquidity] DEX price extraction failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function syncDexLiquidity(db: D1Database, graphApiKey: string | null, cgApiKey: string | null = null): Promise<void> {
  initOnchainAvailability(cgApiKey ?? undefined);
  const useCg = isOnchainAvailable();
  console.log(`[dex-liquidity] Starting sync`);
  console.log(`[dex-liquidity] Pool discovery source: ${useCg ? "CoinGecko onchain" : "GeckoTerminal fallback"}`);

  // 1. Fetch all external data sources
  const dataSources = await fetchDataSources(graphApiKey);
  if (!dataSources) return;

  // 2. Build symbol/address lookup maps
  const { symbolToIds, addressToId } = buildSymbolLookups();

  // 3. Parse Curve data into pool lookups and price observations
  const { curvePoolMap, priceObservations } = await buildCurveLookups(
    dataSources.curveResponses, symbolToIds, addressToId,
  );

  // 4. Fetch Uniswap V3 subgraph data for fee tier enrichment + price observations
  const { uniV3PoolFees, uniV3SymbolFees, uniV3PriceObs } = await fetchUniV3Data(
    graphApiKey, symbolToIds, addressToId,
  );
  if (addressToId.size > 0) {
    console.log(`[dex-liquidity] Learned ${addressToId.size} token addresses for disambiguation`);
  }

  // 4b. Fetch Aerodrome subgraph data for price observations + pool stability flags
  let aerodromePriceObs = new Map<string, DexPriceObs[]>();
  let aerodromeIsStable = new Map<string, boolean>();
  try {
    const aeroData = await fetchAerodromeData(graphApiKey, symbolToIds, addressToId);
    aerodromePriceObs = aeroData.aerodromePriceObs;
    aerodromeIsStable = aeroData.aerodromeIsStable;
  } catch (err) {
    console.warn("[dex-liquidity] Aerodrome fetch failed (non-fatal):", err);
  }

  // 4c. Build known pool address set from existing sources (for GT dedup)
  const knownPoolAddrs = buildKnownPoolAddresses(
    dataSources.pools, dataSources.dexProjects,
    curvePoolMap, uniV3PoolFees, aerodromeIsStable,
  );

  // 4d. Token-level batch price observations (CG or GT)
  let fallbackTokenPriceObs = new Map<string, DexPriceObs[]>();
  try {
    fallbackTokenPriceObs = useCg
      ? await fetchCgTokenBatchPrices(addressToId)
      : await fetchGtTokenBatch(addressToId);
  } catch (err) {
    console.warn(`[dex-liquidity] ${useCg ? "CG" : "GT"} token batch failed (non-fatal):`, err);
  }

  // 4e. Pool crawl for new pool discovery (CG or GT)
  let crawlNewPools: Map<string, CgNewPool[]> | Map<string, GtNewPool[]> = new Map();
  let crawlPriceObs = new Map<string, DexPriceObs[]>();
  try {
    if (useCg) {
      const cgResult = await fetchCgPools(addressToId, knownPoolAddrs);
      crawlNewPools = cgResult.newPools;
      crawlPriceObs = cgResult.priceObs;
    } else {
      const gtResult = await fetchGtPools(addressToId, knownPoolAddrs);
      crawlNewPools = gtResult.newPools;
      crawlPriceObs = gtResult.priceObs;
    }
  } catch (err) {
    console.warn(`[dex-liquidity] ${useCg ? "CG" : "GT"} pool crawl failed (non-fatal):`, err);
  }

  // Merge all price observations into a single map
  for (const [id, obs] of uniV3PriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  for (const [id, obs] of aerodromePriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  for (const [id, obs] of fallbackTokenPriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  for (const [id, obs] of crawlPriceObs) {
    const existing = priceObservations.get(id) ?? [];
    existing.push(...obs);
    priceObservations.set(id, existing);
  }
  console.log(`[dex-liquidity] Total: ${priceObservations.size} coins with price observations across all sources`);

  // 5. Match pools to stablecoins and compute per-pool metrics
  const metrics = processPoolMetrics(
    dataSources.pools, dataSources.dexProjects, symbolToIds, addressToId,
    curvePoolMap, uniV3PoolFees, uniV3SymbolFees, aerodromeIsStable,
  );

  // 5b. Merge discovered pools into metrics (CG or GT)
  if (useCg) {
    mergeCgPools(metrics, crawlNewPools as Map<string, CgNewPool[]>);
  } else {
    mergeGtPools(metrics, crawlNewPools as Map<string, GtNewPool[]>);
  }

  // 6. Compute composite scores per stablecoin
  const scoreResults = await computeStablecoinScores(db, metrics);

  // 7. Persist scores to D1
  const nowSec = Math.floor(Date.now() / 1000);
  await persistScores(db, metrics, scoreResults, nowSec);

  // 8. Write daily historical snapshots
  await writeHistoricalSnapshots(db, scoreResults);

  // 9. Compute and persist depth stability from 30-day history
  await computeDepthStability(db);

  // 10. Compute and persist DEX-implied prices from ALL observations
  await computeDexPrices(db, priceObservations, nowSec);
}
