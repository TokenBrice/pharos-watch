import { z } from "zod";
import type { DependencyType, V9DependencyEconomicRole } from "./dependency-types";
import type { LiveReservesConfig } from "./live-reserves";
import type { CauseOfDeath } from "./cause-of-death";
import type { ReserveSlice } from "./reserves";
import {
  GOVERNANCE_TYPE_VALUES,
  type GovernanceType,
  type MechanismArchetype,
  type StablecoinExitMechanism,
  type StablecoinPriceBasis,
  type StablecoinStatus,
} from "./stablecoin-taxonomy";
export type { DependencyType } from "./dependency-types";
export type { V9DependencyEconomicRole } from "./dependency-types";
export type {
  ReserveAssetClass,
  ReserveBlacklistabilityExposure,
  ReserveLiquidityHorizon,
  ReserveRisk,
  ReserveRiskFactor,
  ReserveSlice,
} from "./reserves";
export {
  GOVERNANCE_TYPE_VALUES,
  MECHANISM_ARCHETYPE_VALUES,
  STABLECOIN_EXIT_MECHANISM_VALUES,
  STABLECOIN_PRICE_BASIS_VALUES,
  STABLECOIN_STATUS_VALUES,
} from "./stablecoin-taxonomy";
export type {
  GovernanceType,
  MechanismArchetype,
  StablecoinExitMechanism,
  StablecoinPriceBasis,
  StablecoinStatus,
} from "./stablecoin-taxonomy";
export {
  RESERVE_BLACKLISTABILITY_EXPOSURE_VALUES,
  RESERVE_RISK_VALUES,
  ReserveBlacklistabilityExposureSchema,
  ReserveRiskSchema,
} from "./reserves";
export {
  DEPENDENCY_TYPE_VALUES,
  DependencyTypeSchema,
  V9_DEPENDENCY_ECONOMIC_ROLE_VALUES,
  V9DependencyEconomicRoleSchema,
  defaultV9DependencyEconomicRole,
} from "./dependency-types";

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
  "COP",
  "CLP",
  "GHS",
  "KES",
  "PEN",
  "GOLD",
  "SILVER",
  "VAR",
  "OTHER",
] as const;
export type PegCurrency = (typeof PEG_CURRENCY_VALUES)[number];

export type StablecoinFlags = import("./stablecoin-meta-schemas").StablecoinFlags;

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
  "semi-monthly",
  "quarterly",
  "semi-annual",
  "annual",
  "ad-hoc",
  "none",
] as const;
export type ProofOfReservesCadence = (typeof PROOF_OF_RESERVES_CADENCE_VALUES)[number];

export const PROOF_ASSURANCE_METHOD_VALUES = [
  "audit",
  "examination",
  "review",
  "agreed-upon-procedures",
  "attestation",
  "onchain-proof",
  "self-verification",
] as const;
export type ProofAssuranceMethod = (typeof PROOF_ASSURANCE_METHOD_VALUES)[number];

export const PROOF_ASSURANCE_SCOPE_VALUES = ["assets-only", "assets-and-liabilities"] as const;
export type ProofAssuranceScope = (typeof PROOF_ASSURANCE_SCOPE_VALUES)[number];

export const LIABILITY_RECONCILIATION_VALUES = ["full", "partial", "none", "unknown"] as const;
export type LiabilityReconciliation = (typeof LIABILITY_RECONCILIATION_VALUES)[number];

export type ProofOfReservesLatestReport = import("./stablecoin-meta-schemas").ProofOfReservesLatestReport;
export type ProofOfReserves = import("./stablecoin-meta-schemas").ProofOfReserves;
export type StablecoinLink = import("./stablecoin-meta-schemas").StablecoinLink;

export const RESEARCH_REVIEW_CONFIDENCE_VALUES = ["verified", "probable", "manual-review", "unknown"] as const;
export type ResearchReviewConfidence = (typeof RESEARCH_REVIEW_CONFIDENCE_VALUES)[number];

export const MECHANISM_ARCHETYPE_REVIEW_DISPOSITION_VALUES = ["resolved", "unresolved"] as const;
export type MechanismArchetypeReviewDisposition = (typeof MECHANISM_ARCHETYPE_REVIEW_DISPOSITION_VALUES)[number];

/** Review record for a direct mechanism classification or a reason-coded unresolved design. */
export type MechanismArchetypeReview = import("./stablecoin-meta-schemas").MechanismArchetypeReview;

export const RESERVE_REVIEW_SCOPE_VALUES = ["full-composition", "dependency-relationships", "selected-slices"] as const;
export type ReserveReviewScope = (typeof RESERVE_REVIEW_SCOPE_VALUES)[number];

export const RESERVE_NON_LINK_DISPOSITION_VALUES = [
  "untracked-exogenous-asset",
  "self-reserve",
  "basket-needs-split",
  "insufficient-evidence",
  "not-applicable",
] as const;
export type ReserveNonLinkDisposition = (typeof RESERVE_NON_LINK_DISPOSITION_VALUES)[number];

