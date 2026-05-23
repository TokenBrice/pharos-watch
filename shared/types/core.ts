import { z } from "zod";
import type { DependencyType } from "./dependency-types";
import type { LiveReservesConfig } from "./live-reserves";
import type { CauseOfDeath } from "./cause-of-death";
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
  "INR",
  "MYR",
  "SGD",
  "HKD",
  "TRY",
  "AUD",
  "ZAR",
  "CAD",
  "CNY",
  "CNH",
  "PHP",
  "MXN",
  "VND",
  "UAH",
  "ARS",
  "KGS",
  "NGN",
  "XOF",
  "GOLD",
  "SILVER",
  "VAR",
  "OTHER",
] as const;
export type PegCurrency = (typeof PEG_CURRENCY_VALUES)[number];

/** Governance model */
export const GOVERNANCE_TYPE_VALUES = ["centralized", "centralized-dependent", "decentralized"] as const;
export type GovernanceType = (typeof GOVERNANCE_TYPE_VALUES)[number];

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

export const ATTESTOR_TIER_VALUES = ["big4", "regional", "niche", "self", "none"] as const;
export type AttestorTier = (typeof ATTESTOR_TIER_VALUES)[number];

export const PROOF_OF_RESERVES_CADENCE_VALUES = [
  "daily-nav",
  "real-time",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "semi-annual",
  "annual",
  "ad-hoc",
  "none",
] as const;
export type ProofOfReservesCadence = (typeof PROOF_OF_RESERVES_CADENCE_VALUES)[number];

export interface ProofOfReserves {
  type: ProofOfReservesType;
  url: string;
  provider?: string;
  attestorTier?: AttestorTier;
  cadence?: ProofOfReservesCadence;
  attestorJurisdiction?: string;
  attestorLicense?: string;
}

export interface StablecoinLink {
  label: string;
  url: string;
}

export type BlacklistabilityStatus = boolean | "possible" | "dilutable";
export type BlacklistabilityReviewStatus = BlacklistabilityStatus | "inherited";

export interface BlacklistabilityReview {
  reviewedStatus: BlacklistabilityReviewStatus;
  sources?: StablecoinLink[];
  sourceFreeRationale?: string;
  evidence: string;
  reviewer: string;
  reviewedAt: string;
  upstreamSuppressionRationale?: string;
}

export interface Jurisdiction {
  country: string;
  regulator?: string;
  license?: string;
}

export const MICA_STATUS_VALUES = [
  "authorized",
  "pending",
  "transitional",
  "non-compliant",
  "out-of-scope",
] as const;
export type MicaStatus = (typeof MICA_STATUS_VALUES)[number];

export const MICA_TOKEN_TYPE_VALUES = ["EMT", "ART"] as const;
export type MicaTokenType = (typeof MICA_TOKEN_TYPE_VALUES)[number];

export const MICA_AUTHORIZATION_TYPE_VALUES = ["emi", "credit-institution"] as const;
export type MicaAuthorizationType = (typeof MICA_AUTHORIZATION_TYPE_VALUES)[number];

