import { undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, reviewedDirectRedemptionSupplyFull } from "./shared";

export const MSUSD_MAIN_STREET_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...reviewedDirectRedemptionSupplyFull,
  costModel: undisclosedReviewedFee(),
  docs: [
    sourceRef("Main Street docs", "https://mainstreet-finance.gitbook.io/mainstreet.finance/", ["route", "capacity"]),
    sourceRef("Main Street website", "https://mainstreet.finance/", ["route"]),
  ],
  notes: [
    "Tracked metadata describes direct 1:1 USDC redemption with msUSD held fully against USDC reserves, while yield generation sits in the separate msY staking layer",
  ],
});
