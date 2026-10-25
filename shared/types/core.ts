import { z } from "zod";
import type { StablecoinMeta } from "./stablecoin-meta-schemas";
import type { GovernanceType } from "./stablecoin-taxonomy";
export type { StablecoinMeta, StablecoinObituary, StablecoinListingStatusReview } from "./stablecoin-meta-schemas";
export type { DependencyType } from "./dependency-types";
export type { ReserveAssetClass, ReserveLiquidityHorizon, ReserveRisk, ReserveRiskFactor, ReserveSlice } from "./reserves";
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
  DEPENDENCY_TYPE_VALUES,
  V9_DEPENDENCY_ECONOMIC_ROLE_VALUES,
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
  "CZK",
  "PLN",
  "AED",
  "GOLD",
  "SILVER",
  "VAR",
  "OTHER",
] as const;
export type PegCurrency = (typeof PEG_CURRENCY_VALUES)[number];

export type StablecoinFlags = import("./stablecoin-meta-primitives").StablecoinFlags;

/**
 * Engagement class of the proof-of-reserves artefact. `agreed-upon-procedures`
 * is a third-party engagement that expresses no assurance opinion, while
 * `attestation` is an independent verification-agent report distinct from
 * both audit-grade assurance and issuer self-reporting.
 */
export const PROOF_OF_RESERVES_TYPE_VALUES = [
  "independent-audit",
  "agreed-upon-procedures",
  "attestation",
  "real-time",
  "self-reported",
] as const;

/**
 * Attestor quality ladder. `none` is a *reviewed* negative — a reviewer
 * established that no reserve attestation exists. `undisclosed` is the absence
 * of evidence: the issuer names no attestor, or the claimed artefact is not
 * retrievable. The two must stay distinct so the UI never renders an
 * undisclosed attestor as an asserted "No attestation".
 */
export const ATTESTOR_TIER_VALUES = ["big4", "regional", "niche", "self", "none", "undisclosed"] as const;
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
  /** Reviewed negative: the issuer publishes no periodic reserve report. */
  "none",
  /** Absence of evidence: no cadence is published, or the artefact is unreachable. */
  "undisclosed",
] as const;
export const PROOF_ASSURANCE_METHOD_VALUES = [
  "audit",
  "examination",
  "review",
  "agreed-upon-procedures",
  "attestation",
  "onchain-proof",
  "self-verification",
  "unknown",
] as const;
export const PROOF_ASSURANCE_SCOPE_VALUES = ["assets-only", "assets-and-liabilities", "unknown"] as const;
export const LIABILITY_RECONCILIATION_VALUES = ["full", "partial", "none", "unknown"] as const;
export type ProofOfReservesLatestReport = import("./stablecoin-meta-primitives").ProofOfReservesLatestReport;
export type ProofOfReserves = import("./stablecoin-meta-primitives").ProofOfReserves;
export type StablecoinLink = import("./stablecoin-meta-primitives").StablecoinLink;

export const RESEARCH_REVIEW_CONFIDENCE_VALUES = ["verified", "probable", "manual-review", "unknown"] as const;
export type ResearchReviewConfidence = (typeof RESEARCH_REVIEW_CONFIDENCE_VALUES)[number];

export const MECHANISM_ARCHETYPE_REVIEW_DISPOSITION_VALUES = ["resolved", "unresolved"] as const;
/** Review record for a direct mechanism classification or a reason-coded unresolved design. */
export type MechanismArchetypeReview = import("./stablecoin-meta-primitives").MechanismArchetypeReview;

export const RESERVE_REVIEW_SCOPE_VALUES = ["full-composition", "classification-only", "dependency-relationships", "selected-slices"] as const;
export const RESERVE_NON_LINK_DISPOSITION_VALUES = [
  "untracked-exogenous-asset",
  "self-reserve",
  "basket-needs-split",
  "insufficient-evidence",
  "not-applicable",
] as const;
export type ReserveNonLinkDisposition = (typeof RESERVE_NON_LINK_DISPOSITION_VALUES)[number];
export type ReserveNonLinkReview = import("./stablecoin-meta-primitives").ReserveNonLinkReview;
export type ReserveReview = import("./stablecoin-meta-primitives").ReserveReview;
export type DependencyReviewRelationship = import("./stablecoin-meta-primitives").DependencyReviewRelationship;
export type DependencyReview = import("./stablecoin-meta-primitives").DependencyReview;

