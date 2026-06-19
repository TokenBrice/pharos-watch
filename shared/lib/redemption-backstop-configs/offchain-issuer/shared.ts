import { documentedBoundSupplyFull } from "../shared";
import { REVIEWED_FIRST_WAVE_AT, REVIEWED_MAY_BATCH_AT, REVIEWED_YIELD_COVERAGE_WAVE_AT } from "../review-dates";

// Re-exported from review-dates as a convenience barrel so per-coin files in
// this directory can import cross-cutting review dates from a single local import.
export {
  REVIEWED_DIRECT_REDEMPTION_AT,
  REVIEWED_REMEDIATION_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
  REVIEWED_FOLLOWUP_REMEDIATION_AT,
} from "../review-dates";
const REVIEWED_ISSUER_API_EXPANSION_AT = "2026-04-03";
export const REVIEWED_MAJOR_ISSUER_REDEMPTION_AT = "2026-04-16";
export const REVIEWED_NON_USD_BATCH_AT = REVIEWED_MAY_BATCH_AT;
export const REVIEWED_COVERAGE_EXPANSION_AT = REVIEWED_YIELD_COVERAGE_WAVE_AT;

export const reviewedDirectRedemptionSupplyFull = documentedBoundSupplyFull(REVIEWED_FIRST_WAVE_AT);
export const reviewedIssuerApiExpansionSupplyFull = documentedBoundSupplyFull(REVIEWED_ISSUER_API_EXPANSION_AT);
