export interface LlamaPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  poolMeta?: string | null;
  tvlUsd: number;
  volumeUsd1d: number | null;
  volumeUsd7d: number | null;
  stablecoin: boolean;
  underlyingTokens: string[] | null;
  // v2 fields
  apyBase: number | null;
  apyReward: number | null;
  apy: number;
  apyMean30d?: number;
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

import type {
  DexAmmExecutionModel,
  DexExecutionCapabilityGate,
  LiquidityPoolSourceFamily,
  LiquiditySourceMixEntry,
  LiquidityCoverageClass,
} from "@shared/types/market";
import type {
  DexMeasuredExecutionProfile,
  DexMeasuredExecutionPublicProfile,
  DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import type {
  SolanaMeasuredExecutionProfile,
  SolanaMeasuredExecutionPublicProfile,
  SolanaMeasuredExecutionTarget,
} from "@shared/types/solana-measured-execution";
import type {
  TronMeasuredExecutionProfile,
  TronMeasuredExecutionPublicProfile,
  TronMeasuredExecutionTarget,
} from "@shared/types/tron-measured-execution";

export type { LiquidityPoolSourceFamily, LiquiditySourceMixEntry, LiquidityCoverageClass };

export type LiquiditySourceMixByFamily = Partial<Record<LiquidityPoolSourceFamily, LiquiditySourceMixEntry>>;

/** Internal descriptor awaiting same-block factory and reserve verification. */
export interface EvmV2ExecutionCandidate {
  source: "uniswap-v2" | "pancakeswap-v2" | "aerodrome-volatile";
  poolAddress: `0x${string}`;
  tokenAddresses: [`0x${string}`, `0x${string}`];
  tokenSymbols: [string, string];
}

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
  /** DEX-implied price of the tracked stablecoin in this pool (USD). */
  price?: number;
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
    orderbookDepthUsd?: number;
    orderbookDepthUpUsd?: number;
    orderbookTvlBasis?: "volume-derived" | "coingecko-depth-2pct-capped-by-volume";
    balanceDetails?: {
      symbol: string;
      balancePct: number;
      isTracked: boolean;
    }[];
    measurement?: PoolMeasurementFlags;
    /** Reviewed exact-family failure retained for P4 completeness accounting. */
    executionCapabilityGate?: DexExecutionCapabilityGate;
    /** Exact direct-API inputs retained for supported AMM execution simulation. */
    ammExecutionModel?: DexAmmExecutionModel;
    /** Internal V2 candidate; consumed before scoring and never published. */
    evmV2ExecutionCandidate?: EvmV2ExecutionCandidate;
    /** Internal all-retained target descriptor; stripped before top-pool publication. */
    measuredExecutionTarget?: DexMeasuredExecutionTarget;
    /** Proof-free validated capacity/provenance projection retained for P4 and API publication. */
    measuredExecution?: DexMeasuredExecutionPublicProfile;
    /** Internal D1 proof profile; stripped before top-pool publication. */
    measuredExecutionProfile?: DexMeasuredExecutionProfile;
    /** Target-derived physical pool id consumed by P4 before publication. */
    measuredExecutionPhysicalPoolId?: string;
    /** Internal cohort diagnostics retained in cron metadata, not the public pool envelope. */
    measuredExecutionDiagnostic?: {
      adapterProfileId: string;
      targetId?: string;
      detail?: string;
    };
    /** Internal native Solana target; never published. */
    solanaMeasuredExecutionTarget?: SolanaMeasuredExecutionTarget;
    /** Proof-free shadow profile retained for operator/API diagnostics. */
    solanaMeasuredExecution?: SolanaMeasuredExecutionPublicProfile;
    /** Internal native Solana proof profile; never published. */
    solanaMeasuredExecutionProfile?: SolanaMeasuredExecutionProfile;
    /** Internal native physical pool id consumed before publication. */
    solanaMeasuredExecutionPhysicalPoolId?: string;
    /** Internal native adapter diagnostics; never published. */
    solanaMeasuredExecutionDiagnostic?: {
      adapterProfileId: string;
      targetId?: string;
      detail?: string;
    };
    /** Internal native Tron target; never published. */
    tronMeasuredExecutionTarget?: TronMeasuredExecutionTarget;
    /** Proof-free shadow profile retained for operator/API diagnostics. */
    tronMeasuredExecution?: TronMeasuredExecutionPublicProfile;
    /** Internal native Tron proof profile; never published. */
    tronMeasuredExecutionProfile?: TronMeasuredExecutionProfile;
    /** Internal native physical pool id consumed before publication. */
    tronMeasuredExecutionPhysicalPoolId?: string;
    /** Internal native adapter diagnostics; never published. */
    tronMeasuredExecutionDiagnostic?: {
      adapterProfileId: string;
      targetId?: string;
      detail?: string;
    };
  };
}

export interface PoolMeasurementFlags {
  tvlMeasured?: boolean;
  volumeMeasured?: boolean;
  balanceMeasured?: boolean;
  maturityMeasured?: boolean;
  priceMeasured?: boolean;
  synthetic?: boolean;
  decayed?: boolean;
  capped?: boolean;
}