export const CUSTODY_PROVIDER_ROLE_VALUES = ["custodian", "subcustodian", "bank", "prime-broker", "other"] as const;
export type CustodyProviderRole = (typeof CUSTODY_PROVIDER_ROLE_VALUES)[number];

export const CUSTODY_SEGREGATION_VALUES = ["segregated", "omnibus", "mixed", "unknown"] as const;
export type CustodySegregation = (typeof CUSTODY_SEGREGATION_VALUES)[number];

export const CUSTODY_BANKRUPTCY_REMOTENESS_VALUES = ["structured", "contractual-only", "none", "unknown"] as const;
export type CustodyBankruptcyRemoteness = (typeof CUSTODY_BANKRUPTCY_REMOTENESS_VALUES)[number];

export const CUSTODY_REHYPOTHECATION_VALUES = ["prohibited", "permitted", "conditional", "unknown"] as const;
export type CustodyRehypothecation = (typeof CUSTODY_REHYPOTHECATION_VALUES)[number];
export type CustodyProviderReview = import("./stablecoin-meta-primitives").CustodyProviderReview;
export type CustodyProfile = import("./stablecoin-meta-primitives").CustodyProfile;

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
// Economically unbounded issuance is annotated separately by independently
// evidenced reconciliation/supervision, qualified governance process, adverse
// authority, and active incident. Process rungs require complete execution-scope
// evidence; `compromised` is reserved for an active mint incident.
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
  "unbounded-governed",
  "unbounded-veto-guarded",
  "unbounded-operationally-governed",
  "concentrated-admin",
  "collateral-gated",
  "unbounded-adverse",
  "compromised",
  "unknown",
] as const;
export type MintAuthorityPosture = (typeof MINT_AUTHORITY_POSTURE_VALUES)[number];

export const MINT_AUTHORITY_CONFIDENCE_VALUES = ["verified", "probable", "manual-review", "unknown"] as const;
export type MintAuthorityConfidence = (typeof MINT_AUTHORITY_CONFIDENCE_VALUES)[number];

export const MINT_AUTHORITY_NO_LOCAL_ISSUANCE_KIND_VALUES = [
  "inherited-parent-issuance",
  "external-only-representation",
] as const;
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

/**
 * AUTHORITY-LADDER 9.46 (2026-09-01): `validator-quorum` names an external
 * message-validation quorum — a LayerZero DVN set, a Chainlink CCIP DON/RMN, a
 * Bantu AMTP validator group, an IBC light-client validator set — whose members
 * are a rotating, protocol-scoped population rather than a named key holder.
 * It is a KNOWN-BUT-WEAK authority: it grades at or below `issuer-backend` and
 * never above a named multisig, because an anonymous rotating quorum is not
 * stronger than a 3-of-5 Safe. Use it only where the controlling party genuinely
 * is the validation domain; a named operator behind it is still that operator.
 */
export const MINT_AUTHORITY_TYPE_VALUES = [
  "safe",
  "multisig",
  "eoa",
  "timelock",
  "dao-governor",
  "contract",
  "issuer-backend",
  "validator-quorum",
  "chain-consensus",
  "bridge",
  "custodian",
  "none",
  "unknown",
] as const;

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
// Reviewed economic-control facts the Safety Score v9 engine consumes. They are
// optional on the profile; when absent the engine keeps its inferred/encoding
// behavior (fail-closed inertness). Evidence lives in the profile's existing
// review.sources — these fields do not carry their own citations.
/**
 * MINT-LADDER 9.32 (2026-08-21): `collateral-gated` means every live mint path
 * requires collateral by construction;
 * no privileged party can mint arbitrarily; any minter-authorization or
 * mint-logic-replacement/upgrade path is absent, renounced, or behind a
 * timelock of at least 86400 seconds. Curator-asserted with sources; anything
 * weaker stays `unbounded`.
 */
