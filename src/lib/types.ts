// --- Flag-based classification ---

/** Backing mechanism */
export type BackingType = "rwa-backed" | "crypto-backed" | "algorithmic";

/** Peg currency */
export type PegCurrency = "USD" | "EUR" | "GBP" | "CHF" | "BRL" | "RUB" | "JPY" | "IDR" | "SGD" | "TRY" | "AUD" | "ZAR" | "CAD" | "CNY" | "PHP" | "MXN" | "UAH" | "ARS" | "GOLD" | "SILVER" | "VAR" | "OTHER";

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

export type DependencyType = "wrapper" | "mechanism" | "collateral";

export interface DependencyWeight {
  id: string;      // DefiLlama ID of upstream stablecoin
  weight: number;  // 0-1, fraction of collateral from this source
  type?: DependencyType;  // default: 'collateral' — see docs/plans/2026-02-27-dependency-type-ceiling-design.md
}

/** Structured reserve composition for treemap visualization */
export type ReserveRisk = "very-low" | "low" | "medium" | "high" | "very-high";
export interface ReserveSlice {
  name: string;
  pct: number;        // percentage of total reserves (should sum to ~100)
  risk: ReserveRisk;  // risk tier for coloring
  coinId?: string;           // DefiLlama ID of a tracked stablecoin (links to dependency graph)
  depType?: DependencyType;  // dependency type when coinId is set; defaults to "collateral"
}

/** Maturity tier of the primary chain where the protocol operates */
export type ChainTier = "ethereum" | "stage1-l2" | "established-alt-l1" | "unproven";

/** How the stablecoin extends across multiple chains */
export type DeploymentModel = "single-chain" | "canonical-bridge" | "third-party-bridge" | "native-multichain";

/** Trust assumptions in the backing assets */
export type CollateralQuality = "native" | "rwa" | "eth-lst" | "alt-lst-bridged-or-mixed" | "exotic";

/** Where collateral is held and who controls it */
export type CustodyModel = "onchain" | "institutional" | "cex";

/** Quality of governance decentralization (overrides coarse GovernanceType) */
export type GovernanceQuality = "immutable-code" | "dao-governance" | "multisig" | "regulated-entity" | "single-entity" | "wrapper";

/** Important notice displayed on a stablecoin's detail page */
export interface CoinNotice {
  type: "danger" | "warning" | "info";
  title: string;
  message: string;
}