export interface ReserveNonLinkReview {
  reserveIndex: number;
  reserveName: string;
  pct: number;
  disposition: ReserveNonLinkDisposition;
  rationale: string;
  candidateCoinIds?: string[];
}

export interface ReserveReview {
  reviewedAt: string;
  reviewer: string;
  confidence: ResearchReviewConfidence;
  sources: StablecoinLink[];
  rationale: string;
  compositionBasis: string;
  compositionAsOf?: string;
  scope: ReserveReviewScope;
  knownUnknownExposure: string;
  knownUnknownExposurePct: number;
  nonLinkDispositions?: ReserveNonLinkReview[];
}

export interface DependencyReviewRelationship {
  id: string;
  weight: number;
  type: DependencyType;
  /** Explicit V9 propagation role; absent retained reviews use the legacy topology default. */
  economicRole?: V9DependencyEconomicRole;
  reason: string;
}

export interface DependencyReview {
  reviewedAt: string;
  reviewer: string;
  confidence: ResearchReviewConfidence;
  sources: StablecoinLink[];
  rationale: string;
  relationships: DependencyReviewRelationship[];
}

export const CUSTODY_PROVIDER_ROLE_VALUES = ["custodian", "subcustodian", "bank", "prime-broker", "other"] as const;
export type CustodyProviderRole = (typeof CUSTODY_PROVIDER_ROLE_VALUES)[number];

export const CUSTODY_SEGREGATION_VALUES = ["segregated", "omnibus", "mixed", "unknown"] as const;
export type CustodySegregation = (typeof CUSTODY_SEGREGATION_VALUES)[number];

export const CUSTODY_BANKRUPTCY_REMOTENESS_VALUES = ["structured", "contractual-only", "none", "unknown"] as const;
export type CustodyBankruptcyRemoteness = (typeof CUSTODY_BANKRUPTCY_REMOTENESS_VALUES)[number];

export const CUSTODY_REHYPOTHECATION_VALUES = ["prohibited", "permitted", "conditional", "unknown"] as const;
export type CustodyRehypothecation = (typeof CUSTODY_REHYPOTHECATION_VALUES)[number];

export interface CustodyProviderReview {
  name: string;
  role: CustodyProviderRole;
  sharePct?: number;
  jurisdiction?: string;
}

export interface CustodyProfile {
  providers: CustodyProviderReview[];
  segregation: CustodySegregation;
  bankruptcyRemoteness: CustodyBankruptcyRemoteness;
  rehypothecation: CustodyRehypothecation;
  reviewedAt: string;
  reviewer: string;
  confidence: ResearchReviewConfidence;
  sources: StablecoinLink[];
  uncertainty: string;
  knownUnknownExposurePct?: number;
}

export const MINT_AUTHORITY_MINT_PATH_VALUES = [
  "immutable-user-collateralized",
  "user-collateralized-governed",
  "issuer-direct-mint",
  "permissioned-minter",
  "offchain-attested-minter",
  "facilitator-bucket-mint",
  "amo-or-custodian-hybrid",
  "bridge-or-oft-synthetic",
  "m0-permissioned-minter",
  "wrapped-or-variant-inherited",
  "unknown",
] as const;
export type MintAuthorityMintPath = (typeof MINT_AUTHORITY_MINT_PATH_VALUES)[number];

// Ordered strongest-first, matching `V9_MINT_POSTURE_BAND_ORDER`.
//
// `unbounded-reconciled` describes economically unbounded minting that is
// nonetheless reconciled against reserves or run under a supervisory regime.
// V9 has derived it since 9.1; the curated vocabulary lacked it, so a supervised
// issuer had to be annotated `unbounded-or-compromised` — the same rung as an
// issuer with no reconciliation at all. The two are not the same fact.
//
// `none-resolved` and `none-resolved-mint` are the two scopes of the same
// finding. `none-resolved` is whole-of-chain: no privileged control of any kind
// anywhere on the mint path, and for a wrapper only when the parent is itself
// `none-resolved`. `none-resolved-mint` is *mint-scoped*: no privileged mint
// path on this asset, while other control domains (upgradeability, parameters,
// and — for a wrapper — the parent's own mint authority) may still exist. V9
// derives its mint posture mint-scoped, so a share wrapper over a governed
// parent derives `none-resolved` while the whole-of-chain curated value could
// never say it; the mint-scoped value is what those annotations mean.
export const MINT_AUTHORITY_POSTURE_VALUES = [
  "none-resolved",
  "none-resolved-mint",
  "bounded-admin",
  "partially-bounded-admin",
  "unbounded-reconciled",
  "concentrated-admin",
  "unbounded-or-compromised",
  "unknown",
] as const;
export type MintAuthorityPosture = (typeof MINT_AUTHORITY_POSTURE_VALUES)[number];

export const MINT_AUTHORITY_CONFIDENCE_VALUES = ["verified", "probable", "manual-review", "unknown"] as const;
export type MintAuthorityConfidence = (typeof MINT_AUTHORITY_CONFIDENCE_VALUES)[number];