export const MINT_AUTHORITY_ECONOMIC_CAP_SEMANTICS_VALUES = [
  "unbounded",
  "raiseable",
  "bounded",
  "collateral-gated",
  "unknown",
] as const;
export type MintAuthorityEconomicCapSemantics = (typeof MINT_AUTHORITY_ECONOMIC_CAP_SEMANTICS_VALUES)[number];

export const MINT_AUTHORITY_RECONCILIATION_VALUES = [
  "continuous",
  "periodic",
  // Disclosed issuer ledger process; no reserve-assurance or cadence credit.
  "internal-ledger",
  "none",
  "not-applicable",
  "unknown",
] as const;

export const MINT_AUTHORITY_SUPERVISION_VALUES = ["prudential", "attestation-only", "none", "unknown"] as const;

export const MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES = [
  "none-detected",
  "present",
  "unknown",
  "not-applicable",
] as const;
export type MintAuthoritySafeState = import("./stablecoin-meta-control-schemas").MintAuthoritySafeState;

export const MINT_AUTHORITY_UPGRADE_MODEL_VALUES = [
  "immutable",
  "transparent-proxy",
  "uups",
  "beacon",
  "diamond",
  "custom",
  "unknown",
] as const;
export type MintAuthorityUpgradeability = import("./stablecoin-meta-control-schemas").MintAuthorityUpgradeability;
export type MintAuthorityRouteChecks = import("./stablecoin-meta-control-schemas").MintAuthorityRouteChecks;

export const MINT_AUTHORITY_KEY_CUSTODY_ATTESTATION_KIND_VALUES = ["mpc", "hsm", "hardware-wallet"] as const;
export type MintAuthorityKeyCustodyAttestation = import("./stablecoin-meta-control-schemas").MintAuthorityKeyCustodyAttestation;
export type MintAuthorityControl = import("./stablecoin-meta-control-schemas").MintAuthorityControl;
export type MintAuthorityReview = import("./stablecoin-meta-control-schemas").MintAuthorityReview;
export type MintAuthorityScopedQuestion = import("./stablecoin-meta-control-schemas").MintAuthorityScopedQuestion;
export type MintAuthorityNoLocalIssuanceException = import("./stablecoin-meta-control-schemas").MintAuthorityNoLocalIssuanceException;
export type MintAuthorityProfile = import("./stablecoin-meta-control-schemas").MintAuthorityProfile;
export type BlacklistabilityReview = import("./stablecoin-meta-compliance-schemas").BlacklistabilityReview;
export type Jurisdiction = import("./stablecoin-meta-compliance-schemas").Jurisdiction;

export const MICA_STATUS_VALUES = ["authorized", "pending", "transitional", "non-compliant", "out-of-scope"] as const;
export type MicaStatus = (typeof MICA_STATUS_VALUES)[number];

export const MICA_TOKEN_TYPE_VALUES = ["EMT", "ART"] as const;
export type MicaTokenType = (typeof MICA_TOKEN_TYPE_VALUES)[number];

export const MICA_AUTHORIZATION_TYPE_VALUES = ["emi", "credit-institution"] as const;
export type MicaAuthorizationType = (typeof MICA_AUTHORIZATION_TYPE_VALUES)[number];
export type MicaProfile = import("./stablecoin-meta-compliance-schemas").MicaProfile;

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
export type GeniusReference = import("./stablecoin-meta-compliance-schemas").GeniusReference;
export type GeniusApplicabilityBasis = import("./stablecoin-meta-compliance-schemas").GeniusApplicabilityBasis;
export type GeniusForeignExceptionEvidence = import("./stablecoin-meta-compliance-schemas").GeniusForeignExceptionEvidence;
export type GeniusNegativeEvidenceReview = import("./stablecoin-meta-compliance-schemas").GeniusNegativeEvidenceReview;
export type GeniusProfile = import("./stablecoin-meta-compliance-schemas").GeniusProfile;
/** Includes explicit native-denom bank deployments alongside token contracts. */
export type ContractDeployment = import("./stablecoin-meta-primitives").ContractDeployment;
export type DependencyWeight = import("./stablecoin-meta-primitives").DependencyWeight;

const COLLATERAL_QUALITY_VALUES = ["native", "rwa", "eth-lst", "alt-lst-bridged-or-mixed", "exotic"] as const;
export type CollateralQuality = (typeof COLLATERAL_QUALITY_VALUES)[number];