export interface MicaProfile {
  status: MicaStatus;
  tokenType?: MicaTokenType;
  authorizationType?: MicaAuthorizationType;
  competentAuthority?: string;
  authorizedEntity?: string;
  significant?: boolean;
  references?: StablecoinLink[];
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

export const CHAIN_TIER_VALUES = ["ethereum", "stage1-l2", "mature-alt-l1", "established-alt-l1", "unproven"] as const;
export type ChainTier = (typeof CHAIN_TIER_VALUES)[number];

export const DEPLOYMENT_MODEL_VALUES = ["single-chain", "canonical-bridge", "third-party-bridge", "native-multichain"] as const;
export type DeploymentModel = (typeof DEPLOYMENT_MODEL_VALUES)[number];

export const COLLATERAL_QUALITY_VALUES = ["native", "rwa", "eth-lst", "alt-lst-bridged-or-mixed", "exotic"] as const;
export type CollateralQuality = (typeof COLLATERAL_QUALITY_VALUES)[number];

export const CUSTODY_MODEL_VALUES = ["onchain", "institutional-top", "institutional-regulated", "institutional-unregulated", "institutional-sanctioned", "cex"] as const;
export type CustodyModel = (typeof CUSTODY_MODEL_VALUES)[number];

export const GOVERNANCE_QUALITY_VALUES = [
  "immutable-code",
  "dao-governance",
  "multisig",
  "regulated-entity",
  "single-entity",
  "wrapper",
] as const;
export type GovernanceQuality = (typeof GOVERNANCE_QUALITY_VALUES)[number];

export const INFRASTRUCTURE_VALUES = ["liquity-v1", "liquity-v2", "m0"] as const;
export type Infrastructure = (typeof INFRASTRUCTURE_VALUES)[number];

export const INFRASTRUCTURE_LABELS: Record<Infrastructure, string> = {
  "liquity-v1": "Liquity v1",
  "liquity-v2": "Liquity v2",
  "m0": "M0",
};

export const VARIANT_KIND_VALUES = ["savings-passthrough", "strategy-vault", "risk-absorption", "bond-maturity"] as const;
export type VariantKind = (typeof VARIANT_KIND_VALUES)[number];
export const MECHANISM_ARCHETYPE_VALUES = [
  "fiat-cash",
  "tbill",
  "cdp",
  "synthetic-delta-neutral",
  "algorithmic",
  "rwa-credit-fund",
] as const;
export type MechanismArchetype = (typeof MECHANISM_ARCHETYPE_VALUES)[number];
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

export const DETAIL_PROVIDER_VALUES = ["defillama", "coingecko", "commodity"] as const;
export type DetailProvider = (typeof DETAIL_PROVIDER_VALUES)[number];
export const DetailProviderSchema = z.enum(DETAIL_PROVIDER_VALUES);

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
  detailProvider?: DetailProvider;
  name: string;
  symbol: string;
  oneLiner?: string;
  flags: StablecoinFlags;
  pegReferenceId?: string;
  collateral?: string;
  pegMechanism?: string;
  mechanismArchetype?: MechanismArchetype;
  commodityOunces?: number;
  geckoId?: string;
  cmcSlug?: string;
  pythFeedId?: string;
  protocolSlug?: string;
  proofOfReserves?: ProofOfReserves;
  links?: StablecoinLink[];
  jurisdiction?: Jurisdiction;
  mica?: MicaProfile;
  contracts?: ContractDeployment[];
  tradedContracts?: ContractDeployment[];
  dependencies?: DependencyWeight[];
  canBeBlacklisted?: BlacklistabilityStatus;
  canBeBlacklistedSource?: StablecoinLink;
  blacklistabilityReview?: BlacklistabilityReview;
  chainTier?: ChainTier;
  deploymentModel?: DeploymentModel;
  collateralQuality?: CollateralQuality;
  custodyModel?: CustodyModel;
  governanceQuality?: GovernanceQuality;
  infrastructures?: Infrastructure[];
  variantOf?: string;
  variantKind?: VariantKind;
  /** When true, this coin's mechanismArchetype is an intentional departure from its parent's archetype. */
  archetypeOverride?: boolean;
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

type PegCurrencyFilterTag = `${Lowercase<PegCurrency>}-peg`;
type InfrastructureFilterTag = `infrastructure-${Infrastructure}`;
type VariantFilterTag = "variant-tracked" | `variant-${VariantKind}`;
type PegGroupFilterTag = "fiat-non-usd-peg" | "commodity-peg";
type GradeFilterTag =
  | "grade-a"
  | "grade-ge-b"
  | "grade-ge-c"
  | "grade-ge-c-plus"
  | "grade-ge-c-minus"
  | "grade-le-d";

export type FilterTag =
  | PegCurrencyFilterTag
  | PegGroupFilterTag
  | GovernanceType
  | BackingType
  | InfrastructureFilterTag
  | VariantFilterTag
  | GradeFilterTag;

export type PriceConfidence = "high" | "single-source" | "low" | "fallback";
export type PriceObservedAtMode = "upstream" | "local_fetch" | "unknown";
export type DepegPrimaryTrust = "authoritative" | "confirm_required" | "unusable";

export const PriceConfidenceSchema = z.enum(["high", "single-source", "low", "fallback"]);
export const PriceObservedAtModeSchema = z.enum(["upstream", "local_fetch", "unknown"]);
export const DepegPrimaryTrustSchema = z.enum(["authoritative", "confirm_required", "unusable"]);

export interface PriceSourceConfidenceProfile {
  activeDexLanes: number;
  freshestDexLaneAgeSec: number | null;
  aggregateLaneOnly: boolean;
}

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
  priceSourceConfidenceProfile?: PriceSourceConfidenceProfile | null;
  pegType?: string;
  circulating?: Record<string, number>;
}

export type BluechipGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F";

const BLUECHIP_GRADE_VALUES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"] as const;
export const BluechipGradeSchema = z.enum(BLUECHIP_GRADE_VALUES);

export { MethodologyEnvelopeSchema, type MethodologyEnvelope } from "./methodology-envelope";
