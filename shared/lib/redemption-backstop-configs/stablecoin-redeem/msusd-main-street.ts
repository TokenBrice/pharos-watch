import {
  documentedVariableFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { reviewedDirectRedemptionSupplyFull } from "./shared";

export const MSUSD_MAIN_STREET_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...reviewedDirectRedemptionSupplyFull,
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  docs: [
    sourceRef("Main Street docs", "https://mainstreet-finance.gitbook.io/mainstreet.finance/", ["route", "capacity"]),
    sourceRef("Main Street website", "https://mainstreet.finance/", ["route"]),
  ],
  notes: [
    "Tracked metadata describes direct 1:1 USDC redemption with msUSD held fully against USDC reserves, while yield generation sits in the separate msY staking layer",
  ],
};
