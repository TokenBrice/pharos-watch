import { z } from "zod";
import { NET_FLOW_DIRECTION_24H_VALUES, PRESSURE_SHIFT_STATE_VALUES } from "@shared/lib/mint-burn-signals";

// --- Flag-based classification ---

/** Backing mechanism */
export type BackingType = "rwa-backed" | "crypto-backed" | "algorithmic";

/** Peg currency */
export type PegCurrency =
  | "USD"
  | "EUR"
  | "GBP"
  | "CHF"
  | "BRL"
  | "RUB"
  | "JPY"
  | "IDR"
  | "SGD"
  | "TRY"
  | "AUD"
  | "ZAR"
  | "CAD"
  | "CNY"
  | "CNH"
  | "PHP"
  | "MXN"
  | "UAH"
  | "ARS"
  | "GOLD"
  | "SILVER"
  | "VAR"
  | "OTHER";

/** Governance model */
export type GovernanceType = "centralized" | "centralized-dependent" | "decentralized";

interface StablecoinFlags {
  backing: BackingType;
  pegCurrency: PegCurrency;
  governance: GovernanceType;
  yieldBearing: boolean;
  rwa: boolean; // real-world-asset backed (treasuries, bonds, etc.)
  navToken: boolean; // price appreciates over time as yield accrues (not pegged to $1) — exclude from peg deviation metrics
}

type ProofOfReservesType = "independent-audit" | "real-time" | "self-reported";

interface ProofOfReserves {
  type: ProofOfReservesType;
  url: string;
  provider?: string;
}

interface StablecoinLink {
  label: string;
  url: string;
}

interface Jurisdiction {
  country: string;
  regulator?: string;
  license?: string;
}

export interface ContractDeployment {
  chain: string; // Chain ID (e.g., "ethereum", "arbitrum", "tron")
  address: string; // Contract address (0x... for EVM, T... for Tron)
  decimals: number; // Token decimals
}

export type DependencyType = "wrapper" | "mechanism" | "collateral";

export interface DependencyWeight {
  id: string; // Stablecoin ID (canonical ticker-issuer format in future; currently legacy)
  weight: number; // 0-1, fraction of collateral from this source
  type?: DependencyType; // default: 'collateral' — see docs/plans/2026-02-27-dependency-type-ceiling-design.md
}

