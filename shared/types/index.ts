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

/** Configures how on-chain circulating supply is computed for a stablecoin */
interface SupplyMethodConfig {
  type:
    | "totalSupply" // Default: raw totalSupply() is circulating
    | "totalSupply-minus-addresses" // totalSupply() - sum(balanceOf(addr)) per chain
    | "custom-contract" // Call a dedicated circulating supply contract
    | "exclude"; // Skip on-chain supply for this token

  /** For totalSupply-minus-addresses: addresses whose balanceOf() to subtract */
  subtractAddresses?: { chain: string; address: string }[];

  /** For custom-contract: dedicated contract returning circulating supply */
  customContract?: {
    chain: string; // Chain where the contract lives
    address: string; // Contract address
    selector: string; // Function selector (e.g., "0x9e2bf22c")
    decimals: number; // Decimals for the return value
  };
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

/** Important notice displayed on a stablecoin's detail page */
export interface CoinNotice {
  type: "danger" | "warning" | "info";
  title: string;
  message: string;
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
  supplyMethod?: SupplyMethodConfig; // How to compute circulating supply (default: totalSupply)
  dependencies?: DependencyWeight[]; // Upstream stablecoins with collateral weights (CeFi-Dependent coins only)
  canBeBlacklisted?: boolean | "possible"; // true = active blacklist, "possible" = mutable contract / governance-upgradeable, false/undefined = no
  chainTier?: ChainTier;
  deploymentModel?: DeploymentModel;
  collateralQuality?: CollateralQuality;
  custodyModel?: CustodyModel;
  governanceQuality?: GovernanceQuality;
  reserves?: ReserveSlice[]; // Structured reserve composition (manually curated)
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
  supplySource: z.string().optional(),
  circulating: PegBucketsSchema,
  circulatingPrevDay: PegBucketsSchema.nullish(),
  circulatingPrevWeek: PegBucketsSchema.nullish(),
  circulatingPrevMonth: PegBucketsSchema.nullish(),
  chainCirculating: ChainCirculatingSchema,
  chains: z.array(z.string()),
});

