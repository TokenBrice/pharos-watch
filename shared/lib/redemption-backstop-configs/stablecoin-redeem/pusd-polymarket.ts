import {
  documentedBoundSupplyFull,
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_BATCH_AT } from "./shared";

export const PUSD_POLYMARKET_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
  outputAssetType: "stable-basket",
  costModel: undisclosedReviewedFee(
    "Polymarket docs describe PUSD as redeemable through Polymarket withdrawal rails into supported stablecoin balances; public docs reviewed do not publish a standalone fixed redemption fee",
  ),
  notes: [
    "Application-dollar wrapper around Polymarket deposit/withdrawal rails; modeled as a stable-basket route because exits depend on supported USDC/USDC.e withdrawal paths",
  ],
};
