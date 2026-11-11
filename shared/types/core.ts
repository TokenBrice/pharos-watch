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

export const RESEARCH_REVIEW_CONFIDENCE_VALUES = ["verified", "probable", "manual-review", "unknown"] as const;
export type ResearchReviewConfidence = (typeof RESEARCH_REVIEW_CONFIDENCE_VALUES)[number];

// Temporary scaffolding for step two; remove after the direct-import rewrite.

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

export { MethodologyEnvelopeSchema } from "./methodology-envelope";

export {
  type StablecoinFlags,
  type ProofOfReservesLatestReport,
  type ProofOfReserves,
  type StablecoinLink,
  type MechanismArchetypeReview,
  type ReserveNonLinkReview,
  type ReserveReview,
  type DependencyReviewRelationship,
  type DependencyReview,
  type CustodyProviderReview,
  type CustodyProfile,
  type ContractDeployment,
  type DependencyWeight,
  type CoinNotice,
  type YieldConfig,
  type LaunchMilestone,
  type DateHistoryEntry,
  type FeaturedContent,
  type FilterTag,
} from "./stablecoin-meta-primitives";

export {
  PROOF_OF_RESERVES_TYPE_VALUES,
  ATTESTOR_TIER_VALUES,
  type AttestorTier,
  PROOF_OF_RESERVES_CADENCE_VALUES,
  PROOF_ASSURANCE_METHOD_VALUES,
  PROOF_ASSURANCE_SCOPE_VALUES,
  LIABILITY_RECONCILIATION_VALUES,
} from "./reserve-assurance";

export {
  MECHANISM_ARCHETYPE_REVIEW_DISPOSITION_VALUES,
  type GovernanceQuality,
  INFRASTRUCTURE_VALUES,
  type Infrastructure,
  VARIANT_KIND_VALUES,
  type VariantKind,
  WRAPPER_OPERATOR_VALUES,
  type WrapperOperator,
  GovernanceQualitySchema,
} from "./stablecoin-taxonomy";

export {
  RESERVE_REVIEW_SCOPE_VALUES,
  RESERVE_NON_LINK_DISPOSITION_VALUES,
  type ReserveNonLinkDisposition,
  type CollateralQuality,
  CollateralQualitySchema,
} from "./reserves";

export {
  CUSTODY_PROVIDER_ROLE_VALUES,
  type CustodyProviderRole,
  CUSTODY_SEGREGATION_VALUES,
  type CustodySegregation,
  CUSTODY_BANKRUPTCY_REMOTENESS_VALUES,
  type CustodyBankruptcyRemoteness,
  CUSTODY_REHYPOTHECATION_VALUES,
  type CustodyRehypothecation,
  CUSTODY_MODEL_VALUES,
  type CustodyModel,
  CustodyModelSchema,
} from "./custody";

export {
  MINT_AUTHORITY_MINT_PATH_VALUES,
  type MintAuthorityMintPath,
  MINT_AUTHORITY_POSTURE_VALUES,
  type MintAuthorityPosture,
  MINT_AUTHORITY_CONFIDENCE_VALUES,
  type MintAuthorityConfidence,
  MINT_AUTHORITY_NO_LOCAL_ISSUANCE_KIND_VALUES,
  MINT_AUTHORITY_CONTROL_ROLE_VALUES,
  MINT_AUTHORITY_TYPE_VALUES,
  MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES,
  type MintAuthorityDirectMintAbility,
  MINT_AUTHORITY_SAFE_SOURCE_VALUES,
  MINT_AUTHORITY_ECONOMIC_CAP_SEMANTICS_VALUES,
  type MintAuthorityEconomicCapSemantics,
  MINT_AUTHORITY_RECONCILIATION_VALUES,
  MINT_AUTHORITY_SUPERVISION_VALUES,
  MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES,
  MINT_AUTHORITY_UPGRADE_MODEL_VALUES,
  MINT_AUTHORITY_KEY_CUSTODY_ATTESTATION_KIND_VALUES,
} from "./mint-authority-vocabulary";

export {
  type MintAuthoritySafeState,
  type MintAuthorityUpgradeability,
  type MintAuthorityRouteChecks,
  type MintAuthorityKeyCustodyAttestation,
  type MintAuthorityControl,
  type MintAuthorityReview,
  type MintAuthorityScopedQuestion,
  type MintAuthorityNoLocalIssuanceException,
  type MintAuthorityProfile,
  type OracleRiskBranchApplicabilityReview,
  type OracleRiskFeed,
  type OracleRiskCollateralParameter,
  type OracleRiskBranch,
  type OracleRiskProfile,
  type BridgeRouteProtocolEvidence,
  type BridgeRouteControl,
  type BridgeRouteDeployment,
  type BridgeRouteRiskProfile,
  type BridgeRouteScopedQuestion,
} from "./stablecoin-meta-control-schemas";