/** Structured reserve composition for treemap visualization */
export type ReserveRisk = "very-low" | "low" | "medium" | "high" | "very-high";
export interface ReserveSlice {
  name: string;
  pct: number; // percentage of total reserves (should sum to ~100)
  risk: ReserveRisk; // risk tier for coloring
  coinId?: string; // Stablecoin ID (canonical ticker-issuer format in future; currently legacy) — links to dependency graph
  depType?: DependencyType; // dependency type when coinId is set; defaults to "collateral"
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
export type GovernanceQuality =
  | "immutable-code"
  | "dao-governance"
  | "multisig"
  | "regulated-entity"
  | "single-entity"
  | "wrapper";

const GOVERNANCE_TYPE_VALUES = ["centralized", "centralized-dependent", "decentralized"] as const;
const DEPENDENCY_TYPE_VALUES = ["wrapper", "mechanism", "collateral"] as const;
const CHAIN_TIER_VALUES = ["ethereum", "stage1-l2", "established-alt-l1", "unproven"] as const;
const DEPLOYMENT_MODEL_VALUES = ["single-chain", "canonical-bridge", "third-party-bridge", "native-multichain"] as const;
const COLLATERAL_QUALITY_VALUES = ["native", "rwa", "eth-lst", "alt-lst-bridged-or-mixed", "exotic"] as const;
const CUSTODY_MODEL_VALUES = ["onchain", "institutional", "cex"] as const;
const GOVERNANCE_QUALITY_VALUES = [
  "immutable-code",
  "dao-governance",
  "multisig",
  "regulated-entity",
  "single-entity",
  "wrapper",
] as const;

const GovernanceTypeSchema = z.enum(GOVERNANCE_TYPE_VALUES);
const DependencyTypeSchema = z.enum(DEPENDENCY_TYPE_VALUES);
const ChainTierSchema = z.enum(CHAIN_TIER_VALUES);
const DeploymentModelSchema = z.enum(DEPLOYMENT_MODEL_VALUES);
const CollateralQualitySchema = z.enum(COLLATERAL_QUALITY_VALUES);
const CustodyModelSchema = z.enum(CUSTODY_MODEL_VALUES);
const GovernanceQualitySchema = z.enum(GOVERNANCE_QUALITY_VALUES);

/** Important notice displayed on a stablecoin's detail page */
export interface CoinNotice {
  type: "danger" | "warning" | "info";
  title: string;
  message: string;
}

export type LiveReserveSemantics =
  | "collateral-mix"
  | "protocol-reserve"
  | "attestation-mix"
  | "single-asset";

export type LiveReserveInput =
  | { kind: "http-json"; url: string }
  | { kind: "http-html"; url: string }
  | { kind: "indexer"; url: string }
  | { kind: "onchain-evm"; chain: string; rpcMode: "etherscan-proxy" | "alchemy" | "public-rpc" };

export interface LiveReserveWarning {
  code: string;
  message: string;
  severity: "info" | "warning";
}

/** Configuration for live reserve composition sync. */
export interface LiveReservesConfig {
  /** Registered adapter key (e.g., "infinifi", "circle", "bold-onchain"). */
  adapter: string;
  /** Increment when adapter parsing or semantics change materially. */
  version: number;
  /** What the source actually represents. */
  semantics: LiveReserveSemantics;
  /** Optional circuit-breaker grouping key. Defaults to the adapter key. */
  breakerScope?: string;
  /** Human-readable destination for UI links. */
  display?: {
    url?: string;
    label?: string;
  };
  /** Source inputs consumed by the adapter. */
  inputs: {
    primary: LiveReserveInput;
    fallbacks?: LiveReserveInput[];
  };
  /** Adapter-specific validated settings. */
  params?: Record<string, unknown>;
}

export type ReservePresentationMode =
  | "live"
  | "live-stale"
  | "curated-fallback"
  | "template-fallback"
  | "unavailable";

export interface ReserveSyncStateView {
  enabled: boolean;
  status: "ok" | "degraded" | "error" | "skipped";
  stale: boolean;
  bootstrap: boolean;
  lastAttemptedAt?: number;
  lastSuccessAt?: number;
  warnings?: string[];
}

export interface StablecoinReservesResponse {
  stablecoinId: string;
  mode: ReservePresentationMode;
  reserves: ReserveSlice[];
  estimated: boolean;
  liveAt?: number;
  source?: string;
  displayUrl?: string;
  sync?: ReserveSyncStateView;
}

export interface StablecoinMeta {
  id: string; // Stablecoin ID (canonical ticker-issuer format in future; currently legacy)
  /** DefiLlama numeric stablecoin ID (for API calls to stablecoins.llama.fi) */
  llamaId?: string;
  /** Data provider for detail page fetching -- replaces id-prefix heuristics */
  detailProvider?: "defillama" | "coingecko" | "commodity";
  name: string;
  symbol: string;
  flags: StablecoinFlags;
  collateral?: string;
  pegMechanism?: string;
  commodityOunces?: number; // troy ounces per token (for gold- and silver-pegged stablecoins)
  geckoId?: string; // CoinGecko coin ID (for price/mcap lookups when DefiLlama lacks it)
  cmcSlug?: string; // CoinMarketCap slug (fallback price/mcap when DL + CG both miss)
  protocolSlug?: string; // DefiLlama protocol slug (for TVL/mcap data via /protocol/ API)
  proofOfReserves?: ProofOfReserves;
  links?: StablecoinLink[];
  jurisdiction?: Jurisdiction;
  contracts?: ContractDeployment[]; // On-chain contract deployments per chain
  tradedContracts?: ContractDeployment[]; // Wrapper / secondary-market token addresses used for trading and DEX discovery
  dependencies?: DependencyWeight[]; // Upstream stablecoins with collateral weights (CeFi-Dependent coins only)
  canBeBlacklisted?: boolean | "possible"; // true = active blacklist, "possible" = mutable contract / governance-upgradeable, false/undefined = no
  chainTier?: ChainTier;
  deploymentModel?: DeploymentModel;
  collateralQuality?: CollateralQuality;
  custodyModel?: CustodyModel;
  governanceQuality?: GovernanceQuality;
  reserves?: ReserveSlice[]; // Structured reserve composition (manually curated)
  liveReservesConfig?: LiveReservesConfig; // Live reserve sync config (adapter + URL)
  notices?: CoinNotice[]; // Important alerts (winding down, depegged, etc.)
  tags?: string[]; // Protocol lineage / fork tags (e.g. "Liquity v1 fork")
  yieldConfig?: YieldConfig; // Yield intelligence config (only for yieldBearing coins)
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
  | "cnh-peg"
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
export const OTHER_PEG_TAGS: FilterTag[] = [
  "brl-peg",
  "rub-peg",
  "jpy-peg",
  "idr-peg",
  "sgd-peg",
  "try-peg",
  "aud-peg",
  "zar-peg",
  "cad-peg",
  "cny-peg",
  "cnh-peg",
  "php-peg",
  "mxn-peg",
  "uah-peg",
  "ars-peg",
  "silver-peg",
  "var-peg",
  "other-peg",
];

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
  "cnh-peg": "CNH",
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
    case "USD":
      return "usd-peg";
    case "EUR":
      return "eur-peg";
    case "GOLD":
      return "gold-peg";
    case "CHF":
      return "chf-peg";
    case "GBP":
      return "gbp-peg";
    case "BRL":
      return "brl-peg";
    case "RUB":
      return "rub-peg";
    case "JPY":
      return "jpy-peg";
    case "IDR":
      return "idr-peg";
    case "SGD":
      return "sgd-peg";
    case "TRY":
      return "try-peg";
    case "AUD":
      return "aud-peg";
    case "ZAR":
      return "zar-peg";
    case "CAD":
      return "cad-peg";
    case "CNY":
      return "cny-peg";
    case "CNH":
      return "cnh-peg";
    case "PHP":
      return "php-peg";
    case "MXN":
      return "mxn-peg";
    case "UAH":
      return "uah-peg";
    case "ARS":
      return "ars-peg";
    case "SILVER":
      return "silver-peg";
    case "VAR":
      return "var-peg";
    default:
      return "other-peg";
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
export type DepegPrimaryTrust = "authoritative" | "confirm_required" | "unusable";

// --- API data types (DefiLlama responses) ---

/** Minimal asset shape shared by PeggedAsset (worker enrichment) and StablecoinData.
 *  Used as the parameter type for derivePegRates / detectDepegEvents so that
 *  both PeggedAsset[] and StablecoinData[] are accepted without double-casting.
 */
export interface PegAssetBase {
  id: string;
  symbol: string;
  price?: number | null;
  priceSource?: string | null;
  priceConfidence?: PriceConfidence | null;
  priceUpdatedAt?: number | null;
  pegType?: string;
  circulating?: Record<string, number>;
}

// --- Daily digest types (shared by frontend + worker) ---

export interface DigestInputData {
  totalMcapUsd: number;
  mcap7dDelta: number;
  activeDepegCount: number;
  topDepegs: { symbol: string; bps: number; mcapUsd: number }[];
  biggestSupplyChange: {
    id: string;
    symbol: string;
    name: string;
    changeUsd: number;
    currentMcap: number;
  } | null;
  stabilityIndex: {
    score: number;
    band: string;
    components: {
      severity: number;
      breadth: number;
      stressBreadth?: number;
      trend: number;
    };
  } | null;
  yesterdayIndex: { score: number; band: string } | null;
  blacklistActivity?: {
    eventCount: number;
    totalAmountUsd: number;
    topEvents: { symbol: string; chain: string; type: "blacklist" | "destroy"; amountUsd: number }[];
  };
  supplyVelocity?: {
    coin: string;
    change1d: number;
    change7d: number;
    signal: string;
  }[];
  safetyScores?: {
    mentionedCoins: { symbol: string; grade: string; score: number; peg: number | null; liq: number | null }[];
    medianGrade: string;
    aboveBCount: number;
    fCount: number;
  };
  resolvedDepegs?: {
    symbol: string;
    peakBps: number;
    durationHours: number;
    mcapUsd: number;
  }[];
  mintBurnFlows?: {
    gaugeScore: number;
    gaugeBand: string;
    flightToQuality: {
      active: boolean;
      safeNetUsd: number;
      riskyNetUsd: number;
    };
    topPressure: {
      symbol: string;
      intensity: number;
      net24hUsd: number;
    }[];
  };
  dewsStress?: {
    bandCounts: { calm: number; watch: number; alert: number; warning: number; danger: number };
    yesterdayBandCounts: { calm: number; watch: number; alert: number; warning: number; danger: number };
    bandChanges: {
      symbol: string;
      from: string;
      to: string;
      score: number;
      topDriver: string;
    }[];
    elevatedCoins: {
      symbol: string;
      band: string;
      score: number;
      mcapUsd: number;
    }[];
  };
  historicalContext?: {
    psiPrecedent: {
      lastSeenDate: number;
      lastSeenDaysAgo: number;
      lastSeenScore: number;
      lastSeenBand: string;
    } | null;
    psiBandStreak: number;
    supplyMoverContext: {
      allTimeHighMcap: number;
      allTimeHighDate: number;
      largestWeeklyChange: number;
      largestWeeklyChangeDate: number;
      largestWeeklyChangeDaysAgo: number;
    } | null;
  };
  gradeTransitions?: {
    symbol: string;
    fromGrade: string;
    toGrade: string;
    fromScore: number;
    toScore: number;
    currentDimensions: {
      peg: number | null;
      liq: number | null;
      resilience: number | null;
      decentralization: number | null;
    };
    mcapUsd: number;
  }[];
}

export interface DailyDigestResponse {
  digest: string | null;
  digestTitle?: string | null;
  digestExtended?: string | null;
  generatedAt?: number | null;
}

export interface DigestArchiveEntry {
  digestText: string;
  digestTitle: string | null;
  digestExtended: string | null;
  generatedAt: number;
  psiScore: number | null;
  psiBand: string | null;
  totalMcapUsd: number | null;
}

export interface DigestArchiveResponse {
  digests: DigestArchiveEntry[];
}

export interface StablecoinChartPoint {
  date: number;
  totalCirculatingUSD: Record<string, number>;
}

export interface UsdsStatusResponse {
  freezeActive: boolean;
  implementationAddress: string;
  lastChecked: number;
}

export interface DigestSnapshotResponse {
  date: string;
  inputData: DigestInputData | null;
  prevInputData: DigestInputData | null;
  depegEvents: Array<{
    stablecoinId: string;
    symbol: string;
    direction: string;
    peakDeviationBps: number;
    startedAt: number;
    endedAt: number | null;
  }>;
  blacklistEvents: Array<{
    stablecoin: string;
    chainName: string;
    eventType: string;
    address: string;
    amount: number | null;
    timestamp: number;
  }>;
}

const PegBucketsSchema = z.record(z.string(), z.number());
const ChainCirculatingSchema = z.record(
  z.string(),
  z.object({
    current: z.number(),
    circulatingPrevDay: z.number(),
    circulatingPrevWeek: z.number(),
    circulatingPrevMonth: z.number(),
  }),
);

const PriceConfidenceSchema = z.enum(["high", "single-source", "low", "fallback"]);
const DepegPrimaryTrustSchema = z.enum(["authoritative", "confirm_required", "unusable"]);

const StablecoinDataRawSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  geckoId: z.string().nullable().optional(),
  gecko_id: z.string().nullable().optional(),
  pegType: z.string(),
  pegMechanism: z.string(),
  price: z.number().nullable(),
  priceSource: z.string(),
  priceConfidence: PriceConfidenceSchema.nullable().optional(),
  priceUpdatedAt: z.number().nullable().optional(),
  supplySource: z.string().optional(),
  circulating: PegBucketsSchema,
  circulatingPrevDay: PegBucketsSchema.nullish(),
  circulatingPrevWeek: PegBucketsSchema.nullish(),
  circulatingPrevMonth: PegBucketsSchema.nullish(),
  chainCirculating: ChainCirculatingSchema,
  chains: z.array(z.string()),
});

