import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const STCUSD_CAP_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee("stcUSD withdraws to cUSD at the live vault exchange rate; public docs reviewed do not publish a separate fixed stcUSD redemption fee"),
  docs: [
    sourceRef("Cap stcUSD mechanics", "https://docs.cap.app/protocol-overview/stcusd-mechanics", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Cap cUSD mechanics", "https://docs.cap.app/protocol-overview/cusd-mechanics", ["route", "capacity"]),
    sourceRef("Cap vault", "https://docs.cap.app/concepts/vault", ["route", "capacity", "fees"]),
  ],
  notes: [
    "stcUSD is modeled as the wrapper exit into cUSD; final cUSD par exit inherits Cap's proportional reserve-basket redemption route.",
  ],
};