export const MINT_AUTHORITY_NO_LOCAL_ISSUANCE_KIND_VALUES = [
  "inherited-parent-issuance",
  "external-only-representation",
] as const;
export type MintAuthorityNoLocalIssuanceKind = (typeof MINT_AUTHORITY_NO_LOCAL_ISSUANCE_KIND_VALUES)[number];

export const MINT_AUTHORITY_CONTROL_ROLE_VALUES = [
  "direct-minter",
  "minter-admin",
  "facilitator",
  "bucket-admin",
  "cap-admin",
  "proxy-admin",
  "bridge-admin",
  "timelock",
  "governor",
  "backend-signer",
  "custodian",
  "wrapper",
  "other",
  "unknown",
] as const;
export type MintAuthorityControlRole = (typeof MINT_AUTHORITY_CONTROL_ROLE_VALUES)[number];

export const MINT_AUTHORITY_TYPE_VALUES = [
  "safe",
  "multisig",
  "eoa",
  "timelock",
  "dao-governor",
  "contract",
  "issuer-backend",
  "bridge",
  "custodian",
  "none",
  "unknown",
] as const;
export type MintAuthorityType = (typeof MINT_AUTHORITY_TYPE_VALUES)[number];

export const MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES = [
  "direct",
  "cap-limited",
  "can-authorize",
  "upgrade-only",
  "parameter-only",
  "none",
  "unknown",
] as const;
export type MintAuthorityDirectMintAbility = (typeof MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES)[number];

export const MINT_AUTHORITY_SAFE_SOURCE_VALUES = ["onchain", "safe-api", "manual"] as const;
export type MintAuthoritySafeSource = (typeof MINT_AUTHORITY_SAFE_SOURCE_VALUES)[number];

// Reviewed economic-control facts the Safety Score v9 engine consumes. They are
// optional on the profile; when absent the engine keeps its inferred/encoding
// behavior (fail-closed inertness). Evidence lives in the profile's existing
// review.sources — these fields do not carry their own citations.
export const MINT_AUTHORITY_ECONOMIC_CAP_SEMANTICS_VALUES = ["unbounded", "raiseable", "bounded", "unknown"] as const;
export type MintAuthorityEconomicCapSemantics = (typeof MINT_AUTHORITY_ECONOMIC_CAP_SEMANTICS_VALUES)[number];

export const MINT_AUTHORITY_RECONCILIATION_VALUES = ["continuous", "periodic", "not-applicable", "unknown"] as const;
export type MintAuthorityReconciliation = (typeof MINT_AUTHORITY_RECONCILIATION_VALUES)[number];

export const MINT_AUTHORITY_SUPERVISION_VALUES = ["prudential", "attestation-only", "none", "unknown"] as const;
export type MintAuthoritySupervision = (typeof MINT_AUTHORITY_SUPERVISION_VALUES)[number];

export const MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES = [
  "none-detected",
  "present",
  "unknown",
  "not-applicable",
] as const;
export type MintAuthorityModulesOrGuardsStatus = (typeof MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES)[number];

export interface MintAuthoritySafeState {
  version?: string;
  owners?: string[];
  threshold?: number;
  enabledModules?: string[];
  guard?: string | null;
  moduleGuard?: string | null;
  fallbackHandler?: string | null;
  masterCopy?: string | null;
  observedBlock?: number;
  observedAt?: string;
  source: MintAuthoritySafeSource;
}

export const MINT_AUTHORITY_UPGRADE_MODEL_VALUES = [
  "immutable",
  "transparent-proxy",
  "uups",
  "beacon",
  "diamond",
  "custom",
  "unknown",
] as const;
export type MintAuthorityUpgradeModel = (typeof MINT_AUTHORITY_UPGRADE_MODEL_VALUES)[number];

export interface MintAuthorityUpgradeability {
  model: MintAuthorityUpgradeModel;
  deploymentRefs?: string[];
  proxyAddresses?: string[];
  implementationAddresses?: string[];
  adminAddresses?: string[];
  canChangeMintLogic: boolean | "unknown";
  delaySec?: number;
  /** Exact label of the reviewed control that can change mint-critical logic. */
  controlRef?: string;
  observedAt?: string;
  observedBlock?: number;
  sources: StablecoinLink[];
}

export interface MintAuthorityRouteChecks {
  lockboxOrEscrow?: string;
  trustedPeerOrRemote?: string;
  attestorQuorum?: string;
  signingModel?: string;
  rateLimits?: string;
  caps?: string;
  pausersAdminsUpgraders?: string;
  onchainAmountBounds?: string;
  unsupportedReason?: string;
}

export const MINT_AUTHORITY_KEY_CUSTODY_ATTESTATION_KIND_VALUES = ["mpc", "hsm"] as const;
export type MintAuthorityKeyCustodyAttestationKind =
  (typeof MINT_AUTHORITY_KEY_CUSTODY_ATTESTATION_KIND_VALUES)[number];

export interface MintAuthorityKeyCustodyAttestation {
  kind: MintAuthorityKeyCustodyAttestationKind;
  sources: StablecoinLink[];
}