const StablecoinDataSchema = StablecoinDataRawSchema.transform((asset) => ({
  id: asset.id,
  name: asset.name,
  symbol: asset.symbol,
  geckoId: asset.geckoId ?? asset.gecko_id ?? null,
  pegType: asset.pegType,
  pegMechanism: asset.pegMechanism,
  price: asset.price,
  priceSource: asset.priceSource,
  priceConfidence: asset.priceConfidence ?? null,
  priceUpdatedAt: asset.priceUpdatedAt ?? null,
  supplySource: asset.supplySource,
  circulating: asset.circulating,
  circulatingPrevDay: asset.circulatingPrevDay ?? {},
  circulatingPrevWeek: asset.circulatingPrevWeek ?? {},
  circulatingPrevMonth: asset.circulatingPrevMonth ?? {},
  chainCirculating: asset.chainCirculating,
  chains: asset.chains,
}));
export type StablecoinData = z.infer<typeof StablecoinDataSchema>;

export const StablecoinListResponseSchema = z.object({
  peggedAssets: z.array(StablecoinDataSchema),
  fxFallbackRates: z.record(z.string(), z.number()).optional(),
});
export type StablecoinListResponse = z.infer<typeof StablecoinListResponseSchema>;

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
  llamaId?: string; // DefiLlama stablecoin ID (historical — may have been reassigned)
  logo?: string; // local path under /logos/cemetery/ (e.g. "ust.png")
  pegCurrency: PegCurrency;
  causeOfDeath: CauseOfDeath;
  deathDate: string; // "YYYY-MM" format
  peakMcap?: number; // peak circulating supply in USD (from DefiLlama historical data)
  epitaph?: string; // terse inscription for the tombstone face (~25 chars for sm, ~35 for md/lg)
  obituary: string;
  sourceUrl: string;
  sourceLabel: string;
}

// --- Bluechip safety rating types ---

export type BluechipGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F";
const BLUECHIP_GRADE_VALUES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"] as const;
const BluechipGradeSchema = z.enum(BLUECHIP_GRADE_VALUES);

export interface BluechipSmidge {
  stability: string | null;
  management: string | null;
  implementation: string | null;
  decentralization: string | null;
  governance: string | null;
  externals: string | null;
}

export interface BluechipRating {
  grade: BluechipGrade; // "A+", "B-", "D", etc.
  slug: string; // "usdc" — for building report URL
  collateralization: number; // e.g. 100
  smartContractAudit: boolean;
  dateOfRating: string; // ISO date
  dateLastChange: string | null;
  smidge: BluechipSmidge; // Plain-text summaries (HTML stripped)
}

export type BluechipRatingsMap = Record<string, BluechipRating>;

// --- DEX Liquidity types ---

// Tier 3 policy:
// - If runtime schema and TS type are 1:1, export via z.infer.
// - Keep hand-written interfaces only when they intentionally narrow/widen schema typing.

export const LiquidityPoolSourceFamilySchema = z.enum([
  "dl",
  "cg_onchain",
  "gecko_terminal",
  "dexscreener",
  "cg_tickers",
]);
export type LiquidityPoolSourceFamily = z.infer<typeof LiquidityPoolSourceFamilySchema>;

const LegacyLiquidityPoolSourceSchema = z.enum([
  "cg",
  "gt",
  "ds",
]);

export const LiquidityCoverageClassSchema = z.enum([
  "primary",
  "mixed",
  "fallback",
  "legacy",
  "unobserved",
]);
export type LiquidityCoverageClass = z.infer<typeof LiquidityCoverageClassSchema>;

const LiquiditySourceMixEntrySchema = z.object({
  poolCount: z.number(),
  tvlUsd: z.number(),
});
export type LiquiditySourceMixEntry = z.infer<typeof LiquiditySourceMixEntrySchema>;

export const LiquiditySourceMixSchema = z.record(z.string(), LiquiditySourceMixEntrySchema);
export type LiquiditySourceMix = Record<string, LiquiditySourceMixEntry>;

