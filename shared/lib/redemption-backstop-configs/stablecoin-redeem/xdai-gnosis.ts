import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  type RedemptionBackstopConfig,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_BATCH_AT } from "./shared";

export const XDAI_GNOSIS_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_BATCH_AT),
  costModel: documentedVariableFee(
    "Gnosis bridge docs describe xDAI/DAI bridge exits; public docs reviewed do not publish a separate fixed xDAI redemption fee",
  ),
  notes: [
    "Modeled as a bridge-backed stablecoin redemption route into DAI rather than an independent fiat issuer rail",
  ],
};
