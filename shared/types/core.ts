import { z } from "zod";
import type { DependencyType } from "./dependency-types";
import type { LiveReservesConfig } from "./live-reserves";
export type { DependencyType } from "./dependency-types";
export { DEPENDENCY_TYPE_VALUES, DependencyTypeSchema } from "./dependency-types";

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
  rwa: boolean;
  navToken: boolean;
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
  chain: string;
  address: string;
  decimals: number;
}

export interface DependencyWeight {
  id: string;
  weight: number;
  type?: DependencyType;
}

export type ReserveRisk = "very-low" | "low" | "medium" | "high" | "very-high";

export interface ReserveSlice {
  name: string;
  pct: number;
  risk: ReserveRisk;
  coinId?: string;
  depType?: DependencyType;
}

export type ChainTier = "ethereum" | "stage1-l2" | "mature-alt-l1" | "established-alt-l1" | "unproven";
export type DeploymentModel = "single-chain" | "canonical-bridge" | "third-party-bridge" | "native-multichain";
export type CollateralQuality = "native" | "rwa" | "eth-lst" | "alt-lst-bridged-or-mixed" | "exotic";
export type CustodyModel = "onchain" | "institutional-top" | "institutional-regulated" | "institutional-unregulated" | "institutional-sanctioned" | "cex";

export type GovernanceQuality =
  | "immutable-code"
  | "dao-governance"
  | "multisig"
  | "regulated-entity"
  | "single-entity"
  | "wrapper";

export type ProtocolFamily = "liquity";
export type ProtocolVariant = "v1" | "v2" | "style";

export const GOVERNANCE_TYPE_VALUES = ["centralized", "centralized-dependent", "decentralized"] as const;
export const CHAIN_TIER_VALUES = ["ethereum", "stage1-l2", "mature-alt-l1", "established-alt-l1", "unproven"] as const;
export const DEPLOYMENT_MODEL_VALUES = ["single-chain", "canonical-bridge", "third-party-bridge", "native-multichain"] as const;
export const COLLATERAL_QUALITY_VALUES = ["native", "rwa", "eth-lst", "alt-lst-bridged-or-mixed", "exotic"] as const;
export const CUSTODY_MODEL_VALUES = ["onchain", "institutional-top", "institutional-regulated", "institutional-unregulated", "institutional-sanctioned", "cex"] as const;
export const GOVERNANCE_QUALITY_VALUES = [
  "immutable-code",
  "dao-governance",
  "multisig",
  "regulated-entity",
  "single-entity",
  "wrapper",
] as const;

export const GovernanceTypeSchema = z.enum(GOVERNANCE_TYPE_VALUES);
export const ChainTierSchema = z.enum(CHAIN_TIER_VALUES);
export const DeploymentModelSchema = z.enum(DEPLOYMENT_MODEL_VALUES);
export const CollateralQualitySchema = z.enum(COLLATERAL_QUALITY_VALUES);
export const CustodyModelSchema = z.enum(CUSTODY_MODEL_VALUES);
export const GovernanceQualitySchema = z.enum(GOVERNANCE_QUALITY_VALUES);

export interface CoinNotice {
  type: "danger" | "warning" | "info";
  title: string;
  message: string;
}

export type YieldType =
  | "lending-vault"
  | "rebase"
  | "fee-sharing"
  | "lp-receipt"
  | "nav-appreciation"
  | "governance-set"
  | "lending-opportunity";

export const YIELD_TYPE_VALUES = [
  "lending-vault",
  "rebase",
  "fee-sharing",
  "lp-receipt",
  "nav-appreciation",
  "governance-set",
  "lending-opportunity",
] as const;

export const YieldTypeSchema = z.enum(YIELD_TYPE_VALUES);

interface YieldConfig {
  defiLlamaPoolId?: string;
  yieldSource: string;
  yieldType: YieldType;
}

export type LaunchPhase = "announced" | "testnet" | "auditing" | "beta" | "launching-soon";

export type LaunchMilestoneType =
  | "announcement"
  | "milestone"
  | "delay"
  | "partnership"
  | "regulatory"
  | "audit"
  | "testnet";

export interface LaunchMilestone {
  date: string;
  type: LaunchMilestoneType;
  title: string;
  description?: string;
  sourceUrl?: string;
}

export interface DateHistoryEntry {
  date: string;
  setOn: string;
}

export type FeaturedContentType = "tweet" | "blog" | "video" | "article";

export interface FeaturedContent {
  type: FeaturedContentType;
  url: string;
  title: string;
  description?: string;
  image?: string;
  source?: string;
}