const DexLiquidityPoolSchema = z.object({
  project: z.string(),
  chain: z.string(),
  tvlUsd: z.number(),
  symbol: z.string(),
  volumeUsd1d: z.number(),
  poolType: z.string(),
  source: z.union([LiquidityPoolSourceFamilySchema, LegacyLiquidityPoolSourceSchema]).optional(),
  extra: z
    .object({
      amplificationCoefficient: z.number().optional(),
      balanceRatio: z.number().optional(),
      feeTier: z.number().optional(),
      effectiveTvl: z.number().optional(),
      organicFraction: z.number().optional(),
      pairQuality: z.number().optional(),
      stressIndex: z.number().optional(),
      isMetaPool: z.boolean().optional(),
      maturityDays: z.number().optional(),
      registryId: z.string().optional(),
      balanceDetails: z
        .array(
          z.object({
            symbol: z.string(),
            balancePct: z.number(),
            isTracked: z.boolean(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export type DexLiquidityPool = z.infer<typeof DexLiquidityPoolSchema>;

const DexPriceSourceSchema = z.object({
  protocol: z.string(),
  chain: z.string(),
  price: z.number(),
  tvl: z.number(),
});

const DexLiquidityDataSchema = z.object({
  totalTvlUsd: z.number(),
  totalVolume24hUsd: z.number(),
  totalVolume7dUsd: z.number(),
  poolCount: z.number(),
  pairCount: z.number(),
  chainCount: z.number(),
  protocolTvl: z.record(z.string(), z.number()),
  chainTvl: z.record(z.string(), z.number()),
  topPools: z.array(DexLiquidityPoolSchema),
  liquidityScore: z.number().nullable(),
  concentrationHhi: z.number().nullable(),
  depthStability: z.number().nullable(),
  tvlChange24h: z.number().nullable(),
  tvlChange7d: z.number().nullable(),
  updatedAt: z.number(),
  dexPriceUsd: z.number().nullable(),
  dexDeviationBps: z.number().nullable(),
  priceSourceCount: z.number().nullable(),
  priceSourceTvl: z.number().nullable(),
  priceSources: z.array(DexPriceSourceSchema).nullable(),
  effectiveTvlUsd: z.number(),
  avgPoolStress: z.number().nullable(),
  weightedBalanceRatio: z.number().nullable(),
  organicFraction: z.number().nullable(),
  durabilityScore: z.number().nullable(),
  coverageClass: LiquidityCoverageClassSchema,
  coverageConfidence: z.number(),
  sourceMix: LiquiditySourceMixSchema,
  balanceMeasuredTvlUsd: z.number(),
  organicMeasuredTvlUsd: z.number(),
  scoreComponents: z
    .object({
      tvlDepth: z.number(),
      volumeActivity: z.number(),
      poolQuality: z.number(),
      durability: z.number(),
      pairDiversity: z.number(),
      crossChain: z.number().optional(),
    })
    .nullable(),
  lockedLiquidityPct: z.number().nullable().optional(),
  methodologyVersion: z.string(),
});
export type DexLiquidityData = z.infer<typeof DexLiquidityDataSchema>;

export interface DexLiquidityHistoryPoint {
  tvl: number;
  volume24h: number;
  score: number | null;
  date: number;
  coverageClass: LiquidityCoverageClass;
  coverageConfidence: number;
  methodologyVersion: string;
}

export type DexLiquidityMap = Record<string, DexLiquidityData>;
export const DexLiquidityMapSchema = z.record(z.string(), DexLiquidityDataSchema);

/** Sentinel key for global deduped aggregates in DexLiquidityMap */
export const DEX_GLOBAL_KEY = "__global__";

// --- Report Card types ---

export type ReportCardGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F" | "NR";
const REPORT_CARD_GRADE_VALUES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F", "NR"] as const;
const ReportCardGradeSchema = z.enum(REPORT_CARD_GRADE_VALUES);

export type DimensionKey = "pegStability" | "liquidity" | "resilience" | "decentralization" | "dependencyRisk";

export interface SafetyScoreHistoryPoint {
  date: number;
  grade: ReportCardGrade;
  score: number | null;
  prevGrade: ReportCardGrade | null;
  prevScore: number | null;
  methodologyVersion: string;
}

const SafetyScoreHistoryPointSchema = z.object({
  date: z.number(),
  grade: ReportCardGradeSchema,
  score: z.number().nullable(),
  prevGrade: ReportCardGradeSchema.nullable(),
  prevScore: z.number().nullable(),
  methodologyVersion: z.string(),
});

export const SafetyScoreHistoryResponseSchema: z.ZodType<SafetyScoreHistoryResponse> = z.array(SafetyScoreHistoryPointSchema);
export type SafetyScoreHistoryResponse = SafetyScoreHistoryPoint[];

export interface ReportCardDimension {
  grade: ReportCardGrade;
  score: number | null; // 0-100, null if NR
  detail: string; // Human-readable explanation
}

export interface RawDimensionInputs {
  pegScore: number | null;
  activeDepeg: boolean;
  depegEventCount: number;
  lastEventAt: number | null;
  liquidityScore: number | null;
  concentrationHhi: number | null;
  bluechipGrade: BluechipGrade | null;
  canBeBlacklisted: boolean | "possible" | "possible-inherited";
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
  baseScore: number | null;
  dimensions: Record<DimensionKey, ReportCardDimension>;
  ratedDimensions: number;
  rawInputs: RawDimensionInputs;
  dependencies?: DependencyWeight[];
  isDefunct: boolean;
}

const DependencyWeightSchema = z.object({
  id: z.string(),
  weight: z.number(),
  type: DependencyTypeSchema.optional(),
});

const ReportCardDimensionSchema = z.object({
  grade: ReportCardGradeSchema,
  score: z.number().nullable(),
  detail: z.string(),
});

const RawDimensionInputsSchema = z.object({
  pegScore: z.number().nullable(),
  activeDepeg: z.boolean(),
  depegEventCount: z.number(),
  lastEventAt: z.number().nullable(),
  liquidityScore: z.number().nullable(),
  concentrationHhi: z.number().nullable(),
  bluechipGrade: BluechipGradeSchema.nullable(),
  canBeBlacklisted: z.union([z.boolean(), z.literal("possible"), z.literal("possible-inherited")]),
  chainTier: ChainTierSchema,
  deploymentModel: DeploymentModelSchema,
  collateralQuality: CollateralQualitySchema,
  custodyModel: CustodyModelSchema,
  governanceTier: GovernanceTypeSchema,
  governanceQuality: GovernanceQualitySchema,
  dependencies: z.array(DependencyWeightSchema),
  navToken: z.boolean(),
});

const ReportCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  overallGrade: ReportCardGradeSchema,
  overallScore: z.number().nullable(),
  baseScore: z.number().nullable(),
  dimensions: z.object({
    pegStability: ReportCardDimensionSchema,
    liquidity: ReportCardDimensionSchema,
    resilience: ReportCardDimensionSchema,
    decentralization: ReportCardDimensionSchema,
    dependencyRisk: ReportCardDimensionSchema,
  }),
  ratedDimensions: z.number(),
  rawInputs: RawDimensionInputsSchema,
  dependencies: z.array(DependencyWeightSchema).optional(),
  isDefunct: z.boolean(),
});

const ReportCardsMethodologySchema = z.object({
  version: z.string(),
  weights: z.object({
    pegStability: z.number(),
    liquidity: z.number(),
    resilience: z.number(),
    decentralization: z.number(),
    dependencyRisk: z.number(),
  }),
  pegMultiplierExponent: z.number(),
  thresholds: z.array(z.object({ grade: ReportCardGradeSchema, min: z.number() })),
});

const ReportCardsDependencyGraphSchema = z.object({
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
});

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

export const ReportCardsResponseSchema: z.ZodType<ReportCardsResponse> = z.object({
  cards: z.array(ReportCardSchema),
  methodology: ReportCardsMethodologySchema,
  dependencyGraph: ReportCardsDependencyGraphSchema,
  updatedAt: z.number(),
});

// --- Stability Index types ---

const MethodologyEnvelopeSchema = z.object({
  version: z.string(),
  versionLabel: z.string(),
  currentVersion: z.string(),
  currentVersionLabel: z.string(),
  changelogPath: z.string(),
  asOf: z.number(),
  isCurrent: z.boolean(),
});

const StabilityIndexComponentsSchema = z.object({
  severity: z.number(),
  breadth: z.number(),
  stressBreadth: z.number().optional(),
  trend: z.number(),
});

const StabilityContributorSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  bps: z.number(),
  mcapUsd: z.number(),
  ageDays: z.number(),
  factor: z.number(),
});

const StabilityIndexCurrentSchema = z.object({
  score: z.number(),
  band: z.string(),
  avg24h: z.number().optional(),
  avg24hBand: z.string().optional(),
  components: StabilityIndexComponentsSchema,
  contributors: z.array(StabilityContributorSchema).optional(),
  totalMcapUsd: z.number().optional(),
  computedAt: z.number(),
  methodologyVersion: z.string(),
});

const StabilityIndexHistoryPointSchema = z.object({
  date: z.number(),
  score: z.number(),
  band: z.string(),
  components: StabilityIndexComponentsSchema.optional(),
  methodologyVersion: z.string(),
});

export const StabilityIndexResponseSchema = z.object({
  current: StabilityIndexCurrentSchema.nullable(),
  history: z.array(StabilityIndexHistoryPointSchema),
  methodology: MethodologyEnvelopeSchema,
});
export type StabilityContributor = z.infer<typeof StabilityContributorSchema>;
export type StabilityIndexCurrent = z.infer<typeof StabilityIndexCurrentSchema>;
export type StabilityIndexHistoryPoint = z.infer<typeof StabilityIndexHistoryPointSchema>;
export type StabilityIndexResponse = z.infer<typeof StabilityIndexResponseSchema>;

// --- Status page types ---

export interface CacheStatus {
  ageSeconds: number | null;
  maxAge: number;
  healthy: boolean;
}

const CacheStatusSchema = z.object({
  ageSeconds: z.number().nullable(),
  maxAge: z.number(),
  healthy: z.boolean(),
});

export interface CronRun {
  startedAt: number;
  durationMs: number;
  status: string;
  error?: string;
  itemCount?: number;
  metadata?: Record<string, unknown>;
}

export interface CronInFlight {
  startedAt: number;
  updatedAt: number;
  stage?: string;
  itemsDone?: number;
  itemsTotal?: number;
  message?: string;
  leaseOwner?: string;
  metadata?: Record<string, unknown>;
  stale: boolean;
}

export interface CronStatus {
  lastRun: CronRun | null;
  recentRuns: CronRun[];
  expectedIntervalSec: number;
  healthy: boolean;
  inFlight?: CronInFlight | null;
}

export interface StatusCause {
  code: string;
  layer: "availability" | "data-quality" | "system";
  severity: "info" | "warning" | "critical";
  message: string;
  metric?: string;
  value?: number;
  threshold?: number;
}

export interface StatusStateInfo {
  scope: "global";
  currentStatus: "healthy" | "degraded" | "stale";
  rawStatus: "healthy" | "degraded" | "stale";
  lastEvaluatedAt: number;
  lastChangedAt: number;
  minDwellSec: number;
  staleMinDwellSec: number;
  consecutiveRaw: {
    healthy: number;
    degraded: number;
    stale: number;
  };
  thresholds: {
    escalateToDegraded: number;
    escalateToStale: number;
    recoverToDegraded: number;
    recoverToHealthy: number;
  };
}

export interface StatusStaleness {
  ageSeconds: number;
  maxAgeSec: number;
  isStale: boolean;
}

export interface StatusProbeSummary {
  timestamp: number | null;
  status: "healthy" | "degraded" | "stale" | "unknown";
  sampleCount: number;
  passCount: number;
  failCount: number;
  bootstrapMissCount?: number;
  p95LatencyMs: number | null;
}

export interface StatusDiscrepancy {
  hasDivergence: boolean;
  severityDelta: number;
  statusSeverity: number;
  probeSeverity: number;
  details: string | null;
  probeAgeSeconds: number | null;
  consecutiveDivergent: number;
}

export interface StatusTransition {
  id: number;
  scope: "global";
  from: "healthy" | "degraded" | "stale" | null;
  to: "healthy" | "degraded" | "stale";
  rawStatus: "healthy" | "degraded" | "stale";
  transitionType: "degrade" | "recover" | "init";
  reason: string;
  confidence: number;
  causes: StatusCause[];
  at: number;
}

export interface DataQuality {
  stablecoinsCacheStatus: "ok" | "degraded" | "error";
  stablecoinsCacheReason: string | null;
  totalStablecoins: number;
  missingPrices: number;
  blacklistMissingAmounts: number;
  blacklistRecentMissingAmounts: number;
  blacklistRecentWindowSec: number;
  blacklistMissingRatio: number;
  blacklistTotal: number;
  onchainSupplyDivergences: number;
  onchainDivergenceRatio: number;
  onchainSupplyMonitoring: "active" | "unavailable";
  onchainSupplyLatestAt: number | null;
  onchainSupplyTrackedCoins: number;
  activeDepegs: number;
  staleOnchainSupply: number;
  onchainStaleRatio: number;
}

interface DatasetFreshness {
  stablecoins: number | null;
  blacklist: number | null;
  mintBurn: number | null;
  supply: number | null;
  safetyGrades: number | null;
  yield: number | null;
  depegs: number | null;
  dews: number | null;
  digest: number | null;
  discoveryCandidates: number | null;
}

interface TelegramBotTopStablecoin {
  stablecoinId: string;
  symbol: string;
  subscribers: number;
}

export interface TelegramBotStats {
  totalChats: number;
  alertEnabledChats: number;
  deliverableChats: number;
  subscribedChats: number;
  emptyAlertChats: number;
  mutedChatsWithSubscriptions: number;
  totalSubscriptions: number;
  avgSubscriptionsPerSubscribedChat: number;
  pendingDisambiguations: number;
  pendingDeliveries: number;
  lastSubscriberActivityAt: number | null;
  customPreferenceChats: number;
  quietHoursEnabledChats: number;
  alertTypeChats: {
    dews: number;
    depeg: number;
    safety: number;
    allTypes: number;
  };
  topStablecoins: TelegramBotTopStablecoin[];
}

// --- Discovery candidates ---

export interface DiscoveryCandidate {
  id: number;
  geckoId: string | null;
  llamaId: number | null;
  name: string;
  symbol: string;
  marketCap: number | null;
  source: "defillama" | "coingecko" | "both";
  firstSeen: number;
  lastSeen: number;
  daysSeen: number;
  dismissed: boolean;
}

export interface DiscoveryCandidatesResponse {
  candidates: DiscoveryCandidate[];
  total: number;
}

// --- Price source health ---

export interface PriceSourceHealth {
  sourceDistribution: {
    coingecko: number;
    "coingecko+defillama": number;
    defillama: number;
    "defillama-contract": number;
    coinmarketcap: number;
    dexscreener: number;
    cached: number;
    missing: number;
  };
  confidenceDistribution: {
    high: number;
    "single-source": number;
    low: number;
    fallback: number;
  };
  divergences: {
    id: string;
    symbol: string;
    cgPrice: number;
    dlPrice: number;
    bps: number;
  }[];
  totalAssets: number;
  lastSync: number;
}

export interface LiquidityHealth {
  lastRunStatus: string | null;
  currentCoverage: number;
  previousCoverage: number | null;
  currentGlobalTvl: number | null;
  previousGlobalTvl: number | null;
  currentTop10CoveredTvl: number | null;
  previousTop10CoveredTvl: number | null;
  failedSources: string[];
  nearCoverageGuard: boolean;
  nearValueGuard: boolean;
  nearMajorCoverageGuard: boolean;
  currentCoverageClasses: Record<LiquidityCoverageClass, number>;
  previousCoverageClasses: Record<LiquidityCoverageClass, number>;
}

export interface MintBurnReconciliationRow {
  stablecoinId: string;
  symbol: string;
  flowNet24hUsd: number;
  chainSupplyDelta24hUsd: number | null;
  absoluteDiffUsd: number | null;
  diffRatio: number | null;
  status: "ok" | "warn" | "critical" | "insufficient-source";
  coverageStatus: MintBurnCoverageStatus | "unknown";
}

export interface MintBurnReconciliationSummary {
  checkedAt: number;
  comparedCoins: number;
  criticalCount: number;
  warnCount: number;
  insufficientCount: number;
  rows: MintBurnReconciliationRow[];
}

export interface StatusResponse {
  timestamp: number;
  dbHealthy: boolean;
  availabilityStatus: "healthy" | "degraded" | "stale";
  dataQualityStatus: "healthy" | "degraded" | "stale";
  rawOverallStatus: "healthy" | "degraded" | "stale";
  overallStatus: "healthy" | "degraded" | "stale";
  confidence: number;
  causes: {
    availability: StatusCause[];
    dataQuality: StatusCause[];
    overall: StatusCause[];
  };
  state: StatusStateInfo;
  staleness: StatusStaleness;
  probe: StatusProbeSummary;
  discrepancy: StatusDiscrepancy;
  timeline: StatusTransition[];
  caches: Record<string, CacheStatus>;
  crons: Record<string, CronStatus>;
  dataQuality: DataQuality;
  telegramBot: TelegramBotStats | null;
  datasetFreshness: DatasetFreshness;
  summary: {
    unhealthyCrons: number;
    degradedCrons: number;
    cronErrors: number;
    worstCacheRatio: number;
  };
  liquidityHealth: LiquidityHealth | null;
  priceSourceHealth: PriceSourceHealth | null;
  discoveryCandidates: DiscoveryCandidate[] | null;
  mintBurnReconciliation: MintBurnReconciliationSummary | null;
  reserveComposition: {
    configuredCoins: number;
    freshCoins: number;
    staleCoins: number;
    missingCoins: number;
    degradedCoins: number;
    lastSuccessAt: number | null;
    oldestFreshAgeSec: number | null;
  };
}

export interface StatusHistoryResponse {
  timestamp: number;
  state: StatusStateInfo | null;
  staleness: StatusStaleness | null;
  probe: StatusProbeSummary;
  discrepancy: StatusDiscrepancy;
  transitions: StatusTransition[];
}

// --- Health endpoint types ---

export interface CircuitRecord {
  state: "closed" | "half-open" | "open";
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
}

const CircuitRecordSchema = z.object({
  state: z.enum(["closed", "half-open", "open"]),
  consecutiveFailures: z.number(),
  lastFailureAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  openedAt: z.number().nullable(),
});

export interface HealthResponse {
  status: "healthy" | "degraded" | "stale";
  timestamp: number;
  caches: Record<string, CacheStatus>;
  blacklist: { totalEvents: number; missingAmounts: number };
  mintBurn: {
    totalEvents: number;
    latestEventTs: number | null;
    latestHourlyTs: number | null;
    freshnessAgeSec: number | null;
    majorStaleCount: number;
    staleMajorSymbols: string[];
  };
  circuits: Record<string, CircuitRecord>;
}

export const HealthResponseSchema: z.ZodType<HealthResponse> = z.object({
  status: z.enum(["healthy", "degraded", "stale"]),
  timestamp: z.number(),
  caches: z.record(z.string(), CacheStatusSchema),
  blacklist: z.object({
    totalEvents: z.number(),
    missingAmounts: z.number(),
  }),
  mintBurn: z.object({
    totalEvents: z.number(),
    latestEventTs: z.number().nullable(),
    latestHourlyTs: z.number().nullable(),
    freshnessAgeSec: z.number().nullable(),
    majorStaleCount: z.number(),
    staleMajorSymbols: z.array(z.string()),
  }),
  circuits: z.record(z.string(), CircuitRecordSchema),
});

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

const DepegEventSchema = z.object({
  id: z.number(),
  stablecoinId: z.string(),
  symbol: z.string(),
  pegType: z.string(),
  direction: z.enum(["above", "below"]),
  peakDeviationBps: z.number(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  startPrice: z.number(),
  peakPrice: z.number().nullable(),
  recoveryPrice: z.number().nullable(),
  pegReference: z.number(),
  source: z.enum(["live", "backfill"]),
});
export const DepegEventsResponseSchema = z.object({
  events: z.array(DepegEventSchema),
  total: z.number(),
  methodology: MethodologyEnvelopeSchema.optional(),
});
export type DepegEventsResponse = z.infer<typeof DepegEventsResponseSchema>;

// --- Peg Summary types (from /api/peg-summary) ---

type DepegDewsMethodology = z.infer<typeof MethodologyEnvelopeSchema>;

const PegSummaryCoinSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegType: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  currentDeviationBps: z.number().nullable(),
  pegScore: z.number().nullable(),
  priceSource: z.string().optional(),
  priceConfidence: PriceConfidenceSchema.nullable().optional(),
  priceUpdatedAt: z.number().nullable().optional(),
  primaryTrust: DepegPrimaryTrustSchema.optional(),
  pegPct: z.number(),
  severityScore: z.number(),
  spreadPenalty: z.number(),
  eventCount: z.number(),
  worstDeviationBps: z.number().nullable(),
  activeDepeg: z.boolean(),
  lastEventAt: z.number().nullable(),
  trackingSpanDays: z.number(),
  methodologyVersion: z.string(),
  dexPriceCheck: z
    .object({
      dexPrice: z.number(),
      dexDeviationBps: z.number(),
      agrees: z.boolean(),
      sourcePools: z.number(),
      sourceTvl: z.number(),
    })
    .nullable()
    .optional(),
});
export type PegSummaryCoin = z.infer<typeof PegSummaryCoinSchema>;

const PegSummaryStatsSchema = z.object({
  activeDepegCount: z.number(),
  medianDeviationBps: z.number(),
  worstCurrent: z.object({ id: z.string(), symbol: z.string(), bps: z.number() }).nullable(),
  coinsAtPeg: z.number(),
  totalTracked: z.number(),
  depegEventsToday: z.number(),
  depegEventsYesterday: z.number(),
  fallbackPegRates: z.array(z.string()).optional(),
});
export type PegSummaryStats = z.infer<typeof PegSummaryStatsSchema>;

export const PegSummaryResponseSchema = z.object({
  coins: z.array(PegSummaryCoinSchema),
  summary: PegSummaryStatsSchema.nullable(),
  methodology: MethodologyEnvelopeSchema,
});
export type PegSummaryResponse = z.infer<typeof PegSummaryResponseSchema>;

// --- Blacklist/Freeze tracker types ---

export const BLACKLIST_STABLECOINS = ["USDC", "USDT", "EURC", "PAXG", "XAUT"] as const;

export type BlacklistStablecoin = (typeof BLACKLIST_STABLECOINS)[number];
export type BlacklistEventType = "blacklist" | "unblacklist" | "destroy";

export interface BlacklistEvent {
  id: string; // "${chainId}-${txHash}-${logIndex}"
  stablecoin: BlacklistStablecoin;
  chainId: string;
  chainName: string;
  eventType: BlacklistEventType;
  address: string; // The affected address
  amount: number | null; // Only for "destroy" events (USD value)
  txHash: string;
  blockNumber: number;
  timestamp: number; // Unix seconds
  methodologyVersion: string;
  explorerTxUrl: string;
  explorerAddressUrl: string;
}

const BlacklistEventSchema = z.object({
  id: z.string(),
  stablecoin: z.enum(BLACKLIST_STABLECOINS),
  chainId: z.string(),
  chainName: z.string(),
  eventType: z.enum(["blacklist", "unblacklist", "destroy"]),
  address: z.string(),
  amount: z.number().nullable(),
  txHash: z.string(),
  blockNumber: z.number(),
  timestamp: z.number(),
  methodologyVersion: z.string(),
  explorerTxUrl: z.string(),
  explorerAddressUrl: z.string(),
});
export const BlacklistResponseSchema = z.object({
  events: z.array(BlacklistEventSchema),
  total: z.number(),
  methodology: MethodologyEnvelopeSchema.optional(),
});
export type BlacklistResponse = z.infer<typeof BlacklistResponseSchema>;

// ── Yield Intelligence ──────────────────────────────────────────────
export type YieldType =
  | "lending-vault"
  | "rebase"
  | "fee-sharing"
  | "lp-receipt"
  | "nav-appreciation"
  | "governance-set"
  | "lending-opportunity";
const YIELD_TYPE_VALUES = [
  "lending-vault",
  "rebase",
  "fee-sharing",
  "lp-receipt",
  "nav-appreciation",
  "governance-set",
  "lending-opportunity",
] as const;
const YieldTypeSchema = z.enum(YIELD_TYPE_VALUES);

interface YieldConfig {
  /** DeFiLlama pool UUID for deterministic matching */
  defiLlamaPoolId?: string;
  /** Human-readable yield source description */
  yieldSource: string;
  /** Yield mechanism type */
  yieldType: YieldType;
}

// Keep manual interface: schema uses z.string() for yieldType but the app relies on YieldType unions.
export interface AltYieldSource {
  sourceKey: string;
  yieldSource: string;
  yieldType: YieldType;
  currentApy: number;
  apy30d: number;
  sourceTvlUsd: number | null;
  dataSource: string;
}

export interface YieldBenchmarkMeta {
  rate: number;
  recordDate: string | null;
  fetchedAt: number | null;
  ageSeconds: number | null;
  source: string;
  isFallback: boolean;
  fallbackMode: string | null;
}

export interface YieldSourceInputMeta {
  mode: "dex-cache" | "direct-fetch" | "unavailable";
  updatedAt: number | null;
  ageSeconds: number | null;
  poolCount: number;
  fallbackMode: string | null;
}

export interface YieldSafetySnapshotMeta {
  kind: "ok" | "degraded";
  coverageRatio: number;
  coveredCount: number;
  trackedCount: number;
  reason: string | null;
}

export interface YieldRankingProvenance {
  sourceKey: string;
  sourceObservedAt: number;
  sourceAgeSeconds: number;
  confidenceTier: "deterministic" | "curated" | "discovered" | "fallback";
  selectionMethod: "confidence-weighted";
  selectionReason: string;
  sourceSwitch: boolean;
  previousBestSourceKey: string | null;
  usedLegacyHistory: boolean;
  usedDefaultSafety: boolean;
  benchmarkRecordDate: string | null;
  benchmarkIsFallback: boolean;
  benchmarkFallbackMode: string | null;
  anomalies: string[];
}

export interface YieldRankingsProvenance {
  selectionMethod: "confidence-weighted";
  benchmark: YieldBenchmarkMeta;
  dlPools: YieldSourceInputMeta;
  safetySnapshot: YieldSafetySnapshotMeta;
}

export interface YieldHistoryPoint {
  date: number | string;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  exchangeRate: number | null;
  sourceTvlUsd: number | null;
  warningSignals: string[];
  sourceKey?: string | null;
  yieldSource?: string | null;
  yieldType?: YieldType | null;
  dataSource?: string | null;
  isBest?: boolean;
  sourceSwitch?: boolean;
}

const AltYieldSourceSchema = z.object({
  sourceKey: z.string(),
  yieldSource: z.string(),
  yieldType: YieldTypeSchema,
  currentApy: z.number(),
  apy30d: z.number(),
  sourceTvlUsd: z.number().nullable(),
  dataSource: z.string(),
});

const YieldBenchmarkMetaSchema = z.object({
  rate: z.number(),
  recordDate: z.string().nullable(),
  fetchedAt: z.number().nullable(),
  ageSeconds: z.number().nullable(),
  source: z.string(),
  isFallback: z.boolean(),
  fallbackMode: z.string().nullable(),
});

const YieldSourceInputMetaSchema = z.object({
  mode: z.enum(["dex-cache", "direct-fetch", "unavailable"]),
  updatedAt: z.number().nullable(),
  ageSeconds: z.number().nullable(),
  poolCount: z.number(),
  fallbackMode: z.string().nullable(),
});

const YieldSafetySnapshotMetaSchema = z.object({
  kind: z.enum(["ok", "degraded"]),
  coverageRatio: z.number(),
  coveredCount: z.number(),
  trackedCount: z.number(),
  reason: z.string().nullable(),
});

const YieldRankingProvenanceSchema = z.object({
  sourceKey: z.string(),
  sourceObservedAt: z.number(),
  sourceAgeSeconds: z.number(),
  confidenceTier: z.enum(["deterministic", "curated", "discovered", "fallback"]),
  selectionMethod: z.literal("confidence-weighted"),
  selectionReason: z.string(),
  sourceSwitch: z.boolean(),
  previousBestSourceKey: z.string().nullable(),
  usedLegacyHistory: z.boolean(),
  usedDefaultSafety: z.boolean(),
  benchmarkRecordDate: z.string().nullable(),
  benchmarkIsFallback: z.boolean(),
  benchmarkFallbackMode: z.string().nullable(),
  anomalies: z.array(z.string()),
});

const YieldRankingsProvenanceSchema = z.object({
  selectionMethod: z.literal("confidence-weighted"),
  benchmark: YieldBenchmarkMetaSchema,
  dlPools: YieldSourceInputMetaSchema,
  safetySnapshot: YieldSafetySnapshotMetaSchema,
});

// Keep manual interface: includes YieldType and ReportCardGrade narrow unions not represented by schema strings.
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
  yieldType: YieldType;
  dataSource: string;
  sourceTvlUsd: number | null;
  pharosYieldScore: number | null;
  safetyScore: number | null;
  safetyGrade: ReportCardGrade | null;
  yieldToRisk: number | null;
  excessYield: number | null;
  yieldStability: number | null;
  apyVariance30d: number | null;
  apyMin30d: number | null;
  apyMax30d: number | null;
  warningSignals: string[];
  altSources: AltYieldSource[];
  provenance?: YieldRankingProvenance | null;
}

const YieldRankingSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  currentApy: z.number(),
  apy7d: z.number(),
  apy30d: z.number(),
  apyBase: z.number().nullable(),
  apyReward: z.number().nullable(),
  yieldSource: z.string(),
  yieldType: YieldTypeSchema,
  dataSource: z.string(),
  sourceTvlUsd: z.number().nullable(),
  pharosYieldScore: z.number().nullable(),
  safetyScore: z.number().nullable(),
  safetyGrade: ReportCardGradeSchema.nullable(),
  yieldToRisk: z.number().nullable(),
  excessYield: z.number().nullable(),
  yieldStability: z.number().nullable(),
  apyVariance30d: z.number().nullable(),
  apyMin30d: z.number().nullable(),
  apyMax30d: z.number().nullable(),
  warningSignals: z.array(z.string()),
  altSources: z.array(AltYieldSourceSchema).optional().default([]),
  provenance: YieldRankingProvenanceSchema.nullable().optional(),
});

