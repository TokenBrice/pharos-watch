import { z } from "zod";

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
export const OracleRiskTierSchema = z.enum(ORACLE_RISK_TIER_VALUES);
