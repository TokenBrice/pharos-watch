// --- Flag-based classification ---

/** Backing mechanism */
export type BackingType = "rwa-backed" | "crypto-backed" | "algorithmic";

/** Peg currency */
export type PegCurrency = "USD" | "EUR" | "GBP" | "CHF" | "BRL" | "RUB" | "JPY" | "IDR" | "SGD" | "TRY" | "AUD" | "ZAR" | "GOLD" | "SILVER" | "VAR" | "OTHER";

/** Governance model */
export type GovernanceType = "centralized" | "centralized-dependent" | "decentralized";

export interface StablecoinFlags {
  backing: BackingType;
  pegCurrency: PegCurrency;
  governance: GovernanceType;
  yieldBearing: boolean;
  rwa: boolean; // real-world-asset backed (treasuries, bonds, etc.)
  navToken: boolean; // price appreciates over time as yield accrues (not pegged to $1) — exclude from peg deviation metrics
}

export type ProofOfReservesType = "independent-audit" | "real-time" | "self-reported";

export interface ProofOfReserves {
  type: ProofOfReservesType;
  url: string;
  provider?: string;
}

export interface StablecoinLink {
  label: string;
  url: string;
}

export interface Jurisdiction {
  country: string;
  regulator?: string;
  license?: string;
}

export interface ContractDeployment {
  chain: string;      // Chain ID (e.g., "ethereum", "arbitrum", "tron")
  address: string;    // Contract address (0x... for EVM, T... for Tron)
  decimals: number;   // Token decimals
}

/** Configures how on-chain circulating supply is computed for a stablecoin */
export interface SupplyMethodConfig {
  type:
    | "totalSupply"                  // Default: raw totalSupply() is circulating
    | "totalSupply-minus-addresses"  // totalSupply() - sum(balanceOf(addr)) per chain
    | "custom-contract"             // Call a dedicated circulating supply contract
    | "exclude";                    // Skip on-chain supply for this token

  /** For totalSupply-minus-addresses: addresses whose balanceOf() to subtract */
  subtractAddresses?: { chain: string; address: string }[];

  /** For custom-contract: dedicated contract returning circulating supply */
  customContract?: {
    chain: string;     // Chain where the contract lives
    address: string;   // Contract address
    selector: string;  // Function selector (e.g., "0x9e2bf22c")
    decimals: number;  // Decimals for the return value
  };
}

export interface StablecoinMeta {
  id: string; // DefiLlama numeric ID
  name: string;
  symbol: string;
  flags: StablecoinFlags;
  collateral?: string;
  pegMechanism?: string;
  goldOunces?: number; // troy ounces of gold per token (for gold-pegged stablecoins)
  proofOfReserves?: ProofOfReserves;
  links?: StablecoinLink[];
  jurisdiction?: Jurisdiction;
  contracts?: ContractDeployment[];  // On-chain contract deployments per chain
  supplyMethod?: SupplyMethodConfig; // How to compute circulating supply (default: totalSupply)
}

// --- Filter tags (used in the UI to filter the table) ---

export type FilterTag =
  | "usd-peg"
  | "eur-peg"
  | "gold-peg"
  | "chf-peg"
  | "gbp-peg"
  | "brl-peg"
  | "rub-peg"
  | "jpy-peg"
  | "idr-peg"
  | "sgd-peg"
  | "try-peg"
  | "aud-peg"
  | "zar-peg"
  | "silver-peg"
  | "var-peg"
  | "other-peg"
  | "centralized"
  | "centralized-dependent"
  | "decentralized"
  | "rwa-backed"
  | "crypto-backed"
  | "algorithmic"
  | "yield-bearing"
  | "rwa";

/** Tags that fall under the "Other Peg" umbrella filter on the homepage */
export const OTHER_PEG_TAGS: FilterTag[] = ["chf-peg", "gbp-peg", "brl-peg", "rub-peg", "jpy-peg", "idr-peg", "sgd-peg", "try-peg", "aud-peg", "zar-peg", "silver-peg", "var-peg", "other-peg"];

export const FILTER_TAG_LABELS: Record<FilterTag, string> = {
  "usd-peg": "USD Peg",
  "eur-peg": "EUR Peg",
  "gold-peg": "Gold Peg",
  "chf-peg": "CHF Peg",
  "gbp-peg": "GBP Peg",
  "brl-peg": "BRL Peg",
  "rub-peg": "RUB Peg",
  "jpy-peg": "JPY Peg",
  "idr-peg": "IDR Peg",
  "sgd-peg": "SGD Peg",
  "try-peg": "TRY Peg",
  "aud-peg": "AUD Peg",
  "zar-peg": "ZAR Peg",
  "silver-peg": "Silver Peg",
  "var-peg": "CPI Peg",
  "other-peg": "Other Peg",
  centralized: "Centralized",
  "centralized-dependent": "CeFi-Dependent",
  decentralized: "Decentralized",
  "rwa-backed": "RWA-Backed",
  "crypto-backed": "Crypto-Backed",
  algorithmic: "Algorithmic",
  "yield-bearing": "Yield-Bearing",
  rwa: "RWA",
};