// Keep manual interface: downstream callers expect rankings typed via YieldRanking with narrow unions.
export interface YieldRankingsResponse {
  rankings: YieldRanking[];
  riskFreeRate: number;
  scalingFactor: number;
  medianApy: number;
  updatedAt: number;
  provenance?: YieldRankingsProvenance | null;
}

export const YieldRankingsResponseSchema: z.ZodType<YieldRankingsResponse> = z.object({
  rankings: z.array(YieldRankingSchema),
  riskFreeRate: z.number(),
  scalingFactor: z.number(),
  medianApy: z.number(),
  updatedAt: z.number(),
  provenance: YieldRankingsProvenanceSchema.nullable().optional(),
});

// --- Mint/Burn Flow types ---

// Baseline-relative mint/burn pressure uses signed semantics: -100 (worsening) to +100 (improving).
const SignedFlowIntensitySchema = z.number().min(-100).max(100);
const PressureShiftStateSchema = z.enum(PRESSURE_SHIFT_STATE_VALUES);
const NetFlowDirection24hSchema = z.enum(NET_FLOW_DIRECTION_24H_VALUES);

const MintBurnGaugeSchema = z.object({
  score: SignedFlowIntensitySchema.nullable(),
  band: z.string().nullable(),
  intensitySemantics: z.enum(["midpoint-v1", "signed-v2"]).optional(),
  flightToQuality: z.boolean(),
  flightIntensity: z.number(),
  trackedCoins: z.number(),
  trackedMcapUsd: z.number(),
});
export type MintBurnGauge = z.infer<typeof MintBurnGaugeSchema>;