export interface DexPriceObs {
  price: number;
  tvl: number;
  chain: string;
  protocol: string;
  poolKey?: string;
  derivedMatchKey?: string;
  identityConfidence?: "exact" | "derived_unique" | "derived_ambiguous" | "none";
  sourceFamily?: string;
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
  poolAddress?: string;
  apiIsBroken?: boolean;
  A: number;
  balanceRatio: number;
  tvl: number;
  registryId: string;
  isMetaPool: boolean;
  metapoolAdjustedTvl: number;
  creationTs: number;
  balanceDetails: { symbol: string; balancePct: number; isTracked: boolean }[];
  /** Normalized symbol → USD price for each coin in the pool (from Curve API). */
  tokenPrices: Record<string, number>;
  /**
   * Exact per-coin execution inputs for plain (non-meta) stableswap pools:
   * address, decimals, token-unit balance, and the source USD price. Absent
   * when any coin's identity or balance is incomplete or the pool is a
   * metapool, so downstream simulation fails closed instead of guessing.
   */
  executionCoins?: { address: string; symbol: string; decimals: number; balance: number; usdPrice: number }[];
}

export interface SymbolLookups {
  symbolToIds: Map<string, string[]>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  addressToId: Map<string, string>;
  chainAddressToId: Map<string, string>;
  contractMetaByChainAddress: Map<
    string,
    {
      stablecoinId: string;
      symbol: string;
      decimals: number | null;
      source: "contract" | "tradedContract";
    }
  >;
}

export interface DataSources {
  pools: LlamaPool[];
  /** Count before tracked-token compaction. Retained for progress and run metadata. */
  rawPoolCount: number;
  dexProjects: Set<string>;
  /** DL protocol slug → total protocol TVL. Used to cap inflated CG/GT per-pool TVL. */
  protocolTvlCaps: Map<string, number>;
  curvePayloads: (CurveApiPayload | null)[];
  graphApiKey: string | null;
  dlYieldsAvailable: boolean;
  dlProtocolsAvailable: boolean;
}

export interface CurveApiPayload {
  data?: { poolData?: CurvePool[] };
}

export interface CurveLookups {
  curvePoolMap: Map<string, CurvePoolEntry>;
  priceObservations: Map<string, DexPriceObs[]>;
}

export interface UniV3Lookups {
  uniV3PoolFees: Map<string, number>;
  uniV3SymbolFees: Map<string, number>;
  uniV3PriceObs: Map<string, DexPriceObs[]>;
  uniV3ExecutionCandidates: Map<string, import("../measured-execution/candidate-types").UniV3ExecutionCandidate[]>;
}

export interface ScoreResult {
  tvl: number;
  effectiveTvl: number;
  vol24h: number;
  score: number;
}

export interface AerodromeLookups {
  aerodromePriceObs: Map<string, DexPriceObs[]>;
  aerodromeIsStable: Map<string, boolean>; // "chain:poolAddress" → isStable
  aerodromeV2ExecutionCandidates: Map<string, EvmV2ExecutionCandidate>;
}

/** Result of GT pool crawl: new pools to merge into metrics + price observations */
export interface GtCrawlResult {
  /** New pools not found in existing sources, keyed by stablecoinId */
  newPools: Map<string, GtNewPool[]>;
  /** Price observations from fallback pools after native-source overlap guards. */
  priceObs: Map<string, DexPriceObs[]>;
  /** Stats for logging */
  stats: {
    requests: number;
    poolsSeen: number;
    poolsNew: number;
    poolsSkippedCurve: number;
    poolsSkippedKnown: number;
  };
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
  /** Optional measured balance ratio from richer direct/discovery APIs. */
  balanceRatio?: number | null;
  /** Optional normalized fee tier in basis points. */
  feeTierBps?: number | null;
  /** Optional token balance composition details for richer top-pool UI. */
  balanceDetails?: {
    symbol: string;
    balancePct: number;
    isTracked: boolean;
  }[];
  /** Optional pair-quality override for synthetic/non-AMM liquidity families. */
  pairQualityOverride?: number | null;
  /** Measurement/provenance flags for downstream confidence accounting. */
  measurement?: PoolMeasurementFlags;
  /** Exact direct-API inputs retained only for supported AMM invariant families. */
  ammExecutionModel?: DexAmmExecutionModel;
  /** Reviewed exact-family failure retained for P4 completeness accounting. */
  executionCapabilityGate?: DexExecutionCapabilityGate;
  /** Internal V2 candidate; consumed before scoring and never published. */
  evmV2ExecutionCandidate?: EvmV2ExecutionCandidate;
  /** CoinGecko 2% downside orderbook depth when available. */
  orderbookDepthUsd?: number | null;
  /** CoinGecko 2% upside orderbook depth when available. */
  orderbookDepthUpUsd?: number | null;
  /** How synthetic orderbook TVL was derived. */
  orderbookTvlBasis?: "volume-derived" | "coingecko-depth-2pct-capped-by-volume";
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
  sourceMix: LiquiditySourceMixByFamily;
  balanceMeasuredTvlUsd: number;
  organicMeasuredTvlUsd: number;
};

export interface CgTicker {
  base: string;
  target: string;
  market: { name: string; identifier: string };
  converted_last: { usd: number };
  converted_volume: { usd: number };
  cost_to_move_down_usd?: number | null;
  cost_to_move_up_usd?: number | null;
  bid_ask_spread_percentage: number;
  is_anomaly: boolean;
  is_stale: boolean;
  trust_score: string | null;
  target_coin_id?: string;
}
