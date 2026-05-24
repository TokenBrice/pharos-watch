import {
  documentedBoundSupplyFull,
  sourceRef,
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
  docs: [
    sourceRef("Solayer sUSD RFQ process", "https://docs.solayer.org/susd/decentralized-rfq-protocol/process", [
      "route",
      "capacity",
      "settlement",
    ]),
    sourceRef("Solayer sUSD eligibility", "https://docs.solayer.org/susd/protocol-info/eligibility%26risks", [
      "access",
    ]),
  ],
};