const MintBurnScopeSchema = z.object({
  chainIds: z.array(z.string()),
  label: z.string(),
});
export type MintBurnScope = z.infer<typeof MintBurnScopeSchema>;

const MintBurnSyncSchema = z.object({
  lastSuccessfulSyncAt: z.number().nullable(),
  freshnessStatus: z.enum(["fresh", "degraded", "stale"]),
  warning: z.string().nullable(),
  criticalLaneHealthy: z.boolean(),
});
export type MintBurnSync = z.infer<typeof MintBurnSyncSchema>;

const MintBurnCoverageStatusSchema = z.enum([
  "full",
  "partial-history",
  "lagging",
  "bootstrapping",
  "disabled",
]);
export type MintBurnCoverageStatus = z.infer<typeof MintBurnCoverageStatusSchema>;

const MintBurnCoinCoverageSchema = z.object({
  startBlock: z.number(),
  lastSyncedBlock: z.number().nullable(),
  lagBlocks: z.number().nullable(),
  historyStartAt: z.number().nullable(),
  has24hWindow: z.boolean(),
  has30dWindow: z.boolean(),
  has90dWindow: z.boolean(),
  isPartial: z.boolean(),
  status: MintBurnCoverageStatusSchema,
});
export type MintBurnCoinCoverage = z.infer<typeof MintBurnCoinCoverageSchema>;

const MintBurnCoinFlowSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  // Deprecated alias retained for one compatibility cycle.
  flowIntensity: SignedFlowIntensitySchema.nullable(),
  pressureShiftScore: SignedFlowIntensitySchema.nullable().optional(),
  pressureShiftState: PressureShiftStateSchema.optional(),
  netFlowDirection24h: NetFlowDirection24hSchema.optional(),
  has24hActivity: z.boolean().optional(),
  baselineDailyNetUsd: z.number().nullable().optional(),
  baselineDailyAbsUsd: z.number().nullable().optional(),
  baselineDataDays: z.number().nullable().optional(),
  netFlow24hUsd: z.number(),
  mintVolume24hUsd: z.number(),
  burnVolume24hUsd: z.number(),
  mintCount24h: z.number(),
  burnCount24h: z.number(),
  netFlow7dUsd: z.number(),
  netFlow30dUsd: z.number(),
  netFlow90dUsd: z.number(),
  largestEvent24h: z
    .object({
      direction: z.enum(["mint", "burn"]),
      amountUsd: z.number(),
      txHash: z.string(),
      timestamp: z.number(),
    })
    .nullable(),
  coverage: MintBurnCoinCoverageSchema.optional(),
});
export type MintBurnCoinFlow = z.infer<typeof MintBurnCoinFlowSchema>;

