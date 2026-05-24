import {
  documentedBoundSupplyFull,
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_BATCH_AT } from "./shared";

export const USX_DFORCE_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
  outputAssetType: "stable-basket",
  costModel: undisclosedReviewedFee(
    "dForce docs describe USX mint and redemption through supported collateral/stablecoin routes; public docs reviewed do not publish a single fixed redemption fee",
  ),
};