function pegCurrencyToFilterTag(peg: PegCurrency): FilterTag {
  switch (peg) {
    case "USD": return "usd-peg";
    case "EUR": return "eur-peg";
    case "GOLD": return "gold-peg";
    case "CHF": return "chf-peg";
    case "GBP": return "gbp-peg";
    case "BRL": return "brl-peg";
    case "RUB": return "rub-peg";
    case "JPY": return "jpy-peg";
    case "IDR": return "idr-peg";
    case "SGD": return "sgd-peg";
    case "TRY": return "try-peg";
    case "AUD": return "aud-peg";
    case "ZAR": return "zar-peg";
    case "SILVER": return "silver-peg";
    case "VAR": return "var-peg";
    default: return "other-peg";
  }
}

export function getFilterTags(meta: StablecoinMeta): FilterTag[] {
  const tags: FilterTag[] = [];
  tags.push(pegCurrencyToFilterTag(meta.flags.pegCurrency));
  tags.push(meta.flags.governance);
  tags.push(meta.flags.backing);
  if (meta.flags.yieldBearing) tags.push("yield-bearing");
  if (meta.flags.rwa) tags.push("rwa");
  return tags;
}

// --- API data types (DefiLlama responses) ---

export interface StablecoinData {
  id: string;
  name: string;
  symbol: string;
  geckoId: string | null;
  pegType: string;
  pegMechanism: string;
  price: number | null;
  priceSource: string;
  circulating: Record<string, number>;
  circulatingPrevDay: Record<string, number>;
  circulatingPrevWeek: Record<string, number>;
  circulatingPrevMonth: Record<string, number>;
  chainCirculating: Record<
    string,
    { current: number; circulatingPrevDay: number; circulatingPrevWeek: number; circulatingPrevMonth: number }
  >;
  chains: string[];
}

export interface StablecoinListResponse {
  peggedAssets: StablecoinData[];
  /** Live FX fallback rates from ECB, keyed by pegType (e.g. peggedEUR: 1.08) */
  fxFallbackRates?: Record<string, number>;
}

export interface ChartDataPoint {
  date: string;
  totalCirculating: Record<string, number>;
  totalCirculatingUSD: Record<string, number>;
}

export interface StablecoinChartResponse {
  [key: string]: ChartDataPoint[];
}

export interface StablecoinHistoryPoint {
  date: string;
  totalCirculating: Record<string, number>;
  totalCirculatingUSD: Record<string, number>;
}

export interface SortConfig {
  key: string;
  direction: "asc" | "desc";
}

// --- Stablecoin Cemetery types ---

export type CauseOfDeath =
  | "algorithmic-failure"
  | "counterparty-failure"
  | "liquidity-drain"
  | "regulatory"
  | "abandoned";

export interface DeadStablecoin {
  name: string;
  symbol: string;
  llamaId?: string;         // DefiLlama stablecoin ID (historical — may have been reassigned)
  logo?: string;            // local path under /logos/cemetery/ (e.g. "ust.png")
  pegCurrency: PegCurrency;
  causeOfDeath: CauseOfDeath;
  deathDate: string;        // "YYYY-MM" format
  peakMcap?: number;        // peak circulating supply in USD (from DefiLlama historical data)
  obituary: string;
  sourceUrl: string;
  sourceLabel: string;
}

// --- Bluechip safety rating types ---

export interface BluechipSmidge {
  stability: string | null;
  management: string | null;
  implementation: string | null;
  decentralization: string | null;
  governance: string | null;
  externals: string | null;
}

export interface BluechipRating {
  grade: string;               // "A+", "B-", "D", etc.
  slug: string;                // "usdc" — for building report URL
  collateralization: number;   // e.g. 100
  smartContractAudit: boolean;
  dateOfRating: string;        // ISO date
  dateLastChange: string | null;
  smidge: BluechipSmidge;      // Plain-text summaries (HTML stripped)
}

export type BluechipRatingsMap = Record<string, BluechipRating>;

// --- DEX Liquidity types ---