const MintBurnHourlyBucketSchema = z.object({
  hourTs: z.number(),
  netFlowUsd: z.number(),
  mintVolumeUsd: z.number(),
  burnVolumeUsd: z.number(),
});
export type MintBurnHourlyBucket = z.infer<typeof MintBurnHourlyBucketSchema>;

export const MintBurnFlowsResponseSchema = z.object({
  gauge: MintBurnGaugeSchema,
  coins: z.array(MintBurnCoinFlowSchema),
  hourly: z.array(MintBurnHourlyBucketSchema),
  updatedAt: z.number(),
  windowHours: z.number().int().positive().optional(),
  scope: MintBurnScopeSchema.optional(),
  sync: MintBurnSyncSchema.optional(),
});
export type MintBurnFlowsResponse = z.infer<typeof MintBurnFlowsResponseSchema>;

const MintBurnPerCoinChainSchema = z.object({
  chainId: z.string(),
  mintVolumeUsd: z.number(),
  burnVolumeUsd: z.number(),
  mintCount: z.number(),
  burnCount: z.number(),
  netFlowUsd: z.number(),
});

export const MintBurnPerCoinResponseSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  mintVolumeUsd: z.number(),
  burnVolumeUsd: z.number(),
  netFlowUsd: z.number(),
  mintCount: z.number(),
  burnCount: z.number(),
  chains: z.array(MintBurnPerCoinChainSchema),
  hourly: z.array(MintBurnHourlyBucketSchema),
  updatedAt: z.number(),
  windowHours: z.number().int().positive().optional(),
  scope: MintBurnScopeSchema.optional(),
  sync: MintBurnSyncSchema.optional(),
});
export type MintBurnPerCoinResponse = z.infer<typeof MintBurnPerCoinResponseSchema>;

const MintBurnFlowTypeSchema = z.enum(["standard", "atomic_roundtrip"]);

const MintBurnEventSchema = z.object({
  id: z.string(),
  stablecoinId: z.string(),
  symbol: z.string(),
  chainId: z.string(),
  direction: z.enum(["mint", "burn"]),
  flowType: MintBurnFlowTypeSchema,
  burnType: z.enum(["effective_burn", "bridge_burn", "review_required"]).nullable(),
  burnReviewReason: z.string().nullable(),
  amount: z.number(),
  amountUsd: z.number().nullable(),
  priceUsed: z.number().nullable(),
  priceTimestamp: z.number().nullable(),
  priceSource: z.string().nullable(),
  counterparty: z.string().nullable(),
  txHash: z.string(),
  blockNumber: z.number(),
  timestamp: z.number(),
  explorerTxUrl: z.string(),
});
export type MintBurnEvent = z.infer<typeof MintBurnEventSchema>;

export const MintBurnEventsResponseSchema = z.object({
  events: z.array(MintBurnEventSchema),
  total: z.number(),
});
export type MintBurnEventsResponse = z.infer<typeof MintBurnEventsResponseSchema>;

// --- Stress signals (DEWS) types ---

const SignalDetailSchema = z
  .object({
    value: z.number(),
    available: z.boolean(),
  })
  .passthrough();

const StressSignalEntrySchema = z.object({
  score: z.number(),
  band: z.string(),
  signals: z.record(z.string(), SignalDetailSchema),
  computedAt: z.number(),
  methodologyVersion: z.string(),
});

// Keep manual interface: SignalDetailSchema is passthrough and remains intentionally open-ended.
export interface StressSignalEntry {
  score: number;
  band: string;
  signals: Record<string, { value: number; available: boolean; [key: string]: unknown }>;
  computedAt: number;
  methodologyVersion: string;
}

export const StressSignalsAllResponseSchema = z.object({
  signals: z.record(z.string(), StressSignalEntrySchema),
  updatedAt: z.number(),
  malformedRows: z.number().optional(),
  methodology: MethodologyEnvelopeSchema,
});

// Keep manual interface: preserves explicit StressSignalEntry mapping while schema allows passthrough signal keys.
export interface StressSignalsAllResponse {
  signals: Record<string, StressSignalEntry>;
  updatedAt: number;
  malformedRows?: number;
  methodology: DepegDewsMethodology;
}

const StressSignalHistoryEntrySchema = z.object({
  date: z.number(),
  score: z.number(),
  band: z.string(),
  signals: z.record(z.string(), SignalDetailSchema),
  methodologyVersion: z.string(),
});

export const StressSignalDetailResponseSchema = z.object({
  current: StressSignalEntrySchema.nullable(),
  history: z.array(StressSignalHistoryEntrySchema),
  malformedRows: z.number().optional(),
  methodology: MethodologyEnvelopeSchema,
});

// Keep manual interface: retains explicit history entry shape for consumers while schema signal details are passthrough.
export interface StressSignalDetailResponse {
  current: StressSignalEntry | null;
  history: {
    date: number;
    score: number;
    band: string;
    signals: Record<string, { value: number; available: boolean; [key: string]: unknown }>;
    methodologyVersion: string;
  }[];
  methodology: DepegDewsMethodology;
}