export const CUSTODY_MODEL_VALUES = [
  "onchain",
  "institutional-top",
  "institutional-regulated",
  "institutional-unregulated",
  "institutional-sanctioned",
  "cex",
  "mixed",
  "unknown",
] as const;
export type CustodyModel = (typeof CUSTODY_MODEL_VALUES)[number];

const GOVERNANCE_QUALITY_VALUES = [
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
export const ORACLE_RISK_BRANCH_KIND_VALUES = [
  "feed", "collateral-parameter", "liquidation", "backstop", "shutdown-bad-debt",
] as const;
export const ORACLE_RISK_BRANCH_APPLICABILITY_VALUES = [
  "branches-required",
  "top-level-only",
  "not-applicable",
  "unresolved",
] as const;
export const ORACLE_RISK_LIQUIDATION_STATE_VALUES = ["callable", "uncallable", "unknown"] as const;
export type OracleRiskBranchApplicabilityReview = import("./stablecoin-meta-control-schemas").OracleRiskBranchApplicabilityReview;
export type OracleRiskFeed = import("./stablecoin-meta-control-schemas").OracleRiskFeed;
export type OracleRiskCollateralParameter = import("./stablecoin-meta-control-schemas").OracleRiskCollateralParameter;

export type OracleRiskBranch = import("./stablecoin-meta-control-schemas").OracleRiskBranch;
export type OracleRiskProfile = import("./stablecoin-meta-control-schemas").OracleRiskProfile;

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
export type BridgeRouteProtocolEvidence = import("./stablecoin-meta-control-schemas").BridgeRouteProtocolEvidence;

export const BRIDGE_ROUTE_CLASS_VALUES = ["native", "canonical", "third-party", "unknown"] as const;
export const BRIDGE_ROUTE_REVIEW_DISPOSITION_VALUES = ["reviewed", "unresolved"] as const;
export const BRIDGE_ROUTE_ISSUANCE_MODEL_VALUES = [
  "native-issuance",
  "bridge-representation",
  "wrapped-representation",
  "liquidity-settlement",
  "unknown",
] as const;
export const BRIDGE_ROUTE_SEMANTICS_VALUES = [
  "native-mint",
  "burn-mint",
  "lock-mint",
  "liquidity",
  "intent",
  "other",
  "unknown",
] as const;
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
export type BridgeRouteControl = import("./stablecoin-meta-control-schemas").BridgeRouteControl;
export type BridgeRouteDeployment = import("./stablecoin-meta-control-schemas").BridgeRouteDeployment;
export type BridgeRouteRiskProfile = import("./stablecoin-meta-control-schemas").BridgeRouteRiskProfile;
export type BridgeRouteScopedQuestion = import("./stablecoin-meta-control-schemas").BridgeRouteScopedQuestion;

export const INFRASTRUCTURE_VALUES = ["liquity-v1", "liquity-v2", "m0"] as const;
export type Infrastructure = (typeof INFRASTRUCTURE_VALUES)[number];

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
export const CollateralQualitySchema = z.enum(COLLATERAL_QUALITY_VALUES);
export const CustodyModelSchema = z.enum(CUSTODY_MODEL_VALUES);
export const GovernanceQualitySchema = z.enum(GOVERNANCE_QUALITY_VALUES);
export const OracleRiskTierSchema = z.enum(ORACLE_RISK_TIER_VALUES);
export const BridgeRouteRiskTierSchema = z.enum(BRIDGE_ROUTE_RISK_TIER_VALUES);

export const COIN_NOTICE_TYPE_VALUES = ["danger", "warning", "info"] as const;
export type CoinNotice = import("./stablecoin-meta-primitives").CoinNotice;

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
export type YieldConfig = import("./stablecoin-meta-primitives").YieldConfig;

/**
 * `launched` = publicly issued on-chain while Pharos has no admitted price or
 * supply lane yet; allowed only on `status: "pre-launch"` rows. The others are
 * the upcoming phases.
 */
export const LAUNCH_PHASE_VALUES = ["announced", "testnet", "auditing", "beta", "launching-soon", "launched"] as const;
export type LaunchPhase = (typeof LAUNCH_PHASE_VALUES)[number];
export type UpcomingLaunchPhase = Exclude<LaunchPhase, "launched">;
export const UPCOMING_LAUNCH_PHASE_VALUES = LAUNCH_PHASE_VALUES.filter(
  (phase): phase is UpcomingLaunchPhase => phase !== "launched",
);

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
export type LaunchMilestone = import("./stablecoin-meta-primitives").LaunchMilestone;
export type DateHistoryEntry = import("./stablecoin-meta-primitives").DateHistoryEntry;

export const FEATURED_CONTENT_TYPE_VALUES = ["tweet", "blog", "video", "article"] as const;
export type FeaturedContent = import("./stablecoin-meta-primitives").FeaturedContent;

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


/** Lossless registry slice consumed by live-reserve adapters. */
export type ReserveAdapterCoin = Pick<
  StablecoinMeta,
  "id" | "name" | "symbol" | "flags" | "contracts" | "reserves" | "reserveReview" | "liveReservesConfig"
>;

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

const PRICE_CONFIDENCE_VALUES = ["high", "single-source", "low", "fallback"] as const;
export type PriceConfidence = (typeof PRICE_CONFIDENCE_VALUES)[number];
const PRICE_OBSERVED_AT_MODE_VALUES = ["upstream", "local_fetch", "unknown", "nominal_reference", "unsupported"] as const;
export type PriceObservedAtMode = (typeof PRICE_OBSERVED_AT_MODE_VALUES)[number];
const DEPEG_PRIMARY_TRUST_VALUES = ["authoritative", "confirm_required", "unusable"] as const;
export type DepegPrimaryTrust = (typeof DEPEG_PRIMARY_TRUST_VALUES)[number];

export const PriceConfidenceSchema = z.enum(PRICE_CONFIDENCE_VALUES);
// Preserve forward compatibility without mistaking a future mode for legacy observation evidence.
export const PriceObservedAtModeSchema = z.preprocess(
  (value) => typeof value === "string" && !(PRICE_OBSERVED_AT_MODE_VALUES as readonly string[]).includes(value)
    ? "unsupported"
    : value,
  z.enum(PRICE_OBSERVED_AT_MODE_VALUES),
);
/** FX reference admission vocabulary shared with worker price validation (`PriceReferenceType`). */
export const PRICE_REFERENCE_TYPE_VALUES = ["fresh", "stale", "static", "none"] as const;
export type PriceReferenceType = (typeof PRICE_REFERENCE_TYPE_VALUES)[number];
export const NominalPriceReferenceSchema = z.object({
  price: z.number().finite().positive(),
  source: z.string(),
  mode: z.literal("nominal_reference"),
  /**
   * Non-USD par only: admission type of the FX reference that converted par to USD. Only `fresh` and
   * `static` references can produce par; USD par carries neither FX field.
   */
  fxReferenceType: z.enum(PRICE_REFERENCE_TYPE_VALUES).optional(),
  /** Non-USD par only: the FX reference's own per-peg source time (unix s); null when the reference has none. */
  fxObservedAt: z.number().int().positive().nullable().optional(),
});
export type NominalPriceReference = z.infer<typeof NominalPriceReferenceSchema>;
export const DepegPrimaryTrustSchema = z.enum(DEPEG_PRIMARY_TRUST_VALUES);

export interface PriceSourceConfidenceProfile {
  activeDexLanes: number;
  freshestDexLaneAgeSec: number | null;
  aggregateLaneOnly: boolean;
}
export const PriceSourceConfidenceProfileSchema: z.ZodType<PriceSourceConfidenceProfile> = z
  .object({
    activeDexLanes: z.number().int().min(0),
    freshestDexLaneAgeSec: z.number().int().min(0).nullable(),
    aggregateLaneOnly: z.boolean(),
  })
  .strict();

export interface PegAssetBase {
  id: string;
  symbol: string;
  price?: number | null;
  priceSource?: string | null;
  priceConfidence?: PriceConfidence | null;
  priceUpdatedAt?: number | null;
  priceObservedAt?: number | null;
  priceObservedAtMode?: PriceObservedAtMode | null;
  nominalPriceReference?: NominalPriceReference;
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

export { MethodologyEnvelopeSchema } from "./methodology-envelope";