export interface MintAuthorityControl {
  chain?: string;
  address?: string;
  deploymentRefs?: string[];
  /**
   * Tracked native asset whose issuance system owns this controller.
   *
   * Use when another product reuses an upstream controller so dependency
   * analysis can price the downstream reliance without creating a reverse
   * dependency on the controller's native asset.
   */
  controllerAssetId?: string;
  label: string;
  role: MintAuthorityControlRole;
  authorityType: MintAuthorityType;
  directMintAbility: MintAuthorityDirectMintAbility;
  threshold?: number;
  signerCount?: number;
  timelockDelaySec?: number;
  capDescription?: string;
  canRaiseCap?: boolean | "unknown";
  modulesOrGuardsStatus?: MintAuthorityModulesOrGuardsStatus;
  safe?: MintAuthoritySafeState;
  routeChecks?: MintAuthorityRouteChecks;
  keyCustodyAttestation?: MintAuthorityKeyCustodyAttestation;
  observedAt?: string;
  observedBlock?: number;
  /** Reviewed non-address common modes such as issuer, custodian, or operator identity. */
  failureDomainKeys?: string[];
  bypassSurfaces?: string[];
  sources?: StablecoinLink[];
  evidence?: string;
}

export interface MintAuthorityReview {
  sources?: StablecoinLink[];
  sourceFreeRationale?: string;
  evidence: string;
  reviewer: string;
  reviewedAt: string;
  disposition?: "scoreable" | "unresolved";
  unresolvedQuestions?: string[];
  noLocalIssuance?: MintAuthorityNoLocalIssuanceException;
}

export interface MintAuthorityNoLocalIssuanceException {
  kind: MintAuthorityNoLocalIssuanceKind;
  reviewedAt: string;
  reviewer: string;
  rationale: string;
  sources?: StablecoinLink[];
}

export interface MintAuthorityProfile {
  mintPath: MintAuthorityMintPath;
  authorityPosture: MintAuthorityPosture;
  confidence: MintAuthorityConfidence;
  summary: string;
  inheritedFrom?: string;
  upgradeability?: MintAuthorityUpgradeability;
  mintIncidents?: Array<{
    date: string;
    status: "active" | "resolved";
    resolvedAt?: string;
    summary: string;
    sources: StablecoinLink[];
  }>;
  controls?: MintAuthorityControl[];
  /** Reviewed economic mint bound; supersedes the encoding-derived cap in v9. */
  economicCapSemantics?: MintAuthorityEconomicCapSemantics;
  /** Reviewed supply-vs-reserve reconciliation cadence; supersedes v9 inference. */
  reconciliation?: MintAuthorityReconciliation;
  /** Reviewed prudential-supervision regime; graduates the reconciled mint rung. */
  supervision?: MintAuthoritySupervision;
  review: MintAuthorityReview;
}

export type BlacklistabilityReviewStatus = boolean | "possible" | "inherited";

export interface BlacklistabilityReview {
  reviewedStatus: BlacklistabilityReviewStatus;
  sources?: StablecoinLink[];
  sourceFreeRationale?: string;
  evidence: string;
  reviewer: string;
  reviewedAt: string;
}

export interface Jurisdiction {
  country: string;
  regulator?: string;
  license?: string;
}

export const MICA_STATUS_VALUES = ["authorized", "pending", "transitional", "non-compliant", "out-of-scope"] as const;
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

export const GENIUS_APPLICABILITY_VALUES = [
  "apparent-payment-stablecoin",
  "excluded-deposit",
  "excluded-security",
  "excluded-national-currency",
  "non-payment-token",
  "unclear",
] as const;
export type GeniusApplicability = (typeof GENIUS_APPLICABILITY_VALUES)[number];

export const GENIUS_AUTHORIZATION_STATUS_VALUES = [
  "ppsi-approved",
  "state-qualified",
  "official-application-pending",
  "issuer-announced-intent",
  "no-public-authorization-found",
  "not-applicable",
  "unknown",
] as const;
export type GeniusAuthorizationStatus = (typeof GENIUS_AUTHORIZATION_STATUS_VALUES)[number];

export const GENIUS_ISSUER_PATHWAY_VALUES = [
  "idi-subsidiary",
  "federal-qualified-nonbank",
  "state-qualified",
  "foreign-registered",
  "unknown",
  "not-applicable",
] as const;
export type GeniusIssuerPathway = (typeof GENIUS_ISSUER_PATHWAY_VALUES)[number];

export const GENIUS_SOURCE_KIND_VALUES = [
  "federal-register",
  "federal-regulator",
  "state-regulator",
  "foreign-regulator",
  "statute",
  "regulator-directory",
  "issuer-filing",
  "issuer-disclosure",
  "auditor-report",
  "news",
] as const;
export type GeniusSourceKind = (typeof GENIUS_SOURCE_KIND_VALUES)[number];

export const GENIUS_PRIMARY_FEDERAL_REGULATOR_VALUES = ["OCC", "Federal Reserve", "FDIC", "NCUA", "Unknown"] as const;
export type GeniusPrimaryFederalRegulator = (typeof GENIUS_PRIMARY_FEDERAL_REGULATOR_VALUES)[number];

