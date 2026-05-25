import { documentedBoundSupplyFull } from "../shared";

export const REVIEWED_DIRECT_REDEMPTION_AT = "2026-03-23";
export const REVIEWED_REMEDIATION_AT = "2026-03-30";
export const REVIEWED_ZCHF_BRIDGE_AT = "2026-05-25";
export const REVIEWED_WRAPPER_REDEMPTION_AT = "2026-04-21";
export const REVIEWED_STABLECOIN_BATCH_AT = "2026-05-05";
export const REVIEWED_YIELD_EXPANSION_AT = "2026-05-11";
export const REVIEWED_STABLECOIN_AUDIT_AT = "2026-05-12";
export const REVIEWED_FOLLOWUP_REMEDIATION_AT = "2026-05-13";

export const reviewedDirectRedemptionSupplyFull = documentedBoundSupplyFull(
  REVIEWED_DIRECT_REDEMPTION_AT,
);