export const StablecoinDataSchema = StablecoinDataRawSchema.transform((asset) => ({
  id: asset.id,
  name: asset.name,
  symbol: asset.symbol,
  geckoId: asset.geckoId ?? asset.gecko_id ?? null,
  pegType: asset.pegType,
  pegMechanism: asset.pegMechanism,
  price: asset.price,
  priceSource: asset.priceSource,
  priceConfidence: asset.priceConfidence ?? null,
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

export const DexLiquidityPoolSchema = z.object({
  project: z.string(),
  chain: z.string(),
  tvlUsd: z.number(),
  symbol: z.string(),
  volumeUsd1d: z.number(),
  poolType: z.string(),
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

export const DexPriceSourceSchema = z.object({
  protocol: z.string(),
  chain: z.string(),
  price: z.number(),
  tvl: z.number(),
});

export const DexLiquidityDataSchema = z.object({
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
  scoreComponents: z
    .object({
      tvlDepth: z.number(),
      volumeActivity: z.number(),
      poolQuality: z.number(),
      durability: z.number(),
      pairDiversity: z.number(),
      crossChain: z.number(),
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
  methodologyVersion: string;
}

export type DexLiquidityMap = Record<string, DexLiquidityData>;
export const DexLiquidityMapSchema = z.record(z.string(), DexLiquidityDataSchema);

/** Sentinel key for global deduped aggregates in DexLiquidityMap */
export const DEX_GLOBAL_KEY = "__global__";

// --- Report Card types ---

export type ReportCardGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F" | "NR";

export interface SafetyScoreHistoryPoint {
  date: number;
  grade: ReportCardGrade;
  score: number | null;
  prevGrade: ReportCardGrade | null;
  prevScore: number | null;
  methodologyVersion: string;
}

export const SafetyScoreHistoryPointSchema = z.object({
  date: z.number(),
  grade: z.string(),
  score: z.number().nullable(),
  prevGrade: z.string().nullable(),
  prevScore: z.number().nullable(),
  methodologyVersion: z.string(),
});

export const SafetyScoreHistoryResponseSchema = z.array(SafetyScoreHistoryPointSchema);
export type SafetyScoreHistoryResponse = SafetyScoreHistoryPoint[];

export interface ReportCardDimension {
  grade: ReportCardGrade;
  score: number | null; // 0-100, null if NR
  detail: string; // Human-readable explanation
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

export const ReportCardsResponseSchema = z.object({
  cards: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      symbol: z.string(),
      overallGrade: z.string(),
      overallScore: z.number().nullable(),
      baseScore: z.number().nullable(),
      dimensions: z.record(
        z.string(),
        z.object({
          grade: z.string(),
          score: z.number().nullable(),
          detail: z.string(),
        }),
      ),
      ratedDimensions: z.number(),
      rawInputs: z
        .object({
          dependencies: z.array(z.object({ id: z.string() }).passthrough()),
          navToken: z.boolean(),
          governanceTier: z.string(),
        })
        .passthrough(),
      dependencies: z.array(z.object({ id: z.string() }).passthrough()).optional(),
      isDefunct: z.boolean(),
    }),
  ),
  methodology: z.object({
    version: z.string(),
    weights: z.record(z.string(), z.number()),
    pegMultiplierExponent: z.number(),
    thresholds: z.array(z.object({ grade: z.string(), min: z.number() })),
  }),
  dependencyGraph: z.object({
    edges: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
  updatedAt: z.number(),
});
// Keep hand-written interface — the Zod schema uses z.string() for grades/dimensions
// but downstream code needs the narrow ReportCardGrade / DimensionKey types.
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

// --- Stability Index types ---

export const MethodologyEnvelopeSchema = z.object({
  version: z.string(),
  versionLabel: z.string(),
  currentVersion: z.string(),
  currentVersionLabel: z.string(),
  changelogPath: z.string(),
  asOf: z.number(),
  isCurrent: z.boolean(),
});

export const StabilityIndexComponentsSchema = z.object({
  severity: z.number(),
  breadth: z.number(),
  stressBreadth: z.number().optional(),
  trend: z.number(),
});

export const StabilityContributorSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  bps: z.number(),
  mcapUsd: z.number(),
  ageDays: z.number(),
  factor: z.number(),
});

export const StabilityIndexCurrentSchema = z.object({
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

export const StabilityIndexHistoryPointSchema = z.object({
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

export interface CronRun {
  startedAt: number;
  durationMs: number;
  status: string;
  error?: string;
  itemCount?: number;
  metadata?: Record<string, unknown>;
}

export interface CronStatus {
  lastRun: CronRun | null;
  recentRuns: CronRun[];
  expectedIntervalSec: number;
  healthy: boolean;
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

export interface DatasetFreshness {
  stablecoins: number | null;
  blacklist: number | null;
  mintBurn: number | null;
  supply: number | null;
  yield: number | null;
  depegs: number | null;
  dews: number | null;
  digest: number | null;
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
  datasetFreshness: DatasetFreshness;
  summary: {
    unhealthyCrons: number;
    degradedCrons: number;
    cronErrors: number;
    worstCacheRatio: number;
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

export interface HealthResponse {
  status: "healthy" | "degraded" | "stale";
  timestamp: number;
  caches: Record<string, CacheStatus>;
  blacklist: { totalEvents: number; missingAmounts: number };
  mintBurn: { totalEvents: number };
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

export const DepegEventSchema = z.object({
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

export type DepegDewsMethodology = z.infer<typeof MethodologyEnvelopeSchema>;

export const PegSummaryCoinSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegType: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  currentDeviationBps: z.number().nullable(),
  pegScore: z.number().nullable(),
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

export const PegSummaryStatsSchema = z.object({
  activeDepegCount: z.number(),
  medianDeviationBps: z.number(),
  worstCurrent: z.object({ id: z.string(), symbol: z.string(), bps: z.number() }).nullable(),
  coinsAtPeg: z.number(),
  totalTracked: z.number(),
  depegEventsToday: z.number(),
  depegEventsYesterday: z.number(),
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

export const BlacklistEventSchema = z.object({
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

export interface YieldConfig {
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

export const AltYieldSourceSchema = z.object({
  sourceKey: z.string(),
  yieldSource: z.string(),
  yieldType: z.string(),
  currentApy: z.number(),
  apy30d: z.number(),
  sourceTvlUsd: z.number().nullable(),
  dataSource: z.string(),
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
}

export const YieldRankingSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  currentApy: z.number(),
  apy7d: z.number(),
  apy30d: z.number(),
  apyBase: z.number().nullable(),
  apyReward: z.number().nullable(),
  yieldSource: z.string(),
  yieldType: z.string(),
  dataSource: z.string(),
  sourceTvlUsd: z.number().nullable(),
  pharosYieldScore: z.number().nullable(),
  safetyScore: z.number().nullable(),
  safetyGrade: z.string().nullable(),
  yieldToRisk: z.number().nullable(),
  excessYield: z.number().nullable(),
  yieldStability: z.number().nullable(),
  apyVariance30d: z.number().nullable(),
  apyMin30d: z.number().nullable(),
  apyMax30d: z.number().nullable(),
  warningSignals: z.array(z.string()),
  altSources: z.array(AltYieldSourceSchema).optional().default([]),
});

// Keep manual interface: downstream callers expect rankings typed via YieldRanking with narrow unions.
export interface YieldRankingsResponse {
  rankings: YieldRanking[];
  riskFreeRate: number;
  scalingFactor: number;
  updatedAt: number;
}

export const YieldRankingsResponseSchema = z.object({
  rankings: z.array(YieldRankingSchema),
  riskFreeRate: z.number(),
  scalingFactor: z.number(),
  updatedAt: z.number(),
});

// --- Mint/Burn Flow types ---

// Baseline-relative mint/burn pressure uses signed semantics: -100 (worsening) to +100 (improving).
const SignedFlowIntensitySchema = z.number().min(-100).max(100);
const PressureShiftStateSchema = z.enum(PRESSURE_SHIFT_STATE_VALUES);
const NetFlowDirection24hSchema = z.enum(NET_FLOW_DIRECTION_24H_VALUES);

export const MintBurnGaugeSchema = z.object({
  score: SignedFlowIntensitySchema.nullable(),
  band: z.string().nullable(),
  intensitySemantics: z.enum(["midpoint-v1", "signed-v2"]).optional(),
  flightToQuality: z.boolean(),
  flightIntensity: z.number(),
  trackedCoins: z.number(),
  trackedMcapUsd: z.number(),
});
export type MintBurnGauge = z.infer<typeof MintBurnGaugeSchema>;

export const MintBurnCoinFlowSchema = z.object({
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
});
export type MintBurnCoinFlow = z.infer<typeof MintBurnCoinFlowSchema>;

export const MintBurnHourlyBucketSchema = z.object({
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
});
export type MintBurnFlowsResponse = z.infer<typeof MintBurnFlowsResponseSchema>;

export const MintBurnPerCoinChainSchema = z.object({
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
});
export type MintBurnPerCoinResponse = z.infer<typeof MintBurnPerCoinResponseSchema>;

export interface MintBurnEvent {
  id: string;
  stablecoinId: string;
  symbol: string;
  chainId: string;
  direction: "mint" | "burn";
  burnType: "effective_burn" | "bridge_burn" | "review_required" | null;
  burnReviewReason: string | null;
  amount: number;
  amountUsd: number | null;
  priceUsed?: number | null;
  priceTimestamp?: number | null;
  priceSource?: string | null;
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

// --- Stress signals (DEWS) types ---

export const SignalDetailSchema = z
  .object({
    value: z.number(),
    available: z.boolean(),
  })
  .passthrough();

export const StressSignalEntrySchema = z.object({
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

export const StressSignalHistoryEntrySchema = z.object({
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