export interface StablecoinMeta {
  id: string;
  llamaId?: string;
  detailProvider?: "defillama" | "coingecko" | "commodity";
  name: string;
  symbol: string;
  flags: StablecoinFlags;
  collateral?: string;
  pegMechanism?: string;
  commodityOunces?: number;
  geckoId?: string;
  cmcSlug?: string;
  pythFeedId?: string;
  protocolSlug?: string;
  proofOfReserves?: ProofOfReserves;
  links?: StablecoinLink[];
  jurisdiction?: Jurisdiction;
  contracts?: ContractDeployment[];
  tradedContracts?: ContractDeployment[];
  dependencies?: DependencyWeight[];
  canBeBlacklisted?: boolean | "possible";
  chainTier?: ChainTier;
  deploymentModel?: DeploymentModel;
  collateralQuality?: CollateralQuality;
  custodyModel?: CustodyModel;
  governanceQuality?: GovernanceQuality;
  protocolFamily?: ProtocolFamily;
  protocolVariant?: ProtocolVariant;
  reserves?: ReserveSlice[];
  liveReservesConfig?: LiveReservesConfig;
  notices?: CoinNotice[];
  tags?: string[];
  yieldConfig?: YieldConfig;
  status?: "pre-launch" | "active";
  announcedDate?: string;
  expectedLaunchDate?: string;
  launchPhase?: LaunchPhase;
  launchPhaseDetail?: string;
  featuredContent?: FeaturedContent[];
  milestones?: LaunchMilestone[];
  dateHistory?: DateHistoryEntry[];
}

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
  | "algorithmic"
  | "liquity-family"
  | "liquity-v1"
  | "liquity-v2"
  | "liquity-style"
  | "grade-a"
  | "grade-ge-b"
  | "grade-ge-c-plus"
  | "grade-ge-c-minus"
  | "grade-le-d";

export const OTHER_PEG_TAGS: FilterTag[] = [
  "chf-peg",
  "gbp-peg",
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
  "liquity-family": "Liquity",
  "liquity-v1": "Liquity v1",
  "liquity-v2": "Liquity v2",
  "liquity-style": "Liquity-Style",
  "grade-a": "A",
  "grade-ge-b": "≥B",
  "grade-ge-c-plus": "≥C+",
  "grade-ge-c-minus": "≥C-",
  "grade-le-d": "≤D",
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
  if (meta.protocolFamily === "liquity") {
    tags.push("liquity-family");
    switch (meta.protocolVariant) {
      case "v1":
        tags.push("liquity-v1");
        break;
      case "v2":
        tags.push("liquity-v2");
        break;
      case "style":
        tags.push("liquity-style");
        break;
      default:
        break;
    }
  }
  return tags;
}

/** Grade filter tags that require reportCards data to evaluate */
export const GRADE_FILTER_TAGS: FilterTag[] = [
  "grade-a",
  "grade-ge-b",
  "grade-ge-c-plus",
  "grade-ge-c-minus",
  "grade-le-d",
];

/** Grade ranking for comparison (higher is better) */
const GRADE_RANK: Record<string, number> = {
  "A+": 12,
  "A": 11,
  "A-": 10,
  "B+": 9,
  "B": 8,
  "B-": 7,
  "C+": 6,
  "C": 5,
  "C-": 4,
  "D+": 3,
  "D": 2,
  "D-": 1,
  "F": 0,
};

/** Check if a grade meets the filter threshold */
export function gradeMatchesFilter(grade: string | undefined, filterTag: FilterTag): boolean {
  if (!grade) return false;
  const gradeValue = GRADE_RANK[grade] ?? -1;

  switch (filterTag) {
    case "grade-a":
      return grade.startsWith("A");
    case "grade-ge-b":
      return gradeValue >= GRADE_RANK["B"];
    case "grade-ge-c-plus":
      return gradeValue >= GRADE_RANK["C+"];
    case "grade-ge-c-minus":
      return gradeValue >= GRADE_RANK["C-"];
    case "grade-le-d":
      return gradeValue <= GRADE_RANK["D"];
    default:
      return false;
  }
}

export type PriceConfidence = "high" | "single-source" | "low" | "fallback";
export type PriceObservedAtMode = "upstream" | "local_fetch" | "unknown";
export type DepegPrimaryTrust = "authoritative" | "confirm_required" | "unusable";

export const PriceConfidenceSchema = z.enum(["high", "single-source", "low", "fallback"]);
export const PriceObservedAtModeSchema = z.enum(["upstream", "local_fetch", "unknown"]);
export const DepegPrimaryTrustSchema = z.enum(["authoritative", "confirm_required", "unusable"]);

export interface PegAssetBase {
  id: string;
  symbol: string;
  price?: number | null;
  priceSource?: string | null;
  priceConfidence?: PriceConfidence | null;
  priceUpdatedAt?: number | null;
  priceObservedAt?: number | null;
  priceObservedAtMode?: PriceObservedAtMode | null;
  priceSyncedAt?: number | null;
  consensusSources?: string[];
  agreeSources?: string[];
  pegType?: string;
  circulating?: Record<string, number>;
}

export type BluechipGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F";

const BLUECHIP_GRADE_VALUES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"] as const;
export const BluechipGradeSchema = z.enum(BLUECHIP_GRADE_VALUES);

export const MethodologyEnvelopeSchema = z.object({
  version: z.string(),
  versionLabel: z.string(),
  currentVersion: z.string(),
  currentVersionLabel: z.string(),
  changelogPath: z.string(),
  asOf: z.number(),
  isCurrent: z.boolean(),
});

export type MethodologyEnvelope = z.infer<typeof MethodologyEnvelopeSchema>;
