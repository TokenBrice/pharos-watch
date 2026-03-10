export interface LlamaPool {
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

export interface CurvePool {
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

export interface LiquidityMetrics {
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

export type LiquidityPoolSourceFamily =
  | "dl"
  | "cg_onchain"
  | "gecko_terminal"
  | "dexscreener"
  | "cg_tickers";

export type LiquidityCoverageClass =
  | "primary"
  | "mixed"
  | "fallback"
  | "legacy"
  | "unobserved";

export interface LiquiditySourceMixEntry {
  poolCount: number;
  tvlUsd: number;
}

export type LiquiditySourceMix = Partial<Record<LiquidityPoolSourceFamily, LiquiditySourceMixEntry>>;

export interface PoolEntry {
  poolId: string;
  project: string;
  chain: string;
  tvlUsd: number;
  symbol: string;
  volumeUsd1d: number;
  volumeUsd7d?: number | null;
  poolType: string;
  /** Canonical source family for coverage-confidence accounting and UI attribution. */
  source: LiquidityPoolSourceFamily;
  extra?: {
    amplificationCoefficient?: number;
    balanceRatio?: number;
    feeTier?: number;
    qualityAdjustedTvl?: number;
    effectiveTvl?: number;
    organicFraction?: number;
    hasMeasuredOrganicFraction?: boolean;
    pairQuality?: number;
    stressIndex?: number;
    isMetaPool?: boolean;
    maturityDays?: number;
    registryId?: string;
    lockedLiquidityPct?: number | null;
    balanceDetails?: {
      symbol: string;
      balancePct: number;
      isTracked: boolean;
    }[];
  };
}

export interface DexPriceObs {
  price: number;
  tvl: number;
  chain: string;
  protocol: string;
}

// GeckoTerminal response types
export interface GtPoolAttributes {
  address: string;
  name: string;
  pool_created_at: string | null;
  base_token_price_usd: string | null;
  quote_token_price_usd: string | null;
  reserve_in_usd: string | null;
  volume_usd: { h24: string | null } | null;
}

export interface GtPool {
  id: string;
  type: string;
  attributes: GtPoolAttributes;
  relationships: {
    base_token: { data: { id: string; type: string } };
    quote_token: { data: { id: string; type: string } };
    dex: { data: { id: string; type: string } };
  };
}

export interface GtTokenAttributes {
  address: string;
  name: string;
  symbol: string;
  coingecko_coin_id: string | null;
  price_usd: string | null;
  total_reserve_in_usd: string | null;
  volume_usd: { h24: string | null } | null;
}

export interface GtToken {
  id: string;
  type: string;
  attributes: GtTokenAttributes;
}

export interface ScoreComponents {
  tvlDepth: number;
  volumeActivity: number;
  poolQuality: number;
  durability: number;
  pairDiversity: number;
}

export interface CurvePoolEntry {
  A: number;
  balanceRatio: number;
  tvl: number;
  registryId: string;
  isMetaPool: boolean;
  metapoolAdjustedTvl: number;
  creationTs: number;
  balanceDetails: { symbol: string; balancePct: number; isTracked: boolean }[];
}

export interface SymbolLookups {
  symbolToIds: Map<string, string[]>;
  addressToId: Map<string, string>;
}

export interface DataSources {
  pools: LlamaPool[];
  dexProjects: Set<string>;
  /** DL protocol slug → total protocol TVL. Used to cap inflated CG/GT per-pool TVL. */
  protocolTvlCaps: Map<string, number>;
  curveResponses: (Response | null)[];
  graphApiKey: string | null;
  dlYieldsAvailable: boolean;
  dlProtocolsAvailable: boolean;
}

export interface CurveLookups {
  curvePoolMap: Map<string, CurvePoolEntry>;
  priceObservations: Map<string, DexPriceObs[]>;
}

export interface UniV3Lookups {
  uniV3PoolFees: Map<string, number>;
  uniV3SymbolFees: Map<string, number>;
  uniV3PriceObs: Map<string, DexPriceObs[]>;
}

export interface ScoreResult {
  tvl: number;
  vol24h: number;
  score: number;
}

export interface AerodromeLookups {
  aerodromePriceObs: Map<string, DexPriceObs[]>;
  aerodromeIsStable: Map<string, boolean>; // "chain:poolAddress" → isStable
}

/** Result of GT pool crawl: new pools to merge into metrics + price observations */
export interface GtCrawlResult {
  /** New pools not found in existing sources, keyed by stablecoinId */
  newPools: Map<string, GtNewPool[]>;
  /** Price observations from all non-Curve GT pools */
  priceObs: Map<string, DexPriceObs[]>;
  /** Stats for logging */
  stats: { requests: number; poolsSeen: number; poolsNew: number; poolsSkippedCurve: number; poolsSkippedKnown: number };
}

export interface GtNewPool {
  address: string;
  chain: string;
  dexId: string;
  name: string;
  tvlUsd: number;
  volume24hUsd: number;
  qualityMultiplier: number;
  maturityDays: number;
  /** The stablecoin's price in this pool */
  price: number;
  /** Pool symbol (e.g., "USDC / USDT") */
  symbol: string;
  /** Discovery/source-specific pool type used for quality weighting */
  poolType: string;
  /** Canonical source family for later merge attribution. */
  sourceFamily: Exclude<LiquidityPoolSourceFamily, "dl">;
  /** Optional per-pool 7d volume when source provides it */
  volume7dUsd?: number | null;
}

export interface CgNewPool extends GtNewPool {
  /** Balance ratio computed from base/quote token balances (null if unavailable) */
  balanceRatio: number | null;
  /** Locked liquidity percentage (null if unavailable) */
  lockedLiquidityPct: number | null;
  /** Pool fee percentage from CG (null if unavailable) */
  feePercentage: number | null;
}

/** Global deduped aggregate for the __global__ sentinel row. */
export interface GlobalAgg {
  totalTvl: number;
  totalVol24h: number;
  totalVol7d: number;
  poolCount: number;
  chainCount: number;
  protocolTvl: Record<string, number>;
  chainTvl: Record<string, number>;
}

export type FullScoreResult = ScoreResult & {
  hhi: number;
  durability: number;
  components: ScoreComponents;
  weightedBalanceRatio: number | null;
  organicFrac: number | null;
  avgStress: number | null;
  lockedLiqPct: number | null;
  coverageClass: LiquidityCoverageClass;
  coverageConfidence: number;
  sourceMix: LiquiditySourceMix;
  balanceMeasuredTvlUsd: number;
  organicMeasuredTvlUsd: number;
};

export interface CgTicker {
  base: string;
  target: string;
  market: { name: string; identifier: string };
  converted_last: { usd: number };
  converted_volume: { usd: number };
  bid_ask_spread_percentage: number;
  is_anomaly: boolean;
  is_stale: boolean;
  trust_score: string | null;
  target_coin_id?: string;
}
