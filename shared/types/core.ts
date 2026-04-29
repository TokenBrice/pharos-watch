import { z } from "zod";
import type { DependencyType } from "./dependency-types";
import type { LiveReservesConfig } from "./live-reserves";
import type { CauseOfDeath } from "../lib/cause-of-death";
import type { ReserveSlice } from "./reserves";
export type { DependencyType } from "./dependency-types";
export type { ReserveRisk, ReserveSlice } from "./reserves";
export { RESERVE_RISK_VALUES, ReserveRiskSchema } from "./reserves";
export { DEPENDENCY_TYPE_VALUES, DependencyTypeSchema } from "./dependency-types";

// --- Flag-based classification ---

/** Backing mechanism */
export const BACKING_TYPE_VALUES = ["rwa-backed", "crypto-backed", "algorithmic"] as const;
export type BackingType = (typeof BACKING_TYPE_VALUES)[number];

/** Peg currency */
export const PEG_CURRENCY_VALUES = [
  "USD",
  "EUR",
  "GBP",
  "CHF",
  "BRL",
  "RUB",
  "JPY",
  "KRW",
  "IDR",
  "MYR",
  "SGD",
  "TRY",
  "AUD",
  "ZAR",
  "CAD",
  "CNY",
  "CNH",
  "PHP",
  "MXN",
  "UAH",
  "ARS",
  "GOLD",
  "SILVER",
  "VAR",
  "OTHER",
] as const;
export type PegCurrency = (typeof PEG_CURRENCY_VALUES)[number];

/** Governance model */
export type GovernanceType = "centralized" | "centralized-dependent" | "decentralized";

export interface StablecoinFlags {
  backing: BackingType;
  pegCurrency: PegCurrency;
  governance: GovernanceType;
  yieldBearing: boolean;
  rwa: boolean;
  navToken: boolean;
}

export const PROOF_OF_RESERVES_TYPE_VALUES = ["independent-audit", "real-time", "self-reported"] as const;
export type ProofOfReservesType = (typeof PROOF_OF_RESERVES_TYPE_VALUES)[number];

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
  chain: string;
  address: string;
  decimals: number;
}

export interface DependencyWeight {
  id: string;
  weight: number;
  type?: DependencyType;
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

export type Infrastructure = "liquity-v1" | "liquity-v2" | "m0";

export const INFRASTRUCTURE_VALUES = ["liquity-v1", "liquity-v2", "m0"] as const;

export const INFRASTRUCTURE_LABELS: Record<Infrastructure, string> = {
  "liquity-v1": "Liquity v1",
  "liquity-v2": "Liquity v2",
  "m0": "M0",
};

export const GOVERNANCE_TYPE_VALUES = ["centralized", "centralized-dependent", "decentralized"] as const;
export const CHAIN_TIER_VALUES = ["ethereum", "stage1-l2", "mature-alt-l1", "established-alt-l1", "unproven"] as const;
export const DEPLOYMENT_MODEL_VALUES = ["single-chain", "canonical-bridge", "third-party-bridge", "native-multichain"] as const;
export const COLLATERAL_QUALITY_VALUES = ["native", "rwa", "eth-lst", "alt-lst-bridged-or-mixed", "exotic"] as const;
export const CUSTODY_MODEL_VALUES = ["onchain", "institutional-top", "institutional-regulated", "institutional-unregulated", "institutional-sanctioned", "cex"] as const;
export const VARIANT_KIND_VALUES = ["savings-passthrough", "strategy-vault", "risk-absorption", "bond-maturity"] as const;
export type VariantKind = (typeof VARIANT_KIND_VALUES)[number];
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

export const COIN_NOTICE_TYPE_VALUES = ["danger", "warning", "info"] as const;
export type CoinNoticeType = (typeof COIN_NOTICE_TYPE_VALUES)[number];

export interface CoinNotice {
  type: CoinNoticeType;
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

export interface YieldConfig {
  defiLlamaPoolId?: string;
  yieldSource: string;
  yieldType: YieldType;
}

export const LAUNCH_PHASE_VALUES = ["announced", "testnet", "auditing", "beta", "launching-soon"] as const;
export type LaunchPhase = (typeof LAUNCH_PHASE_VALUES)[number];

export const LAUNCH_MILESTONE_TYPE_VALUES = [
  "announcement",
  "milestone",
  "delay",
  "partnership",
  "regulatory",
  "audit",
  "testnet",
] as const;
export type LaunchMilestoneType = (typeof LAUNCH_MILESTONE_TYPE_VALUES)[number];

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

export const FEATURED_CONTENT_TYPE_VALUES = ["tweet", "blog", "video", "article"] as const;
export type FeaturedContentType = (typeof FEATURED_CONTENT_TYPE_VALUES)[number];

export interface FeaturedContent {
  type: FeaturedContentType;
  url: string;
  title: string;
  description?: string;
  image?: string;
  source?: string;
}

export const STABLECOIN_STATUS_VALUES = ["pre-launch", "active", "frozen"] as const;
export type StablecoinStatus = (typeof STABLECOIN_STATUS_VALUES)[number];

export interface StablecoinObituary {
  /** Cemetery cause-of-death enum, shared with `DeadStablecoin`. */
  causeOfDeath: CauseOfDeath;
  /** YYYY-MM or YYYY-MM-DD; precision must match `dead-stablecoins.json` entries. */
  deathDate: string;
  /** Headline shown in detail-page banner and cemetery tombstone. */
  epitaph: string;
  /** Full obituary paragraph — collapsible in the banner. */
  obituary: string;
  /** Computed at freeze time from `MAX(circulating_usd)` over preserved supply_history. */
  peakMcap?: number;
  sourceUrl: string;
  sourceLabel: string;
}

export interface StablecoinMeta {
  id: string;
  llamaId?: string;
  detailProvider?: "defillama" | "coingecko" | "commodity";
  name: string;
  symbol: string;
  flags: StablecoinFlags;
  pegReferenceId?: string;
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
  infrastructures?: Infrastructure[];
  variantOf?: string;
  variantKind?: VariantKind;
  reserves?: ReserveSlice[];
  liveReservesConfig?: LiveReservesConfig;
  notices?: CoinNotice[];
  tags?: string[];
  yieldConfig?: YieldConfig;
  status?: StablecoinStatus;
  /** YYYY-MM-DD; required when status === "frozen". */
  frozenAt?: string;
  /** Obituary content surfaced on the detail page banner and cemetery tombstone; required when status === "frozen". */
  obituary?: StablecoinObituary;
  launchDate?: string;
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
  | "fiat-non-usd-peg"
  | "commodity-peg"
  | "eur-peg"
  | "gold-peg"
  | "chf-peg"
  | "gbp-peg"
  | "brl-peg"
  | "rub-peg"
  | "jpy-peg"
  | "krw-peg"
  | "idr-peg"
  | "myr-peg"
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
  | "infrastructure-liquity-v1"
  | "infrastructure-liquity-v2"
  | "infrastructure-m0"
  | "variant-tracked"
  | "variant-savings-passthrough"
  | "variant-strategy-vault"
  | "variant-risk-absorption"
  | "variant-bond-maturity"
  | "grade-a"
  | "grade-ge-b"
  | "grade-ge-c"
  | "grade-ge-c-plus"
  | "grade-ge-c-minus"
  | "grade-le-d";

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

export { MethodologyEnvelopeSchema, type MethodologyEnvelope } from "./methodology-envelope";
