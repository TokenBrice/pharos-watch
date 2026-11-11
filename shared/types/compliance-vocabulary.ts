export const MICA_STATUS_VALUES = ["authorized", "pending", "transitional", "non-compliant", "out-of-scope"] as const;
export type MicaStatus = (typeof MICA_STATUS_VALUES)[number];

export const MICA_TOKEN_TYPE_VALUES = ["EMT", "ART"] as const;
export type MicaTokenType = (typeof MICA_TOKEN_TYPE_VALUES)[number];

export const MICA_AUTHORIZATION_TYPE_VALUES = ["emi", "credit-institution"] as const;
export type MicaAuthorizationType = (typeof MICA_AUTHORIZATION_TYPE_VALUES)[number];

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
