import {
  documentedBoundSupplyFull,
  undisclosedReviewedFee,
  sourceRef,
  type RedemptionBackstopConfig,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_BATCH_AT } from "./shared";

export const XDAI_GNOSIS_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
  costModel: undisclosedReviewedFee(
    "Gnosis bridge docs describe xDAI/DAI bridge exits; public docs reviewed do not publish a separate fixed xDAI redemption fee",
  ),
  docs: [
    sourceRef("Gnosis xDAI bridge", "https://docs.gnosischain.com/bridges/About%20Token%20Bridges/xdai-bridge", [
      "route",
      "capacity",
      "settlement",
    ]),
  ],
  notes: [
    "Modeled as a bridge-backed stablecoin redemption route into DAI rather than an independent fiat issuer rail",
  ],
};
