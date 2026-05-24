import {
  documentedBoundSupplyFull,
  sourceRef,
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
  docs: [
    sourceRef("dForce USX stablecoin", "https://docs.dforce.network/ecosystem/usx-stablecoin", [
      "route",
      "capacity",
      "settlement",
    ]),
    sourceRef("dForce USX LSR", "https://docs.usx.finance/minting-and-redeeming/lsr", ["route", "capacity", "fees"]),
  ],
};