export interface DexLiquidityPool {
  project: string;        // "curve-dex", "uniswap-v3", "fluid-dex", etc.
  chain: string;
  tvlUsd: number;
  symbol: string;         // "USDC-USDT", "DAI-USDC-USDT", etc.
  volumeUsd1d: number;
  poolType: string;       // "curve-stableswap", "uniswap-v3-5bp", "fluid-dex"
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

export interface DexPriceSource {
  protocol: string;
  chain: string;
  price: number;
  tvl: number;
}

export interface DexLiquidityData {
  totalTvlUsd: number;
  totalVolume24hUsd: number;
  totalVolume7dUsd: number;
  poolCount: number;
  pairCount: number;
  chainCount: number;
  protocolTvl: Record<string, number>;
  chainTvl: Record<string, number>;
  topPools: DexLiquidityPool[];
  liquidityScore: number | null;
  concentrationHhi: number | null;
  depthStability: number | null;
  tvlChange24h: number | null;
  tvlChange7d: number | null;
  updatedAt: number;
  dexPriceUsd: number | null;
  dexDeviationBps: number | null;
  priceSourceCount: number | null;
  priceSourceTvl: number | null;
  priceSources: DexPriceSource[] | null;
  // v2 fields
  effectiveTvlUsd: number;
  avgPoolStress: number | null;
  weightedBalanceRatio: number | null;
  organicFraction: number | null;
  durabilityScore: number | null;
  scoreComponents: {
    tvlDepth: number;
    volumeActivity: number;
    poolQuality: number;
    durability: number;
    pairDiversity: number;
    crossChain: number;
  } | null;
}

export interface DexLiquidityHistoryPoint {
  tvl: number;
  volume24h: number;
  score: number | null;
  date: number;
}

export type DexLiquidityMap = Record<string, DexLiquidityData>;

// --- Status page types ---

export interface CacheStatus {
  ageSeconds: number | null;
  maxAge: number;
  healthy: boolean;
}

export interface CronRun {
  startedAt: number;
  durationMs: number;
  status: string;
  error?: string;
  itemCount?: number;
}

export interface CronStatus {
  lastRun: CronRun | null;
  recentRuns: CronRun[];
  expectedIntervalSec: number;
  healthy: boolean;
}

export interface DataQuality {
  totalStablecoins: number;
  missingPrices: number;
  blacklistMissingAmounts: number;
  blacklistTotal: number;
  onchainSupplyDivergences: number;
  activeDepegs: number;
  staleOnchainSupply: number;
}

export interface StatusResponse {
  timestamp: number;
  overallStatus: "healthy" | "degraded" | "stale";
  caches: Record<string, CacheStatus>;
  crons: Record<string, CronStatus>;
  dataQuality: DataQuality;
}

// --- Blacklist/Freeze tracker types ---

// --- Depeg event types ---

export interface DepegEvent {
  id: number;
  stablecoinId: string;
  symbol: string;
  pegType: string;
  direction: "above" | "below";
  peakDeviationBps: number;
  startedAt: number;
  endedAt: number | null;
  startPrice: number;
  peakPrice: number | null;
  recoveryPrice: number | null;
  pegReference: number;
  source: "live" | "backfill";
}

// --- Peg Summary types (from /api/peg-summary) ---

export interface DexPriceCheck {
  dexPrice: number;
  dexDeviationBps: number;
  agrees: boolean;
  sourcePools: number;
  sourceTvl: number;
}

export interface PegSummaryCoin {
  id: string;
  symbol: string;
  name: string;
  pegType: string;
  pegCurrency: string;
  governance: string;
  currentDeviationBps: number | null;
  pegScore: number | null;
  pegPct: number;
  severityScore: number;
  spreadPenalty: number;
  eventCount: number;
  worstDeviationBps: number | null;
  activeDepeg: boolean;
  lastEventAt: number | null;
  trackingSpanDays: number;
  dexPriceCheck?: DexPriceCheck | null;
}

export interface PegSummaryStats {
  activeDepegCount: number;
  medianDeviationBps: number;
  worstCurrent: { id: string; symbol: string; bps: number } | null;
  coinsAtPeg: number;
  totalTracked: number;
}

export interface PegSummaryResponse {
  coins: PegSummaryCoin[];
  summary: PegSummaryStats | null;
}

// --- Blacklist/Freeze tracker types ---

export type BlacklistStablecoin = "USDC" | "USDT" | "PAXG" | "XAUT";
export type BlacklistEventType = "blacklist" | "unblacklist" | "destroy";

export interface BlacklistEvent {
  id: string;                      // "${chainId}-${txHash}-${logIndex}"
  stablecoin: BlacklistStablecoin;
  chainId: string;
  chainName: string;
  eventType: BlacklistEventType;
  address: string;                 // The affected address
  amount: number | null;           // Only for "destroy" events (USD value)
  txHash: string;
  blockNumber: number;
  timestamp: number;               // Unix seconds
  explorerTxUrl: string;
  explorerAddressUrl: string;
}