export {
  type BlacklistabilityReview,
  type Jurisdiction,
  type MicaProfile,
  type GeniusReference,
  type GeniusApplicabilityBasis,
  type GeniusForeignExceptionEvidence,
  type GeniusNegativeEvidenceReview,
  type GeniusProfile,
} from "./stablecoin-meta-compliance-schemas";

export {
  MICA_STATUS_VALUES,
  type MicaStatus,
  MICA_TOKEN_TYPE_VALUES,
  type MicaTokenType,
  MICA_AUTHORIZATION_TYPE_VALUES,
  type MicaAuthorizationType,
  GENIUS_APPLICABILITY_VALUES,
  type GeniusApplicability,
  GENIUS_AUTHORIZATION_STATUS_VALUES,
  type GeniusAuthorizationStatus,
  GENIUS_ISSUER_PATHWAY_VALUES,
  type GeniusIssuerPathway,
  GENIUS_SOURCE_KIND_VALUES,
  GENIUS_PRIMARY_FEDERAL_REGULATOR_VALUES,
  type GeniusPrimaryFederalRegulator,
  GENIUS_FOREIGN_EXCEPTION_STATUS_VALUES,
  type GeniusForeignExceptionStatus,
  GENIUS_ENFORCEMENT_STATUS_VALUES,
  type GeniusEnforcementStatus,
  GENIUS_DASP_OFFER_SALE_STATUS_VALUES,
  type GeniusDaspOfferSaleStatus,
} from "./compliance-vocabulary";

export {
  ORACLE_RISK_TIER_VALUES,
  type OracleRiskTier,
  ORACLE_RISK_ROLE_VALUES,
  type OracleRiskRole,
  ORACLE_RISK_CONFIDENCE_VALUES,
  type OracleRiskConfidence,
  ORACLE_RISK_BRANCH_MODEL_VALUES,
  ORACLE_RISK_BRANCH_KIND_VALUES,
  ORACLE_RISK_BRANCH_APPLICABILITY_VALUES,
  ORACLE_RISK_LIQUIDATION_STATE_VALUES,
  OracleRiskTierSchema,
} from "./oracle-risk";

export {
  BRIDGE_ROUTE_RISK_TIER_VALUES,
  type BridgeRouteRiskTier,
  BRIDGE_ROUTE_RISK_CONFIDENCE_VALUES,
  type BridgeRouteRiskConfidence,
  BRIDGE_ROUTE_RISK_SOURCE_VALUES,
  BRIDGE_ROUTE_CLASS_VALUES,
  BRIDGE_ROUTE_REVIEW_DISPOSITION_VALUES,
  BRIDGE_ROUTE_ISSUANCE_MODEL_VALUES,
  BRIDGE_ROUTE_SEMANTICS_VALUES,
  BRIDGE_ROUTE_SCOPE_VALUES,
  type BridgeRouteScope,
  BRIDGE_ROUTE_CONTROL_CAPABILITY_VALUES,
  type BridgeRouteControlCapability,
  BridgeRouteRiskTierSchema,
} from "./bridge-risk";

export {
  COIN_NOTICE_TYPE_VALUES,
  LAUNCH_PHASE_VALUES,
  type LaunchPhase,
  type UpcomingLaunchPhase,
  UPCOMING_LAUNCH_PHASE_VALUES,
  LAUNCH_MILESTONE_TYPE_VALUES,
  type LaunchMilestoneType,
  FEATURED_CONTENT_TYPE_VALUES,
  MARKET_AVAILABILITY_VALUES,
  type MarketAvailability,
} from "./stablecoin-lifecycle";

export {
  YIELD_TYPE_VALUES,
  type YieldType,
  YieldTypeSchema,
} from "./yield-vocabulary";

export {
  DETAIL_PROVIDER_VALUES,
  type DetailProvider,
  DetailProviderSchema,
  type PriceConfidence,
  type PriceObservedAtMode,
  type DepegPrimaryTrust,
  PriceConfidenceSchema,
  PriceObservedAtModeSchema,
  PRICE_REFERENCE_TYPE_VALUES,
  type PriceReferenceType,
  NominalPriceReferenceSchema,
  type NominalPriceReference,
  DepegPrimaryTrustSchema,
  type PriceSourceConfidenceProfile,
  PriceSourceConfidenceProfileSchema,
  type PegAssetBase,
} from "./price";

export {
  type ReserveAdapterCoin,
} from "./stablecoin-meta-schemas";

export {
  BLUECHIP_GRADE_VALUES,
  type BluechipGrade,
  BluechipGradeSchema,
} from "./bluechip";
