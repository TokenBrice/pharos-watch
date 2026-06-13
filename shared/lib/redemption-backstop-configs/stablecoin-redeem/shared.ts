import { documentedBoundSupplyFull, stablecoinRedeemBase, type RedemptionBackstopConfig } from "../shared";
import { REVIEWED_FIRST_WAVE_AT } from "../review-dates";

export {
  REVIEWED_REMEDIATION_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
  REVIEWED_FOLLOWUP_REMEDIATION_AT,
} from "../review-dates";

/** Scaffold for the one-coin modules in this directory: applies the shared
 *  `stablecoinRedeemBase` defaults so each module only states its overrides. */
export function defineStablecoinRedeemConfig(overrides: Partial<RedemptionBackstopConfig>): RedemptionBackstopConfig {
  return { ...stablecoinRedeemBase, ...overrides };
}

export const REVIEWED_DIRECT_REDEMPTION_AT = REVIEWED_FIRST_WAVE_AT;
export const REVIEWED_ZCHF_BRIDGE_AT = "2026-05-25";
export const REVIEWED_WRAPPER_REDEMPTION_AT = "2026-04-21";
export const REVIEWED_STABLECOIN_BATCH_AT = "2026-05-05";
export const REVIEWED_YIELD_EXPANSION_AT = "2026-05-11";
export const REVIEWED_FXSAVE_LIVE_REDEMPTION_AT = "2026-05-27";

export const reviewedDirectRedemptionSupplyFull = documentedBoundSupplyFull(
  REVIEWED_DIRECT_REDEMPTION_AT,
);