export const GENIUS_FOREIGN_EXCEPTION_STATUS_VALUES = [
  "registered-exception",
  "comparability-determined",
  "registration-pending",
  "not-qualified",
  "not-applicable",
  "unknown",
] as const;
export type GeniusForeignExceptionStatus = (typeof GENIUS_FOREIGN_EXCEPTION_STATUS_VALUES)[number];

export const GENIUS_ENFORCEMENT_STATUS_VALUES = [
  "no-public-action-found",
  "warning-or-notice",
  "prohibited-or-revoked",
  "unknown",
] as const;
export type GeniusEnforcementStatus = (typeof GENIUS_ENFORCEMENT_STATUS_VALUES)[number];

export const GENIUS_DASP_OFFER_SALE_STATUS_VALUES = [
  "not-yet-restricted",
  "restricted",
  "foreign-lawful-order-condition-active",
  "not-applicable",
  "unknown",
] as const;
export type GeniusDaspOfferSaleStatus = (typeof GENIUS_DASP_OFFER_SALE_STATUS_VALUES)[number];

export interface GeniusReference {
  label: string;
  url: string;
  sourceKind: GeniusSourceKind;
  sourceDate?: string;
  accessedAt?: string;
}

export interface GeniusApplicabilityBasis {
  summary: string;
  references?: GeniusReference[];
}

export interface GeniusForeignExceptionEvidence {
  summary: string;
  references?: GeniusReference[];
}

export interface GeniusNegativeEvidenceReview {
  sourcesChecked: string[];
  summary: string;
  reviewer: string;
  reviewedAt: string;
  references?: GeniusReference[];
}