export interface StablecoinMeta {
  id: string; // DefiLlama numeric ID
  name: string;
  symbol: string;
  flags: StablecoinFlags;
  collateral?: string;
  pegMechanism?: string;
  commodityOunces?: number; // troy ounces per token (for gold- and silver-pegged stablecoins)
  geckoId?: string;        // CoinGecko coin ID (for price/mcap lookups when DefiLlama lacks it)
  cmcSlug?: string;        // CoinMarketCap slug (fallback price/mcap when DL + CG both miss)
  protocolSlug?: string;   // DefiLlama protocol slug (for TVL/mcap data via /protocol/ API)
  proofOfReserves?: ProofOfReserves;
  links?: StablecoinLink[];
  jurisdiction?: Jurisdiction;
  contracts?: ContractDeployment[];  // On-chain contract deployments per chain
  supplyMethod?: SupplyMethodConfig; // How to compute circulating supply (default: totalSupply)
  dependencies?: DependencyWeight[];  // Upstream stablecoins with collateral weights (CeFi-Dependent coins only)
  canBeBlacklisted?: boolean | "possible";  // true = active blacklist, "possible" = mutable contract / governance-upgradeable, false/undefined = no
  chainTier?: ChainTier;
  deploymentModel?: DeploymentModel;
  collateralQuality?: CollateralQuality;
  custodyModel?: CustodyModel;
  governanceQuality?: GovernanceQuality;
  reserves?: ReserveSlice[];  // Structured reserve composition (manually curated)
  notices?: CoinNotice[];     // Important alerts (winding down, depegged, etc.)
  tags?: string[];            // Protocol lineage / fork tags (e.g. "Liquity v1 fork")
  yieldConfig?: YieldConfig;  // Yield intelligence config (only for yieldBearing coins)
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
  | "cad-peg"
  | "cny-peg"
  | "php-peg"
  | "mxn-peg"
  | "uah-peg"
  | "ars-peg"
  | "silver-peg"
  | "var-peg"
  | "other-peg"
  | "centralized"
  | "centralized-dependent"
  | "decentralized"
  | "rwa-backed"
  | "crypto-backed"
  | "algorithmic";

/** Tags that fall under the "Other Peg" umbrella filter on the homepage */
export const OTHER_PEG_TAGS: FilterTag[] = ["brl-peg", "rub-peg", "jpy-peg", "idr-peg", "sgd-peg", "try-peg", "aud-peg", "zar-peg", "cad-peg", "cny-peg", "php-peg", "mxn-peg", "uah-peg", "ars-peg", "silver-peg", "var-peg", "other-peg"];

export const FILTER_TAG_LABELS: Record<FilterTag, string> = {
  "usd-peg": "USD",
  "eur-peg": "EUR",
  "gold-peg": "Gold",
  "chf-peg": "CHF",
  "gbp-peg": "GBP",
  "brl-peg": "BRL",
  "rub-peg": "RUB",
  "jpy-peg": "JPY",
  "idr-peg": "IDR",
  "sgd-peg": "SGD",
  "try-peg": "TRY",
  "aud-peg": "AUD",
  "zar-peg": "ZAR",
  "cad-peg": "CAD",
  "cny-peg": "CNY",
  "php-peg": "PHP",
  "mxn-peg": "MXN",
  "uah-peg": "UAH",
  "ars-peg": "ARS",
  "silver-peg": "Silver",
  "var-peg": "CPI",
  "other-peg": "Other",
  centralized: "Centralized",
  "centralized-dependent": "CeFi-Dependent",
  decentralized: "Decentralized",
  "rwa-backed": "RWA-Backed",
  "crypto-backed": "Crypto-Backed",
  algorithmic: "Algorithmic",
};

export function pegCurrencyToFilterTag(peg: PegCurrency): FilterTag {
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
    case "CAD": return "cad-peg";
    case "CNY": return "cny-peg";
    case "PHP": return "php-peg";
    case "MXN": return "mxn-peg";
    case "UAH": return "uah-peg";
    case "ARS": return "ars-peg";
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
  return tags;
}

// --- Price confidence (dual-primary validation) ---

export type PriceConfidence = "high" | "single-source" | "low" | "fallback";

// --- API data types (DefiLlama responses) ---

/** Minimal asset shape shared by PeggedAsset (worker enrichment) and StablecoinData.
 *  Used as the parameter type for derivePegRates / detectDepegEvents so that
 *  both PeggedAsset[] and StablecoinData[] are accepted without double-casting.
 */
export interface PegAssetBase {
  id: string;
  symbol: string;
  price?: number | null;
  pegType?: string;
  circulating?: Record<string, number>;
}

export interface StablecoinData {
  id: string;
  name: string;
  symbol: string;
  geckoId: string | null;
  pegType: string;
  pegMechanism: string;
  price: number | null;
  priceSource: string;
  priceConfidence: PriceConfidence | null;
  supplySource?: string;
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
  epitaph?: string;         // terse inscription for the tombstone face (~25 chars for sm, ~35 for md/lg)
  obituary: string;
  sourceUrl: string;
  sourceLabel: string;
}

// --- Bluechip safety rating types ---

export type BluechipGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F";

export interface BluechipSmidge {
  stability: string | null;
  management: string | null;
  implementation: string | null;
  decentralization: string | null;
  governance: string | null;
  externals: string | null;
}

export interface BluechipRating {
  grade: BluechipGrade;        // "A+", "B-", "D", etc.
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

/** Sentinel key for global deduped aggregates in DexLiquidityMap */
export const DEX_GLOBAL_KEY = "__global__";

// --- Report Card types ---

export type ReportCardGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F" | "NR";

export interface ReportCardDimension {
  grade: ReportCardGrade;
  score: number | null;   // 0-100, null if NR
  detail: string;         // Human-readable explanation
}

export type DimensionKey = "pegStability" | "liquidity" | "resilience" | "decentralization" | "dependencyRisk";

export interface RawDimensionInputs {
  pegScore: number | null;
  activeDepeg: boolean;
  depegEventCount: number;
  lastEventAt: number | null;
  liquidityScore: number | null;
  concentrationHhi: number | null;
  bluechipGrade: BluechipGrade | null;
  canBeBlacklisted: boolean | "possible";
  chainTier: ChainTier;
  deploymentModel: DeploymentModel;
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
  governanceTier: GovernanceType;
  governanceQuality: GovernanceQuality;
  dependencies: DependencyWeight[];
  navToken: boolean;
}

export interface ReportCard {
  id: string;
  name: string;
  symbol: string;
  overallGrade: ReportCardGrade;
  overallScore: number | null;
  dimensions: Record<DimensionKey, ReportCardDimension>;
  ratedDimensions: number;
  rawInputs: RawDimensionInputs;
  dependencies?: DependencyWeight[];
  isDefunct: boolean;
}

export interface ReportCardsResponse {
  cards: ReportCard[];
  methodology: {
    version: string;
    weights: Record<DimensionKey, number>;
    pegMultiplierExponent: number;
    thresholds: { grade: ReportCardGrade; min: number }[];
  };
  dependencyGraph: {
    edges: { from: string; to: string }[];
  };
  updatedAt: number;
}

export type ReportCardMap = Record<string, ReportCard>;

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

// --- Health endpoint types ---

export interface CircuitRecord {
  state: "closed" | "half-open" | "open";
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
}

export interface HealthResponse {
  status: "healthy" | "degraded" | "stale";
  timestamp: number;
  caches: Record<string, CacheStatus>;
  blacklist: { totalEvents: number; missingAmounts: number };
  circuits: Record<string, CircuitRecord>;
}

// --- Endpoint probe types ---

export interface EndpointProbeResult {
  path: string;
  status: number | null; // null = timeout/network error
  latencyMs: number;
  error?: string;
}

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
  depegEventsToday: number;
  depegEventsYesterday: number;
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

// ── Yield Intelligence ──────────────────────────────────────────────
export type YieldType = "lending-vault" | "rebase" | "fee-sharing" | "lp-receipt" | "nav-appreciation" | "governance-set";

export interface YieldConfig {
  /** DeFiLlama pool UUID for deterministic matching */
  defiLlamaPoolId?: string;
  /** Human-readable yield source description */
  yieldSource: string;
  /** Yield mechanism type */
  yieldType: YieldType;
}

export interface YieldRanking {
  id: string;
  symbol: string;
  name: string;
  currentApy: number;
  apy7d: number;
  apy30d: number;
  apyBase: number | null;
  apyReward: number | null;
  yieldSource: string;
  yieldType: string;
  dataSource: string;
  sourceTvlUsd: number | null;
  pharosYieldScore: number | null;
  safetyScore: number | null;
  safetyGrade: string | null;
  yieldToRisk: number | null;
  excessYield: number | null;
  yieldStability: number | null;
  apyVariance30d: number | null;
  apyMin30d: number | null;
  apyMax30d: number | null;
}

export interface YieldRankingsResponse {
  rankings: YieldRanking[];
  riskFreeRate: number;
  scalingFactor: number;
  updatedAt: number;
}

export interface YieldHistoryPoint {
  date: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  exchangeRate: number | null;
  sourceTvlUsd: number | null;
}

// --- Mint/Burn Flow types ---

export interface MintBurnGauge {
  score: number | null;
  band: string | null;
  flightToQuality: boolean;
  flightIntensity: number;
  trackedCoins: number;
  trackedMcapUsd: number;
}

export interface MintBurnCoinFlow {
  stablecoinId: string;
  symbol: string;
  flowIntensity: number | null;
  netFlow24hUsd: number;
  mintVolume24hUsd: number;
  burnVolume24hUsd: number;
  mintCount24h: number;
  burnCount24h: number;
  netFlow7dUsd: number;
  largestEvent24h: {
    direction: "mint" | "burn";
    amountUsd: number;
    txHash: string;
    timestamp: number;
  } | null;
}

export interface MintBurnHourlyBucket {
  hourTs: number;
  netFlowUsd: number;
  mintVolumeUsd: number;
  burnVolumeUsd: number;
}

export interface MintBurnFlowsResponse {
  gauge: MintBurnGauge;
  coins: MintBurnCoinFlow[];
  hourly: MintBurnHourlyBucket[];
  updatedAt: number;
}

export interface MintBurnEvent {
  id: string;
  stablecoinId: string;
  symbol: string;
  chainId: string;
  direction: "mint" | "burn";
  amount: number;
  amountUsd: number | null;
  counterparty: string | null;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  explorerTxUrl: string;
}

export interface MintBurnEventsResponse {
  events: MintBurnEvent[];
  total: number;
}
