import { undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_DIRECT_REDEMPTION_AT } from "./shared";

export const MSUSD_MAIN_STREET_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  accessModel: "whitelisted-onchain",
  settlementModel: "days",
  executionModel: "rules-based-nav",
  capacityModel: { kind: "supply-ratio", ratio: 0.2, confidence: "documented-bound", basis: "strategy-buffer" },
  costModel: undisclosedReviewedFee(),
  reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
  docs: [
    sourceRef("Main Street minting pathway", "https://mainstreet-finance.gitbook.io/mainstreet.finance/msusd-and-strategy-vaults/minting-pathway", ["route", "access"]),
    sourceRef("Main Street redemption process", "https://mainstreet-finance.gitbook.io/mainstreet.finance/msusd-and-strategy-vaults/redemption-process", ["route", "capacity", "settlement"]),
    sourceRef("Main Street website", "https://mainstreet.finance/", ["route"]),
  ],
  notes: [
    "Main Street documents 1:1 USDC redemption for verified users, but also documents dynamic capacity, a cooldown, asset conversion, and strategy unwinds before settlement.",
    "The reviewed 20% bound follows the documented concurrent-redemption capacity limit instead of assuming the full supply is immediately backed by segregated USDC.",
  ],
});
