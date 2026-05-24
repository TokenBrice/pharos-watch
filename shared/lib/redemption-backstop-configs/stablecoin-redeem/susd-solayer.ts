import {
  documentedBoundSupplyFull,
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_BATCH_AT } from "./shared";

export const SUSD_SOLAYER_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(
    "Solayer docs describe sUSD mint and redemption through protocol rails; public docs reviewed do not publish a fixed redemption fee",
  ),
};
