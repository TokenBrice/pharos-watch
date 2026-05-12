import { documentedBoundSupplyFull } from "../shared";

export const REVIEWED_DIRECT_REDEMPTION_AT = "2026-03-23";
export const REVIEWED_REMEDIATION_AT = "2026-03-30";
const REVIEWED_ISSUER_API_EXPANSION_AT = "2026-04-03";
export const REVIEWED_MAJOR_ISSUER_REDEMPTION_AT = "2026-04-16";
export const REVIEWED_NON_USD_BATCH_AT = "2026-05-05";
export const REVIEWED_COVERAGE_EXPANSION_AT = "2026-05-11";
export const REVIEWED_STABLECOIN_AUDIT_AT = "2026-05-12";

export const reviewedDirectRedemptionSupplyFull = documentedBoundSupplyFull(REVIEWED_DIRECT_REDEMPTION_AT);
export const reviewedIssuerApiExpansionSupplyFull = documentedBoundSupplyFull(REVIEWED_ISSUER_API_EXPANSION_AT);