export interface GeniusProfile {
  applicability: GeniusApplicability;
  applicabilityBasis?: GeniusApplicabilityBasis;
  authorizationStatus: GeniusAuthorizationStatus;
  issuerPathway: GeniusIssuerPathway;
  issuerEntity?: string;
  issuerDomicile?: string;
  licensingRegulator?: string;
  primaryFederalRegulator?: GeniusPrimaryFederalRegulator;
  stateRegulator?: string;
  foreignExceptionStatus?: GeniusForeignExceptionStatus;
  foreignExceptionEvidence?: GeniusForeignExceptionEvidence;
  enforcementStatus?: GeniusEnforcementStatus;
  daspOfferSaleStatus?: GeniusDaspOfferSaleStatus;
  reserveDisclosurePresent?: boolean;
  reserveDisclosureUrl?: string;
  redemptionPolicyPresent?: boolean;
  monthlyAttestationPresent?: boolean;
  latestReportDate?: string;
  notes?: string;
  references?: GeniusReference[];
  negativeEvidenceReview?: GeniusNegativeEvidenceReview;
  reviewer: string;
  reviewedAt: string;
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

export const COLLATERAL_QUALITY_VALUES = ["native", "rwa", "eth-lst", "alt-lst-bridged-or-mixed", "exotic"] as const;
export type CollateralQuality = (typeof COLLATERAL_QUALITY_VALUES)[number];

export const CUSTODY_MODEL_VALUES = [
  "onchain",
  "institutional-top",
  "institutional-regulated",
  "institutional-unregulated",
  "institutional-sanctioned",
  "cex",
] as const;
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

export const ORACLE_RISK_TIER_VALUES = [
  "oracleless",
  "privileged-internal-pricing",
  "redundant-with-failover",
  "medianized-with-delay",
  "standard-external",
  "single-source-or-laggy",
  "opaque-or-unknown",
] as const;
export type OracleRiskTier = (typeof ORACLE_RISK_TIER_VALUES)[number];

/**
 * What the reviewed price authority is *for*. Both roles carry the same tier
 * vocabulary but describe structurally different exposures, so the detail
 * module titles and frames them separately.
 *
 * `collateral-pricing`: the feed values borrower collateral inside a
 * liquidation engine, so a wrong or stale price leaves the stablecoin's own
 * debt undercollateralized.
 * `coin-price-feed`: the feed prices the coin itself or the assets behind it,
 * with no borrower liquidation engine consuming it.
 */
export const ORACLE_RISK_ROLE_VALUES = ["collateral-pricing", "coin-price-feed"] as const;
export type OracleRiskRole = (typeof ORACLE_RISK_ROLE_VALUES)[number];

export const ORACLE_RISK_CONFIDENCE_VALUES = ["verified", "probable", "limited", "unknown"] as const;
export type OracleRiskConfidence = (typeof ORACLE_RISK_CONFIDENCE_VALUES)[number];
export const ORACLE_RISK_BRANCH_MODEL_VALUES = ["single-path", "multi-branch"] as const;
export type OracleRiskBranchModel = (typeof ORACLE_RISK_BRANCH_MODEL_VALUES)[number];
export const ORACLE_RISK_BRANCH_APPLICABILITY_VALUES = [
  "branches-required",
  "top-level-only",
  "not-applicable",
  "unresolved",
] as const;
export type OracleRiskBranchApplicability = (typeof ORACLE_RISK_BRANCH_APPLICABILITY_VALUES)[number];
export const ORACLE_RISK_LIQUIDATION_STATE_VALUES = ["callable", "uncallable", "unknown"] as const;
export type OracleRiskLiquidationState = (typeof ORACLE_RISK_LIQUIDATION_STATE_VALUES)[number];

/** Reviewed scope of the price-authority review. `not-applicable` is neutral,
 * `top-level-only` scores a price-sensitive control without liquidation rows,
 * and `branches-required` activates market-specific liquidation evidence.
 */
export interface OracleRiskBranchApplicabilityReview {
  disposition: OracleRiskBranchApplicability;
  reviewedAt: string;
  reviewer: string;
  rationale: string;
  sources: StablecoinLink[];
}

export interface OracleRiskFeed {
  provider: string;
  path: string;
  address?: string;
  chain: string;
  heartbeatSec?: number;
  stalenessBoundSec?: number;
  observedAt?: string;
  observedBlock?: number;
  failureDomainKeys?: string[];
}

export interface OracleRiskCollateralParameter {
  asset: string;
  maximumLtvPct?: number;
  minimumCollateralRatioPct?: number;
  shutdownCollateralRatioPct?: number;
  note?: string;
}

export type OracleRiskBranch = import("./stablecoin-meta-schemas").OracleRiskBranch;

export interface OracleRiskProfile {
  tier: OracleRiskTier;
  summary: string;
  role?: OracleRiskRole;
  branchModel?: OracleRiskBranchModel;
  branchApplicability?: OracleRiskBranchApplicabilityReview;
  reviewedAt?: string;
  reviewer?: string;
  confidence?: OracleRiskConfidence;
  sources?: StablecoinLink[];
  branches?: OracleRiskBranch[];
}

export const BRIDGE_ROUTE_RISK_TIER_VALUES = [
  "single-chain-or-native",
  "issuer-native-burn-mint",
  "canonical-rollup-bridge",
  "issuer-native-lock-mint",
  "external-validated-network",
  "liquidity-or-intent-route",
  "external-lock-mint",
  "opaque-or-unknown",
] as const;
export type BridgeRouteRiskTier = (typeof BRIDGE_ROUTE_RISK_TIER_VALUES)[number];

export const BRIDGE_ROUTE_RISK_CONFIDENCE_VALUES = ["verified", "probable", "manual-review", "unknown"] as const;
export type BridgeRouteRiskConfidence = (typeof BRIDGE_ROUTE_RISK_CONFIDENCE_VALUES)[number];

export const BRIDGE_ROUTE_RISK_SOURCE_VALUES = ["l2beat", "issuer", "docs", "explorer", "manual"] as const;
export type BridgeRouteRiskSource = (typeof BRIDGE_ROUTE_RISK_SOURCE_VALUES)[number];

export interface BridgeRouteProtocolEvidence {
  source: BridgeRouteRiskSource;
  name: string;
  slug?: string;
  url?: string;
  bridgeTypes?: string[];
  note?: string;
}

export const BRIDGE_ROUTE_CLASS_VALUES = ["native", "canonical", "third-party", "unknown"] as const;
export type BridgeRouteClass = (typeof BRIDGE_ROUTE_CLASS_VALUES)[number];

export const BRIDGE_ROUTE_REVIEW_DISPOSITION_VALUES = ["reviewed", "unresolved"] as const;
export type BridgeRouteReviewDisposition = (typeof BRIDGE_ROUTE_REVIEW_DISPOSITION_VALUES)[number];

export const BRIDGE_ROUTE_ISSUANCE_MODEL_VALUES = [
  "native-issuance",
  "bridge-representation",
  "wrapped-representation",
  "liquidity-settlement",
  "unknown",
] as const;
export type BridgeRouteIssuanceModel = (typeof BRIDGE_ROUTE_ISSUANCE_MODEL_VALUES)[number];

export const BRIDGE_ROUTE_SEMANTICS_VALUES = [
  "native-mint",
  "burn-mint",
  "lock-mint",
  "liquidity",
  "intent",
  "other",
  "unknown",
] as const;
export type BridgeRouteSemantics = (typeof BRIDGE_ROUTE_SEMANTICS_VALUES)[number];

export const BRIDGE_ROUTE_SCOPE_VALUES = ["global", "canonical", "peripheral", "unknown"] as const;
export type BridgeRouteScope = (typeof BRIDGE_ROUTE_SCOPE_VALUES)[number];

export const BRIDGE_ROUTE_CONTROL_CAPABILITY_VALUES = [
  "bridge-mint",
  "bridge-burn",
  "upgrade",
  "admin",
  "pause",
  "rate-limit",
  "validator",
  "escrow",
  "peer-config",
] as const;
export type BridgeRouteControlCapability = (typeof BRIDGE_ROUTE_CONTROL_CAPABILITY_VALUES)[number];

export interface BridgeRouteControl {
  id: string;
  label: string;
  routeRefs: string[];
  capabilities: BridgeRouteControlCapability[];
  controllerChain?: string;
  controllerAddress?: string;
  failureDomainKeys?: string[];
  authorityType: MintAuthorityType;
  threshold?: number;
  signerCount?: number;
  timelockDelaySec?: number;
  safe?: MintAuthoritySafeState;
  modulesOrGuardsStatus?: MintAuthorityModulesOrGuardsStatus;
  keyCustodyAttestation?: MintAuthorityKeyCustodyAttestation;
  routeChecks?: MintAuthorityRouteChecks;
  capDescription?: string;
  canRaiseCap?: boolean | "unknown";
  bypassSurfaces?: string[];
  observedAt?: string;
  observedBlock?: number;
  sources?: StablecoinLink[];
  evidence?: string;
}

export interface BridgeRouteDeployment {
  id: string;
  sourceChain?: string;
  destinationChain: string;
  canonicalChain?: string;
  contractAddress: string;
  representationId?: string;
  protocol: string;
  issuanceModel: BridgeRouteIssuanceModel;
  routeClass: BridgeRouteClass;
  riskTier: BridgeRouteRiskTier;
  semantics: BridgeRouteSemantics;
  scope: BridgeRouteScope;
  reviewDisposition: BridgeRouteReviewDisposition;
  reviewNote?: string;
  mappingVersion?: string;
  controllerChain?: string;
  controllerAddress?: string;
  failureDomainKeys?: string[];
  observedAt?: string;
  observedBlock?: number;
  sources?: StablecoinLink[];
}

export interface BridgeRouteRiskProfile {
  tier: BridgeRouteRiskTier;
  summary: string;
  reviewedAt: string;
  reviewer: string;
  confidence: BridgeRouteRiskConfidence;
  protocols?: BridgeRouteProtocolEvidence[];
  sourceFreeRationale?: string;
  sources?: StablecoinLink[];
  routes?: BridgeRouteDeployment[];
  controls?: BridgeRouteControl[];
}

export const INFRASTRUCTURE_VALUES = ["liquity-v1", "liquity-v2", "m0"] as const;
export type Infrastructure = (typeof INFRASTRUCTURE_VALUES)[number];

export const INFRASTRUCTURE_LABELS: Record<Infrastructure, string> = {
  "liquity-v1": "Liquity v1",
  "liquity-v2": "Liquity v2",
  m0: "M0",
};

export const VARIANT_KIND_VALUES = [
  "pure-wrapper",
  "savings-passthrough",
  "strategy-vault",
  "risk-absorption",
  "bond-maturity",
] as const;
export type VariantKind = (typeof VARIANT_KIND_VALUES)[number];

export const WRAPPER_OPERATOR_VALUES = ["parent-protocol", "third-party"] as const;
export type WrapperOperator = (typeof WRAPPER_OPERATOR_VALUES)[number];
export const GovernanceTypeSchema = z.enum(GOVERNANCE_TYPE_VALUES);
export const CollateralQualitySchema = z.enum(COLLATERAL_QUALITY_VALUES);
export const CustodyModelSchema = z.enum(CUSTODY_MODEL_VALUES);
export const GovernanceQualitySchema = z.enum(GOVERNANCE_QUALITY_VALUES);
export const OracleRiskTierSchema = z.enum(ORACLE_RISK_TIER_VALUES);
export const OracleRiskConfidenceSchema = z.enum(ORACLE_RISK_CONFIDENCE_VALUES);
export const BridgeRouteRiskTierSchema = z.enum(BRIDGE_ROUTE_RISK_TIER_VALUES);
export const BridgeRouteRiskConfidenceSchema = z.enum(BRIDGE_ROUTE_RISK_CONFIDENCE_VALUES);
export const BridgeRouteRiskSourceSchema = z.enum(BRIDGE_ROUTE_RISK_SOURCE_VALUES);

export const COIN_NOTICE_TYPE_VALUES = ["danger", "warning", "info"] as const;
export type CoinNoticeType = (typeof COIN_NOTICE_TYPE_VALUES)[number];

export interface CoinNotice {
  type: CoinNoticeType;
  title: string;
  message: string;
}

export const YIELD_TYPE_VALUES = [
  "lending-vault",
  "rebase",
  "fee-sharing",
  "lp-receipt",
  "nav-appreciation",
  "governance-set",
  "lending-opportunity",
  "fixed-yield",
  "structured-tranche",
] as const;

export type YieldType = (typeof YIELD_TYPE_VALUES)[number];

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

export const MARKET_AVAILABILITY_VALUES = [
  "market-traded",
  "limited-trading",
  "non-traded-utility",
  "legacy-or-wind-down",
] as const;
export type MarketAvailability = (typeof MARKET_AVAILABILITY_VALUES)[number];

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

export interface StablecoinListingStatusReview {
  /** Date on which the lifecycle decision took effect. */
  changedAt: string;
  /** Concise public explanation for the quarantine or delisting. */
  reason: string;
  /** Required follow-up date for reversible quarantines. */
  reviewBy?: string;
  /** Primary evidence for an out-of-scope decision or runtime hold. */
  source?: StablecoinLink;
}

export interface StablecoinMeta {
  id: string;
  llamaId?: string;
  detailProvider?: DetailProvider;
  marketAvailability?: MarketAvailability;
  priceBasis?: StablecoinPriceBasis;
  exitMechanism?: StablecoinExitMechanism;
  name: string;
  symbol: string;
  oneLiner?: string;
  flags: StablecoinFlags;
  pegReferenceId?: string;
  collateral?: string;
  pegMechanism?: string;
  mechanismArchetype?: MechanismArchetype;
  mechanismArchetypeReview?: MechanismArchetypeReview;
  /** Current mechanism implementation boundary; fuzzy dates use the conservative range-end policy. */
  implementationLaunchDate?: string;
  commodityOunces?: number;
  geckoId?: string;
  cmcSlug?: string;
  pythFeedId?: string;
  protocolSlug?: string;
  proofOfReserves?: ProofOfReserves;
  links?: StablecoinLink[];
  jurisdiction?: Jurisdiction;
  mica?: MicaProfile;
  genius?: GeniusProfile;
  mintAuthority?: MintAuthorityProfile;
  contracts?: ContractDeployment[];
  tradedContracts?: ContractDeployment[];
  dependencies?: DependencyWeight[];
  dependencyReview?: DependencyReview;
  blacklistabilityReview?: BlacklistabilityReview;
  collateralQuality?: CollateralQuality;
  custodyModel?: CustodyModel;
  governanceQuality?: GovernanceQuality;
  oracleRisk?: OracleRiskProfile;
  bridgeRouteRisk?: BridgeRouteRiskProfile;
  infrastructures?: Infrastructure[];
  variantOf?: string;
  variantKind?: VariantKind;
  /** Required for risk-absorption variants, whose product taxonomy does not establish wrapper ownership. */
  wrapperOperator?: WrapperOperator;
  /** When true, this coin's mechanismArchetype is an intentional departure from its parent's archetype. */
  archetypeOverride?: boolean;
  reserves?: ReserveSlice[];
  reserveReview?: ReserveReview;
  custodyProfile?: CustodyProfile;
  liveReservesConfig?: LiveReservesConfig;
  notices?: CoinNotice[];
  tags?: string[];
  yieldConfig?: YieldConfig;
  status?: StablecoinStatus;
  /** Required for quarantined and delisted assets; rendered on preserved detail pages. */
  listingStatusReview?: StablecoinListingStatusReview;
  /** YYYY-MM-DD; issuer's public wind-down or termination announcement for this token. */
  windDownAnnouncedAt?: string;
  /** Public source for the issuer's wind-down or termination announcement. */
  windDownSourceUrl?: string;
  /** YYYY-MM-DD; required when status === "frozen". */
  frozenAt?: string;
  /** Obituary content surfaced on the detail page banner and cemetery tombstone; required when status === "frozen". */
  obituary?: StablecoinObituary;
  launchDate?: string;
  /** Reviewed lower bound for depeg-event coverage used as the PegScore denominator. */
  pegScoreCoverage?: {
    startDate: string;
    basis: "audited-replay-and-live";
    reviewedAt: string;
    replayRunId?: string;
    notes: string;
  };
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
type GradeFilterTag = "grade-a" | "grade-ge-b" | "grade-ge-c" | "grade-ge-c-plus" | "grade-ge-c-minus" | "grade-le-d";

export type FilterTag =
  | PegCurrencyFilterTag
  | PegGroupFilterTag
  | GovernanceType
  | BackingType
  | InfrastructureFilterTag
  | VariantFilterTag
  | GradeFilterTag;

export const PRICE_CONFIDENCE_VALUES = ["high", "single-source", "low", "fallback"] as const;
export type PriceConfidence = (typeof PRICE_CONFIDENCE_VALUES)[number];
export const PRICE_OBSERVED_AT_MODE_VALUES = ["upstream", "local_fetch", "unknown"] as const;
export type PriceObservedAtMode = (typeof PRICE_OBSERVED_AT_MODE_VALUES)[number];
export const DEPEG_PRIMARY_TRUST_VALUES = ["authoritative", "confirm_required", "unusable"] as const;
export type DepegPrimaryTrust = (typeof DEPEG_PRIMARY_TRUST_VALUES)[number];

export const PriceConfidenceSchema = z.enum(PRICE_CONFIDENCE_VALUES);
export const PriceObservedAtModeSchema = z.enum(PRICE_OBSERVED_AT_MODE_VALUES);
export const DepegPrimaryTrustSchema = z.enum(DEPEG_PRIMARY_TRUST_VALUES);

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

export const BLUECHIP_GRADE_VALUES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"] as const;
export type BluechipGrade = (typeof BLUECHIP_GRADE_VALUES)[number];
export const BluechipGradeSchema = z.enum(BLUECHIP_GRADE_VALUES);

export { MethodologyEnvelopeSchema, type MethodologyEnvelope } from "./methodology-envelope";
